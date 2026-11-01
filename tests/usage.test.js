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
    assert.match(await verdict(4.3, 11), /^KEEP Busy Benchman: Hot Pickup gets far less work/, 'the Cooper vs Wilson case');
    assert.doesNotMatch(await verdict(8, 11), /gets far less work/, 'a smaller gap does not trigger the rule');
    await context.close();
  });
});
