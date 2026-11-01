import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, teamUrl, listUrl } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const P = (id, pos, slot, o = {}) => ({ id, name: id, pos, slot, bye: 99, out: 0, injTag: '',
  m: { played: 4, good: o.good ?? 2, avg: 10, form: 10, adp: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8 }, ...(o.p || {}) });
const needs = (page, players, week = 6, slots = {}) => page.evaluate(([pl, w, sl]) => window.__FF_TEST__.api.needsOf(pl, w, sl).map(n => [n.pos, n.score, n.why[0]]), [players, week, slots]);

describe('what you need (pure)', () => {
  let page, context;
  before(async () => { ({ page, context } = await openBoard(browser, { pos: 'WR' })); await waitForBoard(page); });
  after(async () => { await context.close(); });

  it('an empty slot comes first, then a starter on bye with no cover, then an upcoming bye with no backup', async () => {
    const roster = [P('qb', 'QB', 'QB', { p: { bye: 6 } }), P('rb1', 'RB', 'RB'), P('rb2', 'RB', 'BN'), P('wr1', 'WR', 'WR'), P('wr2', 'WR', 'BN'), P('te', 'TE', 'TE', { p: { bye: 8 } })];
    const n = await needs(page, roster, 6, { QB: 1, RB: 1, WR: 1, TE: 1, K: 1 });
    assert.deepEqual(n.map(x => x[0]), ['K', 'QB', 'TE']);
    assert.match(n[0][2], /your K slot is empty/);
    assert.match(n[1][2], /qb is on bye this week and nobody on your bench can play QB/);
    assert.match(n[2][2], /bye is week 8 and you have no other healthy TE/);
  });
  it('flags no RB/WR backup and a starter with a poor record, but not a proven one', async () => {
    const roster = [P('rb', 'RB', 'RB', { good: 0 }), P('wr', 'WR', 'WR', { good: 0, p: { m: { played: 4, good: 0, avg: 4, form: 4, adp: 20, trendKnown: false, start: { v: 0, d: 0 }, thr: 8 } } }), P('wr2', 'WR', 'BN')];
    const n = await needs(page, roster, 6, { RB: 1, WR: 1 });
    const rb = n.find(x => x[0] === 'RB');
    assert.ok(rb, 'RB is a need');
    assert.ok(!n.some(x => x[0] === 'WR' && /good game/.test(x[2])), 'a proven (early-drafted) WR with a bad month is not called weak');
  });
  it('a fully covered roster has no needs', async () => {
    const roster = [P('qb', 'QB', 'QB'), P('qb2', 'QB', 'BN'), P('rb', 'RB', 'RB'), P('rb2', 'RB', 'BN'), P('wr', 'WR', 'WR'), P('wr2', 'WR', 'BN')];
    assert.deepEqual(await needs(page, roster, 6, { QB: 1, RB: 1, WR: 1 }), []);
  });
});

describe('Suggested for you box', () => {
  const slots = { QB: 1, RB: 2, WR: 1, TE: 1, 'W/R/T': 1, K: 1, DEF: 1, IR: 1 };   // matches the test roster (one WR starter plus a flex)
  const noKicker = (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Evan McPherson[\s\S]*?<\/tr>/, '') : b);

  it('tops the Add / replace tab with your needs and a button to the best available at each', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: noKicker, slots });
    await waitForBoard(page);
    const box = page.locator('.ff-suggest');
    assert.match(await box.innerText(), /Suggested for you/i);
    assert.match(await box.innerText(), /NEED K.*your K slot is empty/s);
    assert.match(await box.innerText(), /You are looking at WR, which you do not need right now/);
    await box.getByText('Best available K').click();
    await page.waitForFunction(() => /BEST AVAILABLE K/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    await context.close();
  });

  it('on Yahoo\'s "All" player list, the board opens on your top need instead of a position you did not pick', async () => {
    const { page, context } = await openBoard(browser, { url: listUrl('O'), mutate: noKicker, slots });
    await waitForBoard(page);
    assert.match(await page.locator('.ff-board h3').nth(1).innerText(), /BEST AVAILABLE K/i);
    await context.close();
  });

  it('on your team page, opening Add / replace scans your top need', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('6'), mutate: noKicker, slots });
    await page.waitForSelector('.ff-board'); await waitIdle(page, 600);
    await page.locator('.ff-tabbtn', { hasText: 'Add / replace' }).click();
    await page.waitForFunction(() => /BEST AVAILABLE K/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    await context.close();
  });
});
