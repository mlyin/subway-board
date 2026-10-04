# subway-board

Live NYC subway departures for the stations nearest you, counted down to the second.
A single web page meant to be added to an iPhone Home Screen.

**Open it:** https://mlyin.github.io/subway-board/

## How it works

- `index.html` is the whole app. It asks for your location, loads the nearest
  stations, and ticks each departure down every second. Data refreshes every 15 seconds.
- `supabase/functions/board/` is a Supabase Edge Function. It downloads the MTA's
  GTFS-realtime subway feeds, decodes them (`gtfs.ts`), and returns a small JSON
  answer for the stations near a point (`core.ts`). Station names, coordinates and
  direction labels come from the MTA's open "Subway Stations" dataset on data.ny.gov.

```
GET /functions/v1/board?lat=40.7538&lon=-73.9820&n=5   nearest stations + departures
GET /functions/v1/board?ids=609&lat=..&lon=..          a chosen station first
GET /functions/v1/board?list=1                         every station, for search
```

Requests need the project's public anon key as a bearer token (it is in `index.html`).

## Updating

- Page: edit `index.html`, then `git push origin main main:gh-pages`. GitHub Pages
  serves the `gh-pages` branch and redeploys in about a minute.
- Function: redeploy `supabase/functions/board` to the `subway-board` Supabase
  project (`supabase functions deploy board`).

Times are MTA estimates. Not affiliated with the MTA.
