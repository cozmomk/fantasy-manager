# Yahoo Fantasy Manager

A read-only helper for any Yahoo Fantasy Football league you belong to. It adds a slide-out tray to Yahoo's own pages
with waiver comparisons, start/sit suggestions, injured-player stash tracking and daily trends. It never adds, drops
or submits anything on Yahoo.

- **Judges players on consistent scoring** (last 4 weeks, weighted to the last 2) and add/start momentum, not one-week projections.
- **Never recommends injured or out players**, and protects proven players from being dropped for a mild edge.
- **Polite to Yahoo:** one request at a time, spaced out, a 20-minute pause on any "Request denied", and a shared cache.
- **Tells you when Yahoo's layout changes** instead of guessing on bad data.

Data comes from Yahoo's own pages (your logged-in session) and Sleeper's public API.

## Install (Tampermonkey or Violentmonkey)

```
npm install
npm run serve
```

Open `http://localhost:8787/fantasy-manager.user.js` in Chrome and install it. Keep `npm run serve` running and the
manager picks up changes by itself. Refresh the Yahoo tab after an update. Details are in [extension/README.md](extension/README.md).

The same code also loads as an unpacked Chrome extension from `extension/`.

## Develop

```
npm run check      # lint + the offline test suite (Playwright with mocked Yahoo and Sleeper pages)
```

Tests never touch Yahoo. League IDs and team numbers are set at the top of `extension/content.js`.
