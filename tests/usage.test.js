import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

// usage = rush attempts + targets per game, read from the "Att*" and "Tgt*" columns of Yahoo's weekly views
describe('usage next to points', () => {
  it('roster cards show usage for RB/WR/TE, not for kickers', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    // St. Brown: weekly points 19, 26, 8, 8 -> targets 11, 16, 5, 5 in the fixture -> 9.3 a game, last 2 5.0
    assert.match(await page.locator('.ff-card', { hasText: 'Amon-Ra St. Brown' }).innerText(), /usage 9\.3\/game, last 2 5\.0/);
    assert.doesNotMatch(await page.locator('.ff-card', { hasText: 'Evan McPherson' }).innerText(), /usage/);
    await context.close();
  });

  it('tags a wire player whose carries/targets are climbing before his points do ("Usage up")', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const row = page.locator('.ff-cand', { hasText: 'Wicks' });
    assert.match(await row.innerText(), /Usage up/);
    assert.match(await row.innerText(), /Usage 6\.8\/game, last 2 10\.0/);
    await context.close();
  });

  it('the comparison has a usage row, and says when positions differ', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const usageRow = page.locator('.ff-cmp tr', { hasText: 'Usage: carries + targets' });
    await usageRow.waitFor();
    const t = await usageRow.innerText();
    assert.match(t, /usage \d/);
    if (!/REPLACE: .*\(WR/.test(await page.locator('.ff-cmp th').last().innerText())) assert.match(t, /not comparable across positions/);
    await context.close();
  });

  it('pages without the usage columns still work: usage simply shows as n/a', async () => {
    const strip = (url, b) => (/\/players/.test(url) ? b.replaceAll('<th>Att*</th>', '<th></th>').replaceAll('<th>Tgt*</th>', '<th></th>') : b);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: strip });
    await waitForBoard(page);
    assert.doesNotMatch(await page.locator('.ff-card', { hasText: 'Amon-Ra St. Brown' }).innerText(), /usage/);
    assert.equal((await page.locator('#ff-health').innerText()).trim(), '', 'not treated as a layout break');
    await context.close();
  });

  it('a waiver add getting under half the work of the player he replaces is held back, however hot he looks', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const verdict = (cUse, rUse) => page.evaluate(([cu, ru]) => {
      const m = (avg, form, opp, extra) => ({ pos: 'WR', thr: 8, played: 4, good: 2, avg, form, max: avg * 1.5, weeks: [avg, avg, form, form], oppAvg: opp, oppForm: opp, oppEarly: opp,
        ros: { v: 30, d: 12 }, start: { v: 20, d: 10 }, trendKnown: true, adp: NaN, depth: 'WR3', bye: 9, known: true, ...extra });
      const hot = { add: { count: 400000, rank: 1, posRank: 1 }, inj: '' };
      const c = { id: 'c', name: 'Hot Pickup', pos: 'WR', out: 0, mine: false, injTag: '', note: null, sl: hot, bye: 9, m: m(11, 15, cu, { sl: hot }) };
      const r = { id: 'r', name: 'Busy Benchman', pos: 'WR', out: 0, slot: 'BN', isStarter: false, injTag: '', note: null, sl: null, bye: 12, m: m(10, 9, ru, { ros: { v: 60, d: 0 }, start: { v: 20, d: 0 } }) };
      const starter = { id: 's', name: 'Starter', pos: 'WR', out: 0, slot: 'WR', isStarter: true, bye: 7, m: m(9, 9, 8) };
      return window.__FF_TEST__.api.compare(c, r, { roster: [starter, r], week: 6 }).headline;
    }, [cUse, rUse]);
    // since usage counts in the score (D5, 2026-11-16) the work gap already keeps him; the separate rule is a backstop
    assert.match(await verdict(4.3, 11), /^KEEP Busy Benchman/, 'the Cooper vs Wilson case');
    assert.doesNotMatch(await verdict(8, 11), /gets far less work/, 'a smaller gap does not trigger the rule');
    await context.close();
  });
  it('usage counts in the start score: a busier player wins a near tie, quarterbacks and kickers are unchanged', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const r = await page.evaluate(() => {
      const api = window.__FF_TEST__.api;
      const p = (id, pos, avg, opp) => ({ id, name: id, pos, m: { avg, form: avg, oppAvg: opp, oppForm: opp, played: 4, good: 2, thr: 8 } });
      const busy = p('busy', 'WR', 9.5, 10), idle = p('idle', 'WR', 10, 5), qb = p('qb', 'QB', 18, NaN);
      api.setPpo({ WR: NaN });
      const thin = [api.startScore(busy), api.pointsScore(busy)];   // under 200 opportunities saved: points only (D5)
      api.setPpo({ WR: 1.6 });
      return { thin, busy: api.startScore(busy), idle: api.startScore(idle), pts: [api.pointsScore(busy), api.pointsScore(idle)], qb: [api.startScore(qb), api.pointsScore(qb)],
        decided: api.usageDecided(busy, idle), ppo: api.ppoOf('WR') };
    });
    assert.ok(r.pts[0] < r.pts[1], 'on points alone the idle player is ahead');
    assert.ok(r.busy > r.idle, 'with usage, the busier one is');
    assert.ok(r.decided, 'and the tool knows usage decided it');
    assert.deepEqual(r.qb, [18, 18], 'no usage term for a quarterback');
    assert.equal(r.thin[0], r.thin[1], 'too little saved data: no usage term');
    assert.equal(r.ppo, 1.6);
    await context.close();
  });
  it('the usage back-test predicts last week from the three before it, from saved pages only', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const before = stats.yahoo.length;
    const r = await page.evaluate(() => window.__FF_TEST__.api.usageBacktest(5));
    assert.equal(r.week, 4, 'week 4 is held out; weeks 1-3 train');
    assert.ok(r.n > 0, 'players with saved weekly rows are scored');
    assert.ok(isFinite(r.pts) && isFinite(r.blend), 'both errors are numbers');
    // other background reads may still land; the back-test itself must not read a weekly page
    assert.deepEqual(stats.yahoo.slice(before).map(x => x.url).filter(u => /status=A/.test(u) && /stat1=S_W_/.test(u)), [], 'no Yahoo request for a weekly page');
    // 40 receivers worth exactly 1 point per opportunity in weeks 11-13 and 5 in week 14: if week 4 leaked into the value of
    // an opportunity, the blend's error would differ from points alone. Trained on weeks 1-3 only, the two are identical.
    const seeded = await page.evaluate(() => {
      const d = w => Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['z' + i, { _pos: 'WR', 'GP*': '1', 'Fan Pts': String((w === 14 ? 5 : 1) * (6 + i % 5)), 'Att*': '0', 'Tgt*': String(6 + i % 5) }]));
      [11, 12, 13, 14].forEach(w => localStorage.setItem('ffc3:/f1/111111/players?stat1=S_W_' + w + '&status=A&pos=WR', JSON.stringify({ t: Date.now(), d: d(w) })));
      return window.__FF_TEST__.api.usageBacktest(15);   // weeks the board never loads: only the seeded pages count
    });
    assert.equal(seeded.n, 40);
    assert.ok(Math.abs(seeded.pts - seeded.blend) < 1e-9, 'the held-out week never informs its own prediction: ' + JSON.stringify(seeded));
    await context.close();
  });
});
