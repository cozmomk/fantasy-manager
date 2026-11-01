import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle } from './helpers.js';
import { players } from './fixtures.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const calls = stats => stats.yahoo.filter(r => r.type !== 'document');
// pretend the saved pages were fetched `min` minutes ago
const ageCache = (page, min) => page.evaluate(m => {
  Object.keys(localStorage).filter(k => /^ffc\d*:/.test(k)).forEach(k => { const h = JSON.parse(localStorage.getItem(k)); h.t -= m * 60000; localStorage.setItem(k, JSON.stringify(h)); });
}, min);

describe('staged loading', () => {
  it('shows your roster and the Lineup tab before the wire scan has finished', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', gapMs: 120 });
    await page.waitForSelector('.ff-card', { timeout: 30000 });
    assert.equal(await page.locator('.ff-cand').count(), 0, 'the wire list is not there yet');
    assert.match(await page.locator('.ff-board').innerText(), /Scanning the WR wire/i);
    await page.locator('.ff-tabbtn', { hasText: 'Lineup' }).click();     // usable straight away
    assert.match(await page.locator('.ff-board').innerText(), /Your lineup/i);
    await page.locator('.ff-tabbtn', { hasText: 'Add / replace' }).click();
    await page.waitForSelector('.ff-cand', { timeout: 30000 });           // and the wire fills in afterwards
    await context.close();
  });
});

describe('keeping finished weeks', () => {
  it('a reload hours later does not refetch the stats of finished weeks', async () => {
    const first = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(first.page); await waitIdle(first.page, 800);
    const cold = calls(first.stats).length;
    await ageCache(first.page, 120);                                      // two hours later: ownership and status are stale, finished weeks are not
    const second = await openBoard(browser, { pos: 'WR', context: first.context });
    await waitForBoard(second.page); await waitIdle(second.page, 800);
    const warm = calls(second.stats);
    assert.ok(warm.length <= cold * 0.65, `${warm.length} requests after 2 hours vs ${cold} cold`);
    assert.ok(warm.every(r => !/stat1=S_W_[123]\b/.test(r.url)), 'weeks 1-3 were not requested again');
    await first.context.close();
  });

  it('a player you just added is never missing from the kept stats', async () => {
    const first = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(first.page); await waitIdle(first.page, 800);
    await ageCache(first.page, 120);
    const added = players.find(p => p.id === '21');                       // C.J. Stroud joins your bench
    Object.assign(added, { mine: true, slot: 'BN' });
    try {
      const second = await openBoard(browser, { pos: 'WR', context: first.context });
      await waitForBoard(second.page); await waitIdle(second.page, 800);
      await second.page.waitForFunction(() => { const c = [...document.querySelectorAll('.ff-card')].find(x => /Stroud/.test(x.innerText)); return c && !/\/\? good/.test(c.innerText); }, null, { timeout: 30000 });
      assert.ok(calls(second.stats).some(r => /fteam=/.test(r.url) && /stat1=S_W_[123]\b/.test(r.url)), 'your-roster stats were refetched because the roster changed');
    } finally { Object.assign(added, { mine: undefined, slot: undefined }); delete added.mine; delete added.slot; }
    await first.context.close();
  });
});

describe('wire list before notes', () => {
  it('shows the wire list first, then the injury notes arrive and re-rank it (Thornton still sinks)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', gapMs: 150 });
    await page.waitForSelector('.ff-cand', { timeout: 30000 });
    assert.equal(await page.locator('.ff-notes-pending').count(), 1, 'the list is up while notes are still loading');
    await page.waitForFunction(() => !document.querySelector('.ff-notes-pending'), null, { timeout: 30000 });
    const names = await page.$$eval('.ff-cand', rows => rows.map(r => r.innerText.split('\n')[0]));
    const t = names.findIndex(n => /Thornton/.test(n));
    assert.ok(t >= 0 && names.slice(0, t).every(n => !/Thornton/.test(n)));
    assert.ok(await page.evaluate(() => (window.__ffMarks || []).some(m => /notes loaded/.test(m))), 'timing marks are recorded');
    await context.close();
  });
});

describe('notes cache and background kicker/defense load', () => {
  it('after a few hours only injured players\' notes are refetched, and kicker/defense stats load after the notes', async () => {
    const first = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(first.page); await waitIdle(first.page, 1000);
    const noteReq = st => st.yahoo.filter(r => /playernote/.test(r.url));
    const coldNotes = noteReq(first.stats).length;
    const order = first.stats.yahoo.filter(r => r.type !== 'document');
    const lastNote = Math.max(...order.map((r, i) => (/playernote/.test(r.url) ? i : -1)));
    const firstKD = order.findIndex(r => { const u = new URL(r.url); return /^(K|DEF)$/.test(u.searchParams.get('pos') || '') && u.searchParams.get('fteam'); });
    assert.ok(firstKD > lastNote, `kicker/defense stats started at request ${firstKD}, notes ended at ${lastNote}`);
    await ageCache(first.page, 120);
    const second = await openBoard(browser, { pos: 'WR', context: first.context });
    await waitForBoard(second.page); await waitIdle(second.page, 1000);
    const warmNotes = noteReq(second.stats).length;
    assert.ok(coldNotes >= 6, `cold load read ${coldNotes} notes`);
    assert.ok(warmNotes > 0 && warmNotes < coldNotes, `${warmNotes} notes refetched after 2 hours vs ${coldNotes} cold (flagged players only)`);
    await first.context.close();
  });
});
