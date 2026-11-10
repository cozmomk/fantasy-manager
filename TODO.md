# To do

## "Best available" should open on a suggested list, not just the position you clicked

**Idea (2026-10-14):** when you pick a position in the tray, the board should first say whether you actually
need that position, and rank the wire by what fills a real gap. Don't show more of something you already have plenty of.

**Examples**
- Click the empty-slot card for K because the roster says it is vacant: the list opens with "You need a kicker" and the
  best free kickers, not a neutral list.
- RB/WR imbalance: you are deep at WR but thin at RB, with an upcoming bye and no healthy backup. The default list should
  suggest an RB (the position you need), not another WR.
- A starter on a bye this week or out, with nobody on the bench who can play the slot: suggest that position first.

**Suggested approach**
1. A `needs(roster, week)` function that scores each position's need from signals the board already has:
   empty starting slot (`emptySlots`), starter out or on bye this week with no healthy bench cover (`coversBye`, `computeLineup`
   fixes), a starter with a bye in the next 1-3 weeks and no cover, injured starters, and depth vs. slots (bench count per position).
2. A "Suggested for you" view that is the default of the Add / replace tab: ranked needs, each with a one-line reason
   ("Goff is on bye week 6 and you have no other QB"), and the top 3 wire players for that need pre-compared against the
   matching player to replace (the existing comparison engine).
3. Positions you do not need stay one click away behind the position buttons; the suggested list never recommends adding
   to a surplus position unless it replaces a clearly weaker player.
4. Offline tests with `mutate` fixtures: empty K, RB-thin/WR-deep with an upcoming bye, nothing needed (shows "no gaps").

**Reuse:** `emptySlots`, `computeLineup`, `coversBye`, `defaultRep`, `compare`, and the position buttons / `selectRadarPos`.

## Trade analyzer built on your own rules

Every competitor (FantasyPros Coach, RotoBot, ESPN) grades trades; this tool does not. Grade a proposed trade with the same
rules the board already uses (consistent scoring over the last 4 weeks, momentum, health, byes, protecting proven players),
show both sides side by side, and check what the trade does to your starting lineup and bye coverage, not just player value.

## Per-league news alert: role changes and players free in your league

The "Role changes in the news" table only shows when you open Trends. Turn it into an alert: when a recent Yahoo note names a
player as gaining work and that player is free in one of your leagues, say so at the top of the tray in that league (and in
both leagues if he is free in both). Waivers clear Wednesday, so timing is the edge.

## Opponent-aware start/sit

Read this week's opponent from the matchup page (their lineup, empty slots, byes) and show it in the Lineup tab: how close
the matchup is on recent scoring, and whether a riskier or safer start makes sense. Matchup strength (defense vs. position)
can be a tie-breaker, never the main rule, since you prefer consistent scoring over one-week projections.

## Sharpen the rules (keep them, make them smarter)

The current rules (consistent scoring, momentum, never add the injured, protect proven players) avoid bad moves but are
mostly defensive. In order of payoff:

1. **Usage next to points.** Four weeks of fantasy points is a small, lagging sample. Targets, carries, snap share and
   red-zone work predict the next few weeks better (9 targets for 6 points beats 3 targets and one long touchdown). Yahoo's
   stat views the board already reads include targets and receptions. "Consistent scoring" becomes "consistent opportunity".
2. **Compare against the best free player at each position (replacement level).** A WR averaging 10 matters less when 8-point
   WRs are free; an RB averaging 10 matters more when the best free RB scores 5. Shows where a roster spot really counts, and
   why streaming K/DEF works.
3. **Floor or ceiling, depending on the week.** In head-to-head, favour floor when you are favoured and ceiling (boom/bust)
   when you are likely to lose. Ties into opponent-aware start/sit above.
4. **Protect role, not draft position.** "Proven" by ADP is August information. Protect players who are hurt or slumping with
   their role intact; stop protecting players whose role is gone.
5. **Playoff schedule.** Matchups in your playoff weeks as a column and a
   stash factor.
6. **Bench for upside.** In 12/14-team casual leagues, floor depth is usually available on waivers; the bench is better used
   for a backup RB one injury from a lead role or a receiver whose role is growing.
7. **Momentum as confirmation, not trigger.** Add counts show what the crowd already did; role news, injuries ahead of a backup
   and Wednesday waiver timing are where to get there first.
8. **Read the other managers.** Who is desperate at a position, who has a bye crunch, who never checks waivers (the snapshots
   already record activity): for trade offers and claim timing.

## A design system for the tray (DESIGN.md and a typeface)

**Why:** every new feature re-decides type sizes, spacing and component shapes; the tray uses `system-ui` and literal
values. Two outside design reviews (2026-11-10) flagged it.

**What:** run `/design-consultation` to write a DESIGN.md for the tray: type scale, spacing, the named colors already
added (`--ff-must`, `--ff-risk`, `--ff-option`, `--ff-ok`, `--ff-muted`), rules for groups, rows and pills, and a chosen
typeface. Weigh the extra userscript size of a bundled font.

**When:** before building the waiver claim plan (item 3 of `docs/designs/gameday-and-roadmap.md`). Nothing blocks it.
