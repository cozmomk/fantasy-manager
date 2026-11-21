import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, teamUrl, api, CONTENT_JS } from './helpers.js';
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

const fetches = stats => stats.yahoo.filter(r => r.type !== 'document');
const allIn = page => page.waitForFunction(() => window.__FF_TEST__ && window.__FF_TEST__.extrasDone, null, { timeout: 30000 });
// time passes: every saved Yahoo page (or only those whose key matches) becomes older by `ms`
const age = (page, ms, match = '') => page.evaluate(([ms, match]) => {
  Object.keys(localStorage).filter(k => k.startsWith('ffc3:') && k.includes(match)).forEach(k => {
    const h = JSON.parse(localStorage.getItem(k)); h.t -= ms; localStorage.setItem(k, JSON.stringify(h));
  });
}, [ms, match]);

describe('moving between screens: saved numbers first, fewer requests', () => {
  it('your team page draws from saved numbers at once, then swaps in fresh ones', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const first = await openBoard(browser, { url: teamUrl('6'), context });
    await allIn(first.page);
    await first.page.close();
    const { page, stats } = await openBoard(browser, { url: teamUrl('6'), context, gapMs: 600, load: false });
    await age(page, 2 * 864e5);                       // two days later
    const before = fetches(stats).length;
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('.ff-stale', { timeout: 3000 });
    assert.ok(fetches(stats).length - before <= 1, 'drawn before the fresh pass gets going');
    assert.match(await page.locator('.ff-verdict').innerText(), /Saved numbers from \d+:\d\d [ap]m\. Fresh ones are loading/);
    assert.match(await page.locator('.ff-board').innerText(), /Your lineup/i, 'the whole lineup is there');
    await page.waitForSelector('.ff-stale', { state: 'detached', timeout: 60000 });
    assert.ok(fetches(stats).length - before > 0, 'then fresh numbers were read');
    await context.close();
  });

  it('when everything saved is still fresh there is no saved-numbers pass', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const first = await openBoard(browser, { url: teamUrl('6'), context });
    await allIn(first.page);
    await first.page.close();
    const { page, stats } = await openBoard(browser, { url: teamUrl('6'), context });
    await allIn(page);
    assert.equal(await page.locator('.ff-stale').count(), 0);
    assert.ok(!(await page.evaluate(() => window.__ffMarks || [])).some(m => m.startsWith('saved board shown')));
    assert.ok(fetches(stats).length <= 4, `${fetches(stats).length} requests on a warm reload`);
    await context.close();
  });

  it('a week of your own players is kept once Yahoo\'s stat corrections are in (the Friday after it)', async () => {
    const THU = Date.parse('2026-10-08T12:00:00'), FRI = Date.parse('2026-10-09T18:00:00');   // week 5 runs Oct 6 - Oct 12
    const { page, context } = await openBoard(browser, { url: teamUrl('6'), now: THU });
    await page.waitForSelector('.ff-board');
    assert.equal(await api(page, 'ttlFor', 'S_W_4', true), 180, 'last week, before corrections: 3 hours');
    assert.equal(Math.round(await api(page, 'ttlFor', 'S_W_3', true)), Math.round((THU - Date.parse('2026-10-02T00:00:00')) / 60000), 'an older week: any copy saved after its corrections');
    assert.equal(await api(page, 'ttlFor', 'S_W_3', false), 720, 'free-agent pages keep the old limit: who is on them changes');
    assert.equal(await api(page, 'ttlFor', 'R_O', true), 30, 'ownership and trends: 30 minutes');
    await page.evaluate(t => { window.__FF_TEST__.now = t; }, FRI);
    assert.equal(await api(page, 'ttlFor', 'S_W_4', true), 18 * 60, 'Friday evening: last week is final too');
    await context.close();
  });

  it('the request count in the status line follows requests made after the board is drawn', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('6') });
    await allIn(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForTimeout(1500);
    const shown = +(await page.locator('.ff-bar').innerText()).match(/Yahoo requests so far on this page: (\d+)/)[1];
    assert.equal(shown, await page.evaluate(() => window.__FF_TEST__.api.getYahooCount()));
    await context.close();
  });

  it('the Trends tab reuses today\'s trending lists for the rest of the day', async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const first = await openBoard(browser, { url: teamUrl('6'), context });
    await allIn(first.page);
    await first.page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await first.page.waitForFunction(() => /Transaction|adds|Adds/.test(document.querySelector('.ff-board').innerText), null, { timeout: 20000 });
    await first.page.waitForTimeout(800);
    assert.ok(first.stats.yahoo.some(r => /buzzindex/.test(r.url)), 'read once');
    await first.page.close();
    const { page, stats } = await openBoard(browser, { url: teamUrl('6'), context, load: false });
    await age(page, 3 * 3600e3, 'buzz:');              // three hours later, same day
    await page.addScriptTag({ content: CONTENT_JS });
    await allIn(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForTimeout(1500);
    assert.equal(stats.yahoo.filter(r => /buzzindex/.test(r.url)).length, 0, 'not read again');
    await context.close();
  });
});
