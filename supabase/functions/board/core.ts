// Subway departure board API.
//
//   GET ?lat=40.75&lon=-73.98&n=5      nearest stations with upcoming departures
//   GET ?ids=609,611&lat=..&lon=..     specific stations first, then the nearest
//   GET ?list=1                        every station (for search)
//
// Data: MTA GTFS-realtime subway feeds (decoded in gtfs.ts) and the MTA's open
// "Subway Stations" dataset for names, coordinates and direction labels.

import { decodeFeed, type Feed } from "./gtfs.ts";

const MTA = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs";
export const FEEDS: Record<string, { url: string; lines: string }> = {
  irt: { url: MTA, lines: "1 2 3 4 5 6 7 S" },
  ace: { url: MTA + "-ace", lines: "A C E" },
  bdfm: { url: MTA + "-bdfm", lines: "B D F M" },
  g: { url: MTA + "-g", lines: "G" },
  jz: { url: MTA + "-jz", lines: "J Z" },
  nqrw: { url: MTA + "-nqrw", lines: "N Q R W" },
  l: { url: MTA + "-l", lines: "L" },
  si: { url: MTA + "-si", lines: "SIR" },
};

const STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json?$limit=2000" +
  "&$select=gtfs_stop_id,complex_id,stop_name,daytime_routes,gtfs_latitude,gtfs_longitude," +
  "north_direction_label,south_direction_label,borough";

const FEED_TTL_MS = 12_000; // refetch feeds at most this often
const FEED_MAX_AGE_S = 300; // drop a feed we have not managed to refresh for this long
const STATIONS_TTL_MS = 24 * 3600_000;
const HORIZON_S = 75 * 60; // ignore departures further out than this
const PER_GROUP = 4; // departures kept per route + direction
const ROUTE_ORDER = "1 2 3 4 5 6 7 A C E B D F M G J Z L N Q R W S SIR".split(" ");

type Stop = { id: string; cx: string; name: string; routes: string[]; lat: number; lon: number; n: string; s: string };
type Complex = { id: string; names: string[]; routes: string[]; lat: number; lon: number; boro: string; stops: Stop[] };
type Dep = { r: string; x: boolean; d: string; t: number; to: string; feed: string };

let stops = new Map<string, Stop>();
let complexes: Complex[] = [];
let complexById = new Map<string, Complex>();
let stationsAt = 0;
let stationsLoading: Promise<void> | null = null;

const lastGood = new Map<string, { feed: Feed; at: number }>();
let index = new Map<string, Dep[]>();
let feedsAt = 0;
let feedsLoading: Promise<void> | null = null;

function routeRank(r: string): number {
  const i = ROUTE_ORDER.indexOf(r);
  return i < 0 ? 99 : i;
}

function clean(s: unknown): string {
  const v = typeof s === "string" ? s.trim() : "";
  return v === "NaN" ? "" : v;
}

export function buildStations(rows: Record<string, string>[]): void {
  const s = new Map<string, Stop>();
  const byCx = new Map<string, Stop[]>();
  for (const row of rows) {
    const id = clean(row.gtfs_stop_id);
    const lat = Number(row.gtfs_latitude);
    const lon = Number(row.gtfs_longitude);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const stop: Stop = {
      id,
      cx: clean(row.complex_id) || id,
      name: clean(row.stop_name) || id,
      routes: clean(row.daytime_routes).split(/\s+/).filter(Boolean),
      lat,
      lon,
      n: clean(row.north_direction_label),
      s: clean(row.south_direction_label),
    };
    s.set(id, stop);
    const list = byCx.get(stop.cx);
    if (list) list.push(stop);
    else byCx.set(stop.cx, [stop]);
  }
  if (s.size < 100) throw new Error("station list looks incomplete (" + s.size + " rows)");
  const boroOf = new Map(rows.map((r) => [clean(r.gtfs_stop_id), clean(r.borough)]));
  const cxs: Complex[] = [];
  for (const [id, list] of byCx) {
    // Name a complex after the platform group serving the most routes.
    const weight = new Map<string, number>();
    for (const st of list) weight.set(st.name, (weight.get(st.name) ?? 0) + st.routes.length + 0.01);
    const names = [...weight.keys()].sort((a, b) => weight.get(b)! - weight.get(a)!);
    const routes = [...new Set(list.flatMap((st) => st.routes))].sort((a, b) => routeRank(a) - routeRank(b));
    cxs.push({
      id,
      names,
      routes,
      lat: list.reduce((a, st) => a + st.lat, 0) / list.length,
      lon: list.reduce((a, st) => a + st.lon, 0) / list.length,
      boro: boroOf.get(list[0].id) ?? "",
      stops: list,
    });
  }
  stops = s;
  complexes = cxs;
  complexById = new Map(cxs.map((c) => [c.id, c]));
  stationsAt = Date.now();
}

async function fetchStations(): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(STATIONS_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error("station list HTTP " + res.status);
      buildStations(await res.json());
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function ensureStations(): Promise<void> {
  const fresh = Date.now() - stationsAt < STATIONS_TTL_MS;
  if (stops.size && fresh) return;
  if (!stationsLoading) {
    stationsLoading = fetchStations().finally(() => {
      stationsLoading = null;
    });
  }
  // Keep serving from a previous copy if a refresh fails.
  if (stops.size) await stationsLoading.catch(() => {});
  else await stationsLoading;
}

// MTA route ids: "7X"/"6X" are express variants, GS/FS/H are shuttles, SI is the Staten Island Railway.
export function routeLabel(id: string): { r: string; x: boolean } {
  if (id === "GS" || id === "FS" || id === "H") return { r: "S", x: false };
  if (id === "SI" || id === "SS") return { r: "SIR", x: false };
  if (id.length === 2 && id.endsWith("X")) return { r: id[0], x: true };
  return { r: id, x: false };
}

function splitStopId(id: string): { parent: string; dir: string } {
  const last = id.slice(-1);
  if (last === "N" || last === "S") return { parent: id.slice(0, -1), dir: last };
  return { parent: id, dir: "" };
}

export function buildIndex(nowS: number): void {
  const idx = new Map<string, Dep[]>();
  for (const [key, got] of lastGood) {
    if (nowS - got.at / 1000 > FEED_MAX_AGE_S) continue;
    for (const trip of got.feed.trips) {
      const n = trip.stops.length;
      const dest = splitStopId(trip.stops[n - 1].stop).parent;
      const { r, x } = routeLabel(trip.route);
      for (let i = 0; i < n - 1; i++) { // the last stop is where the train terminates
        const st = trip.stops[i];
        const t = st.dep || st.arr;
        if (!t || t < nowS - 30 || t > nowS + HORIZON_S) continue;
        const { parent, dir } = splitStopId(st.stop);
        const dep: Dep = { r, x, d: dir, t, to: dest, feed: key };
        const list = idx.get(parent);
        if (list) list.push(dep);
        else idx.set(parent, [dep]);
      }
    }
  }
  index = idx;
}

async function fetchFeeds(): Promise<void> {
  await Promise.all(
    Object.entries(FEEDS).map(async ([key, f]) => {
      try {
        const res = await fetch(f.url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const feed = decodeFeed(new Uint8Array(await res.arrayBuffer()));
        if (!feed.ts) throw new Error("no feed timestamp");
        lastGood.set(key, { feed, at: Date.now() });
      } catch (e) {
        console.warn("feed " + key + " failed: " + (e instanceof Error ? e.message : e));
      }
    }),
  );
  buildIndex(Math.floor(Date.now() / 1000));
  feedsAt = Date.now();
}

async function ensureFeeds(): Promise<void> {
  if (Date.now() - feedsAt < FEED_TTL_MS) return;
  if (!feedsLoading) {
    feedsLoading = fetchFeeds().finally(() => {
      feedsLoading = null;
    });
  }
  await feedsLoading;
}

function meters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function distanceTo(c: Complex, lat: number, lon: number): number {
  let best = Infinity;
  for (const st of c.stops) best = Math.min(best, meters(lat, lon, st.lat, st.lon));
  return best;
}

function departures(c: Complex, nowS: number) {
  const all: (Dep & { h: string })[] = [];
  for (const st of c.stops) {
    for (const dep of index.get(st.id) ?? []) {
      if (dep.t < nowS - 30) continue;
      all.push({ ...dep, h: dep.d === "N" ? st.n : dep.d === "S" ? st.s : "" });
    }
  }
  all.sort((a, b) => a.t - b.t);
  const seen = new Map<string, number>();
  const out = [];
  for (const dep of all) {
    const group = dep.r + "|" + dep.d + "|" + dep.h;
    const k = seen.get(group) ?? 0;
    if (k >= PER_GROUP) continue;
    seen.set(group, k + 1);
    out.push({
      r: dep.r,
      x: dep.x ? 1 : 0,
      d: dep.d,
      h: dep.h,
      to: stops.get(dep.to)?.name ?? "",
      t: dep.t,
    });
  }
  return out;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, cache = "no-store"): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache },
  });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const q = new URL(req.url).searchParams;

  try {
    await ensureStations();
  } catch (e) {
    console.error("stations failed: " + (e instanceof Error ? e.message : e));
    return json({ error: "stations_unavailable", message: "Could not load the station list. Try again in a moment." }, 503);
  }

  if (q.has("list")) {
    const list = complexes
      .map((c) => ({ id: c.id, names: c.names, routes: c.routes, boro: c.boro, lat: +c.lat.toFixed(5), lon: +c.lon.toFixed(5) }))
      .sort((a, b) => a.names[0].localeCompare(b.names[0]));
    return json({ stations: list }, 200, "public, max-age=3600");
  }

  const lat = Number(q.get("lat"));
  const lon = Number(q.get("lon"));
  const hasPos = q.has("lat") && q.has("lon") && Number.isFinite(lat) && Number.isFinite(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const ids = (q.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (!hasPos && !ids.length) {
    return json({ error: "bad_request", message: "Pass lat and lon, or ids." }, 400);
  }
  const n = Math.min(Math.max(Math.floor(Number(q.get("n") ?? 5)) || 5, 0), 12);

  const picked: { c: Complex; pin: boolean; dist: number | null }[] = [];
  for (const id of ids) {
    const c = complexById.get(id);
    if (c) picked.push({ c, pin: true, dist: hasPos ? distanceTo(c, lat, lon) : null });
  }
  if (hasPos) {
    const near = complexes
      .filter((c) => !picked.some((p) => p.c === c))
      .map((c) => ({ c, pin: false, dist: distanceTo(c, lat, lon) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, n);
    picked.push(...near);
  }

  await ensureFeeds();
  const nowS = Math.floor(Date.now() / 1000);
  const feeds = Object.keys(FEEDS).map((key) => {
    const got = lastGood.get(key);
    const fresh = !!got && nowS - got.at / 1000 <= FEED_MAX_AGE_S;
    return { key, lines: FEEDS[key].lines, ok: fresh, ts: fresh ? got!.feed.ts : 0 };
  });

  return json({
    now: nowS,
    nowMs: Date.now(),
    feeds,
    stations: picked.map(({ c, pin, dist }) => ({
      id: c.id,
      names: c.names,
      routes: c.routes,
      boro: c.boro,
      pin,
      dist: dist === null ? null : Math.round(dist),
      deps: departures(c, nowS),
    })),
  });
}
