// Minimal GTFS-realtime (protobuf) reader.
// Reads only what a departure board needs: feed timestamp, and per trip the
// route, trip id and each stop's arrival/departure time. Everything else
// (vehicles, alerts, NYCT extensions) is skipped by wire type.

export type StopTime = { stop: string; arr: number; dep: number };
export type Trip = { id: string; route: string; stops: StopTime[] };
export type Feed = { ts: number; trips: Trip[] };

const text = new TextDecoder();

class Reader {
  b: Uint8Array;
  p: number;
  e: number;
  constructor(b: Uint8Array, p: number, e: number) {
    this.b = b;
    this.p = p;
    this.e = e;
  }
  more(): boolean {
    return this.p < this.e;
  }
  varint(): number {
    let r = 0;
    let m = 1;
    for (;;) {
      if (this.p >= this.e) throw new Error("truncated varint");
      const x = this.b[this.p++];
      r += (x & 0x7f) * m;
      if (x < 0x80) return r;
      m *= 128;
    }
  }
  len(): number {
    const n = this.varint();
    if (this.p + n > this.e) throw new Error("truncated field");
    return n;
  }
  sub(): Reader {
    const n = this.len();
    const r = new Reader(this.b, this.p, this.p + n);
    this.p += n;
    return r;
  }
  str(): string {
    const n = this.len();
    const s = text.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) {
      const n = this.len(); // read the length first: it advances p
      this.p += n;
    } else if (wire === 5) this.p += 4;
    else throw new Error("unsupported wire type " + wire);
    if (this.p > this.e) throw new Error("truncated field");
  }
}

// StopTimeEvent { 1: delay, 2: time, 3: uncertainty }
function eventTime(r: Reader): number {
  let t = 0;
  while (r.more()) {
    const tag = r.varint();
    if (tag >>> 3 === 2 && (tag & 7) === 0) t = r.varint();
    else r.skip(tag & 7);
  }
  return t;
}

// StopTimeUpdate { 1: stop_sequence, 2: arrival, 3: departure, 4: stop_id, ... }
function stopTime(r: Reader): StopTime {
  const s: StopTime = { stop: "", arr: 0, dep: 0 };
  while (r.more()) {
    const tag = r.varint();
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 2 && w === 2) s.arr = eventTime(r.sub());
    else if (f === 3 && w === 2) s.dep = eventTime(r.sub());
    else if (f === 4 && w === 2) s.stop = r.str();
    else r.skip(w);
  }
  return s;
}

// TripDescriptor { 1: trip_id, 2: start_time, 3: start_date, 5: route_id, ... }
function tripDescriptor(r: Reader, t: Trip): void {
  while (r.more()) {
    const tag = r.varint();
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) t.id = r.str();
    else if (f === 5 && w === 2) t.route = r.str();
    else r.skip(w);
  }
}

// TripUpdate { 1: trip, 2: stop_time_update (repeated), ... }
function tripUpdate(r: Reader): Trip {
  const t: Trip = { id: "", route: "", stops: [] };
  while (r.more()) {
    const tag = r.varint();
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) tripDescriptor(r.sub(), t);
    else if (f === 2 && w === 2) t.stops.push(stopTime(r.sub()));
    else r.skip(w);
  }
  return t;
}

// FeedEntity { 1: id, 2: is_deleted, 3: trip_update, 4: vehicle, 5: alert }
function entity(r: Reader): Trip | null {
  let t: Trip | null = null;
  while (r.more()) {
    const tag = r.varint();
    if (tag >>> 3 === 3 && (tag & 7) === 2) t = tripUpdate(r.sub());
    else r.skip(tag & 7);
  }
  return t;
}

// FeedHeader { 1: version, 2: incrementality, 3: timestamp }
function headerTime(r: Reader): number {
  let ts = 0;
  while (r.more()) {
    const tag = r.varint();
    if (tag >>> 3 === 3 && (tag & 7) === 0) ts = r.varint();
    else r.skip(tag & 7);
  }
  return ts;
}

// FeedMessage { 1: header, 2: entity (repeated) }
export function decodeFeed(buf: Uint8Array): Feed {
  const r = new Reader(buf, 0, buf.length);
  const feed: Feed = { ts: 0, trips: [] };
  while (r.more()) {
    const tag = r.varint();
    const f = tag >>> 3;
    const w = tag & 7;
    if (f === 1 && w === 2) feed.ts = headerTime(r.sub());
    else if (f === 2 && w === 2) {
      const t = entity(r.sub());
      if (t && t.stops.length) feed.trips.push(t);
    } else r.skip(w);
  }
  return feed;
}
