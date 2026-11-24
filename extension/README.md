# Fantasy Manager: decision board (Chrome extension)

Helps you decide who to add and who to replace, using scoring track record, momentum, news and role.
Read-only: it adds a board to the Yahoo page and reads other Yahoo views and Sleeper's public data with plain
GET requests using your existing login. It never clicks, adds, drops or submits anything.

## Install

The usual way is the Tampermonkey userscript: see [Install in the main README](../README.md#install). To load this
folder as an unpacked Chrome extension instead:
1. Open `chrome://extensions` in Chrome and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `extension/` folder.
3. Open your team page (or any **Players** list) in a Yahoo league you belong to. The tray slides in from the right.

After you edit `content.js`, click the reload arrow on the extension card, then refresh the Yahoo page. Use either the
userscript or the unpacked extension, not both. Switching from the userscript: the extension's first run copies what the
userscript saved (daily snapshots, advice history, dismissed alerts) into extension storage, once, without overwriting
anything the extension already saved. Then disable the userscript.

## The board (three steps, top to bottom)
1. **Your roster.** Every player with slot, bye, a 4-week bar chart (green = a good game for that position), and
   chips: KEEP (proven), OUT / OUT THIS WEEK (injury), WEAKEST BENCH (the suggested cut). Click anyone to make
   them the player you would replace. If one of your players is listed out and an IR slot is open, a "Compare
   using IR slot" button offers a free add.
2. **Best available.** Buttons for QB, RB, WR, TE, K and DEF sit above the list: click one to scan that position (about 30
   seconds the first time, then cached). The tray starts on whatever position Yahoo's list shows, but you never need
   to touch Yahoo's own filter. Ranked by actual scoring, then Yahoo and Sleeper momentum; injured players sink to
   the bottom. Click a row to compare him.
3. **Comparison.** A verdict banner (ADD/DROP, KEEP, DON'T ADD, WAIT, or ADD FOR FREE with IR) and a side-by-side
   table. Each row is marked on the side it favors: scoring record, last 2 weeks, momentum, role on his team,
   health and news (with the latest Yahoo note text), draft pedigree, bye week.

## How the verdict is decided
Weighted checks: record 3, health 3, last 2 weeks 2, momentum 2, role 2, pedigree 1, bye 1. A swap is
recommended at score 3 or more. If the player you would drop is a starter or has a track record (good games in
60%+ of recent weeks, or drafted early), the bar is 6, so a mild edge never costs you a proven player.
A long-term injury to the candidate is an automatic "don't add".

"Good game" thresholds (non-PPR): QB 16, RB 8, WR 8, TE 6, K 7, DEF 6. Leagues that score receptions use higher RB, WR and TE thresholds (see Setup notes).

## Data sources
- Yahoo: weekly points, add/start trends, depth chart, draft position, player notes, your roster and slots.
- Sleeper (public API, credit Sleeper): adds and drops in the last 24h and 7 days, and its own injury label.
  The player list is cached about a day, trending 15 minutes. Wire players trending on Sleeper are pulled in too.
- Injury handling: Yahoo's O/IR/NA tag, Sleeper's status, and the lead sentence of the latest note (only if it
  names the player) all feed one "out" level.

## Setup notes
- It works in any Yahoo league you are in. Your team comes from Yahoo's "My Team" link; with no such link it does nothing.
- The league name, playoff start, passing TD and reception points, and slots are read from the league's settings,
  remembered and re-read weekly. Opening the league's **Settings** page reads them straight away.
- Superflex (Q/W/R/T) slots count: a second QB is treated as a starter. Slots it cannot read, such as defensive players, are named on the Lineup tab.
- RB, WR and TE "good game" thresholds rise with points per reception: RB +2, WR +4 and TE +2 per point. Half-PPR gives RB 9, WR 10, TE 7. The QB threshold rises by 2 per extra passing TD point, so 6-point leagues use 20.
- Fetched Yahoo views and notes are cached for 30 minutes, shared across tabs. Your own players' finished weeks are kept
  for the season once Yahoo's stat corrections are in (the Friday after the week), and Yahoo's trending lists for the
  rest of the day.
- On your team page the board is drawn at once from the numbers saved last time, with the line "Saved numbers from
  9:05 am. Fresh ones are loading", then redrawn when fresh numbers arrive. Wait for that line to go before you act.
  It makes no requests: if a page was never saved, the board simply waits for fresh numbers.

## Limits
- It reads text, not meaning: always read the note it shows before spending priority.
- Roster-wide comparisons need your team page to load; "Show my team" is no longer needed.
- Trend data (add/start change) covers only the first pages of Yahoo's research view, so some players show "n/a".
- "lo" in a bar means the player did not rank in the top 25 at his position that week (or was on a bye).
- A player's note can be one week stale; Sleeper's label is a second opinion, not a verdict.

## Stash watch tab
Injured, available players across QB/RB/WR/TE ranked by production before the injury. A return week is read from
each player's note (ranges like "12-16 weeks" or "3-to-4 months", week-to-week, a bare IR placement = at least
4 games, out for the season) and checked against your league's playoff start. Verdicts: STASH, RISKY, CHECK (no date in the note) or SKIP (too late or low output).
It also says whether the stash costs nothing (open IR slot) or a bench player.

## Trends tab and daily snapshots
- Once a day per league, when you open a Yahoo page, a snapshot is saved to extension storage (60 days, about
  25 KB a day): your roster, the top wire players at each position with their % rostered, the league's
  transaction feed, and Sleeper's top adds and drops. It costs about 6 Yahoo requests, paced and cached.
- The **Trends** tab shows league activity (most added and dropped players, most active managers), wire movers
  (change in % rostered since your first snapshot this week) and players in Sleeper's top adds several days
  running. Movers and streaks need at least 2 days of snapshots.
- **Download JSON** exports every snapshot for the league. **Take snapshot now** forces one if today's is missing.

## Being polite to Yahoo
All Yahoo requests go through one queue (one at a time, about 0.8 s apart). If Yahoo answers 403 or 429, the
extension stops requesting for 20 minutes, across tabs. Results are cached 30 minutes in shared storage. The
status line shows how many Yahoo requests the page has made.

Request budget for a first, uncached load of one list: about 6 for your roster, about 17 for the wire radar, and
about 5 for the daily snapshot, so roughly 30 in all (it was 53 before player notes became on-demand). Player notes
are the expensive part, so they are fetched only for players with an injury flag, the best few wire candidates, and
the two players you are comparing (loaded when you pick them). The Stash tab uses about 4 list pages plus notes for
its 6 most productive candidates; the rest load when clicked. A repeat load within 30 minutes costs close to nothing. If a page ever shows "Request denied", stop and
wait before reloading.

## Testing without touching Yahoo
Run from the project folder (needs Google Chrome installed):

    npm run check      # ESLint on the extension, tests and scripts, then the whole offline suite
    npm run lint       # lint only
    npm test           # tests only (about 2 minutes)

The tests (`tests/`) open real Chrome with Playwright, load the real `extension/content.js`, and answer every
network call from an offline stand-in for Yahoo and Sleeper (`tests/fixtures.js`). No request ever leaves the
machine, so there is no risk of a Yahoo block. They cover: the request budget and one-at-a-time pacing, the
20-minute pause after a 403, the shared cache, a second copy of the script doing nothing, the tray and position
buttons, every verdict rule (long-term injuries, depth-only adds, bye cover, kickers, protected starters),
stash watch, the open-IR-slot path, daily snapshots, trends, and that names from the page can never run as code.
Add a fixture player and a test whenever you change a rule. Deliberately breaking the pause logic or the
proven-starter rule makes the matching test fail, so the suite is checking real behavior.

Only the structure of Yahoo's pages is mocked, from what was observed on the real site. If Yahoo changes its
markup, the offline tests will still pass while the live page breaks, so a single careful live check after any
big Yahoo redesign is still worth doing.

## Free adds and dropped players

- **Open roster spots.** An empty bench slot (counted from the league's roster settings) is called out on the Lineup tab, the roster and every comparison: you can add a player without dropping anyone.
- **Just dropped.** The daily snapshot checks players dropped in your league in the last 4 days (up to 4 player cards, one request each). Anyone still unclaimed and at least 70% rostered across Yahoo shows in a banner above the tabs.
- **Kickers and defenses** are ranked by Yahoo's projection for this week, then by recent scoring, and the comparison weighs that projection. Recent scoring alone says little about a matchup-driven position.
- **"Last 2" text** names a bye or a missed game inside the window ("last game 3.8 (missed wk 8)") instead of reading like a slump.
- **Team page speed.** Your roster is read from the page you are on, and kicker and defense history loads after the lineup appears. Requests stay one at a time and spaced out.

## If Yahoo changes its pages

On every load the extension checks that each page it reads still has the expected structure (list columns, your team tables, player notes, transactions). A red banner at the top of the tray means a critical check failed: the board stops recommending and says what changed. A yellow banner means a non-critical source (notes, transactions, Sleeper) could not be read. Offline tests for each case are in `tests/drift.test.js`.

## Auto-updating with Tampermonkey or Violentmonkey (alternative to loading the folder)

```
npm run serve
```

Then open `http://localhost:8787/fantasy-manager.user.js` in Chrome and click Install in the userscript manager. Keep `npm run serve` running while you work: the manager checks that address for a higher `@version` and updates itself (in the manager's settings, shorten "check for updates"; or click "check for updates"). Refresh the Yahoo tab after an update. Remove the loaded-folder extension so only one copy runs. `npm run userscript` just writes `dist/fantasy-manager.user.js` if you want to host the file elsewhere (change the `@updateURL`/`@downloadURL` lines to that address).

## Lineup tab (start / sit)

On the league home page, your team page and the matchup page the tray opens on **Lineup**: starters who are out or on bye this week, the best healthy bench player for each slot, and clear upgrades (a bench player must beat a starter by 15% and 2 points; a proven starter needs more). It uses consistent scoring (last 4 weeks, weighted to the last 2) blended with usage (see "Usage counts in the score" below), not one-week projections. Opponents only add the odds line and close-call options described under "Playoff push". Kickers and defenses are the exception: they swing with the matchup, so start/sit for them goes by Yahoo's projection for the week, and a bench kicker or defense must be projected 1.5 points higher to swap in. The script now matches all `/f1/*` pages but only acts on player lists, settings, the league home page, your own team, the matchup, Yahoo's add page and Yahoo's Transaction Trends page. On Transaction Trends (`buzzindex`) the tray opens on **Trends**. That page shows no week number, so the tray uses the week it last read in this league, moved on by the weeks since. On Yahoo's add page for a player (`addplayer?apid=...`) the tray opens on **Add / replace** with that player already compared against the roster player you would most likely drop, and the best available list for his position above it. It reads his weeks from the same list pages the wire scan uses, so it usually costs no extra requests, and it never touches Yahoo's drop checkboxes or Add button. At M and L widths the lineup table also shows Yahoo's projection (for reference only), the game and, at L, % started.

## Game day on the Lineup tab

The Lineup tab is laid out in a fixed order: the verdict, **Do now** (fixes and swaps to make in Yahoo), **Before
kickoff** (a plan for each questionable starter), **Optional** (flex order, IR, open roster spot), then your lineup.
The rules sit behind "How this is judged" at the bottom.

- **Next deadline.** Under the verdict (and in the tray's summary line): "Next: decide Pickens by Sun 1:05 pm", or
  "Nothing to decide", with the time the advice was drawn.
- **Players whose game has started are never moved.** A game line that is not a scheduled kickoff or a bye counts as
  started: the lineup table says "Played" (Final), "Playing" (a score) or "Locked: check Yahoo" (anything else, such as
  a postponed game). Returning to an open tab after a kickoff redraws it, keeping your place.
- **Flex order.** When your flex holds an early game and a same-position starter plays later, the tab suggests swapping
  their slots: it costs nothing and keeps the flex open longer, so a late scratch can be covered by any eligible player.
- **Questionable starters.** One row each, earliest kickoff first: the backup to start if he sits (never one already
  starting or promised to another row), the last moment you can act (when he or his backup kicks off), when you'll know
  (inactives, 90 minutes before his kickoff), and the latest practice sentence from his note. If the backup plays before
  the inactives come out, it says you must decide before you know. A deadline that has passed is greyed out.
- **When Yahoo expects a questionable player to sit.** A questionable player Yahoo projects under a quarter of his recent
  average is never started from the bench or named as a backup, and his row says Yahoo expects him to sit. Recent
  scoring cannot see that, so this is the one place the offense rules defer to Yahoo's projection.
- **A questionable starter in the flex stays there**, so any bench player of a flex position can still replace him;
  the flex-order tip never moves him out of it.
- Rows the advice changes are tagged in the lineup table ("→ RB", "→ bench"). At narrow widths the details fold
  behind "More" and players named in the advice show their kickoff time.
- Role news and "just dropped" alerts share one "Opportunities" line under the tabs; open it to read them.

All of this reads the team page and notes the board already loads. The one exception is the inactives check under
"Playoff push": on game day it re-reads a questionable starter's note.

## Claim plan and IR moves

Under the best-available list, the **Add / replace** tab shows a **Claim plan** for the position you are looking at:
one group per roster opening, each with a first choice, up to two alternates "if the claim above fails", who to drop
and when waivers clear. Openings are filled in this order: lineup holes this position can fill (any healthy free player
beats an empty slot), then an open bench spot, then the room an IR move makes ("after moving X to IR in Yahoo"), then
a drop, where a claim is listed only if it clearly beats the player dropped. No two groups share a player or a drop, so
following the plan never adds more players than you have room for. Nothing is submitted: make the claims in Yahoo.

On the Lineup tab, an injured player who can go to your open IR slot gets an Option row ("Move X to IR · opens 1
bench spot") even when no lineup hole needs filling. Yahoo's settings page does not list which tags a league allows on
IR, so the tool uses Yahoo's standard rule (Out, IR or NA, or a long-term injury). A Doubtful player is not eligible
yet: with an IR slot open, his status says so.

## Stash alerts and your other league

**Stash alert.** When the Stash watch check finds an injured free agent worth holding (a STASH verdict: productive
before the injury and back well before your playoffs) who is at least 70% rostered across Yahoo, he appears in the
"Opportunities" strip with his return estimate and waiver status. The check runs when you open the Stash watch tab,
and the daily snapshot repeats it once a day (4 list pages and up to 6 notes, paced like every other request). "Got it"
hides a player for good in that league.

**Your other league.** Each league's tray saves its Lineup verdict as it draws. The header of the tray then shows one
line per other league you belong to: its verdict, its next deadline and how old that is ("Sunday League: FIX YOUR LINEUP:
your RB slot is empty · 2h ago"), linking to that team page. Nothing is fetched for the other league; a line older than
a day turns red, and a league you have never opened is not shown.

## Defense matchups and Yahoo vs record

**Defense matchup.** For a defense, Yahoo's "Pts vs." column on the projected-week list is the points it is projected
to allow this week (its tooltip says "Points Allowed"), which is what its opponent is projected to score. Wire rows and
comparisons show it as "opponent projected to score 17.5 (easy matchup)": easy, average and tough are the lower,
middle and upper thirds of this week's free defenses. In a comparison it only breaks a tie: when two defenses are
projected within 1.5 points, an opponent projected to score at least 3 fewer points tips it, and the row says
"tiebreak: easier opponent". Kickers have no such column, so their comparison says the matchup is not available. Your
own defense's number costs one extra list page, loaded with your kicker and defense stats.

**Yahoo vs record.** When a fix or swap on the Lineup tab involves a player Yahoo projects at least 40% above or below
his recent average, the comparison table adds a "Yahoo vs record" row with both numbers ("Yahoo 18.0 vs his recent
average 5.0 (+260%)"). The advice still follows recent scoring for offense; the row just shows that Yahoo disagrees.

## Playoff push

Added 2026-11-16. Each extra Yahoo read below happens after the board is drawn, one after another through the same
paced queue, and the tray redraws once when they finish. If a page can't be read, its line is left out.

- **Room named in every add alert.** Stash alerts and role news end with where the player would go: "Room: open bench
  spot", "Room: move X to IR first", "Room: drop Shrader (your second kicker)" or "Room: no safe drop right now". A second
  kicker or defense counts as spare when you roster more than you can start and the other one is healthy and plays this
  week and next. It is never the drop when your starting one has his bye next week, and neither is the only cover for a
  QB or TE whose bye is next week.
- **Inactives confirmed.** Between a questionable starter's inactives time (90 minutes before his kickoff) and his
  kickoff, the tray re-reads his note at most every 15 minutes while you have it open. If the note says he is inactive or
  ruled out, his row becomes a Do now fix ("Pickens inactive (Yahoo note, Today, 11:41 am)") with his backup. If it says
  he is active, the row turns OK ("Active: keep him in") and stops being the next deadline. Otherwise it says when it last
  checked. Only a sentence about him counts ("X will play with Y ruled out" is not him), "not ruled out" is not out, and
  a note from before this week's Tuesday counts for nothing; "active" needs a note from today.
- **Streaming kicker and defense.** Once your own kicker and defense have played this week, the tray reads next week's
  projections (4 list pages, cached 30 minutes). If a free one projects at least 3 points more than yours, is not on bye
  and is not already in a pending claim, an Option row says "Next week: stream Bills DEF (8.9 projected, easy matchup)
  for Ravens (4.1). Waivers clear Nov 18." Within 5 weeks of your playoffs it also compares the two in your first playoff
  week and says which to hold (2 more pages, cached 12 hours). Next week's matchup labels never change this week's.
- **This week's odds and close calls.** The matchup page gives Yahoo's own win probability. Thursday to Monday, a line
  under the verdict says "vs Rival Squad (6-3): Yahoo gives you 35%" (one page, cached 30 minutes; none when you are on
  the matchup page). Below 40% or above 60%, close calls (a bench player within 10% of a starter on the score) become
  Option rows phrased as questions: an underdog gets "Underdog: start X over Y? Higher best game lately", a favorite gets
  "Favorite: start X over Y? Steadier week to week". They never change the verdict or Do now.
- **Usage counts in the score.** For running backs, receivers and tight ends, the start score is 60% recent points and
  40% usage: carries plus targets per game (same 4-week, last-2-weighted average), times what an opportunity is worth at
  his position. That value comes from every weekly row the board has read once 200 opportunities are in, and from the
  league's points per reception before that. The Add tab's "Scoring record" check uses the same blend, and its usage row
  is shown for information only ("already in the score"), so usage counts once. When usage decides a swap, the swap says
  "more work lately (9.0 vs 5.5 carries + targets per game)". Quarterbacks, kickers and defenses are unchanged.
- **Does usage help?** On the Trends tab, a collapsed check predicts last week from the three weeks before it, once from
  points alone and once with usage, using the weekly pages already saved in your browser (no requests). It reports the
  average miss for each and how many player-weeks, keeps a running total across weeks, and says "Based on one week" until
  it has three.
- **Last week.** Every Do now move the tray shows is logged for that week, and stays logged after you make it. On
  Tuesday and Wednesday the line under the verdict reads "Last week: you made 1 of 2 suggested moves. Best possible
  lineup 118.4, yours 109.2." (last week's team page: one request, cached 3 hours because stat corrections can still
  land). Details list each move, made or skipped, with both players' points; the best possible lineup is hindsight.
- **Role news on your team page.** Checked in a real browser on 2026-11-16: every saved free-agent list was over 6 hours
  old, because the daily snapshot saves them once, and the news check ran before the snapshot. Now the news is checked
  again when the snapshot finishes. If there is news and no list under 6 hours old for that position, the tray reads that
  position's free-agent list once (the page the snapshot reads, cached 30 minutes, at most 3 positions).
- **At most three options in view.** The Optional group shows three rows and folds the rest into "N more options".

## Sharing with a friend

`npm run publish:friends` runs the checks and uploads the committed code to a secret GitHub gist. The first time, make the gist with `npm run check && node scripts/userscript.js --publish --create`, which saves its id in `scripts/gist-id.txt` and prints the install link. Friends install Tampermonkey, turn on **Allow User Scripts** for it in Chrome's extension details, open the link and click Install. Tampermonkey then picks up each publish on its own, usually within a day. Anyone with the link can read the script, so keep the link to people you trust.

**Note on auto-update trust:** the userscript's update address is `http://localhost:8787`. While `npm run serve` is not running, any other program that opens that port could serve code that Tampermonkey would install. Turn off the manager's auto-update, or remove the script's update check, when you are not developing.
