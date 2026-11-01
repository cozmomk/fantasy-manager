# Yahoo Fantasy Manager

A read-only helper for Yahoo Fantasy Football, shipped as a Tampermonkey userscript. The source is
`extension/content.js`. `extension/README.md` explains the features and the rules behind each verdict.

## Rules that protect the Yahoo account

These apply to every change, and to any testing on the live site.

- **Read-only.** Never add code that adds, drops, trades, submits or changes lineups, and never click those controls on
  Yahoo. The tool advises; the person makes every move themselves.
- **All Yahoo requests go through `yfetch`.** It sends one request at a time, spaces them out and pauses for 20 minutes
  after a 403 or 429. Do not bypass it, shorten the gap or add parallel requests.
- **Cache before fetching.** New Yahoo reads should reuse the existing caches and fetch as little as possible.
- **No Yahoo API scraping tools, bots, background polling or scheduled runs.** Requests happen only while the person has
  a Yahoo page open.
- **Live checks:** use a new browser tab of your own and close it afterward. Do not touch tabs the person is using.
  Load pages and read them. Nothing else.

## Working here

- `npm run check` runs lint and the offline tests (about a minute or two). Run it before saying a change is done.
- `npm run serve` serves the script at `http://localhost:8787/fantasy-manager.user.js`, which Tampermonkey updates from.
- Tests mock Yahoo in `tests/fixtures.js`, built from real page structure. Check the real page before relying on a new
  Yahoo selector, then add a fixture player and a test for any new rule.
- Text from Yahoo pages must never run as code: build the page with `el()` and text nodes.
- Commit or push only when asked.
- The README's localhost trust note applies: turn off auto-update when `npm run serve` is not running.
