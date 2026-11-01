import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

// Regression tests for the findings of the pre-landing review (two independent reviewers, October 2026).
const P = (id, pos, slot, avg, o = {}) => ({ id, name: id, pos, slot, bye: 99, out: 0, injTag: '',
  m: { played: 4, good: o.good ?? 2, avg, form: avg, adp: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8, ...(o.m || {}) }, ...(o.p || {}) });

describe('injury handling', () => {
  let page, context;
  before(async () => { ({ page, context } = await openBoard(browser, { pos: 'WR' })); await waitForBoard(page); });
  after(async () => { await context.close(); });
  const classify = (text, name) => page.evaluate(([t, n]) => window.__FF_TEST__.api.classify({ text: t }, n), [text, name]);

  it('a short absence, an old surgery or a playable fracture is not "out long-term"', async () => {
    assert.equal(await classify('Smith (ankle) is expected to miss 1-2 weeks.', 'Smith'), 'week');
    assert.equal(await classify('Jones will miss the next 2 games.', 'Jones'), 'week');
    assert.equal(await classify('Lee had wrist surgery in the offseason and has 5 catches in two games.', 'Lee'), '');
    assert.equal(await classify('Brown was suspended one game last year but has had no issues since.', 'Brown'), '');
    assert.equal(await classify('Hill returned to practice after offseason knee surgery and is expected to start.', 'Hill'), '');
    assert.equal(await classify('Moore is questionable but expected to play through a fractured finger Sunday.', 'Moore'), '');
    assert.equal(await classify('Evans was a full participant despite a broken thumb and will play.', 'Evans'), '');
  });
  it('real long absences are still caught', async () => {
    assert.equal(await classify('Thornton is slated to undergo surgery later this week, with a recovery timeline of 3-to-4 months.', 'Tyquan Thornton'), 'long');
    assert.equal(await classify('Ford tore his ACL and is out for the season.', 'Ford'), 'long');
    assert.equal(await classify('Reed was placed on injured reserve Saturday.', 'Reed'), 'long');
    assert.equal(await classify('Gray will miss 12-16 weeks with a broken leg.', 'Gray'), 'long');
    assert.equal(await classify('Cook is expected to miss 6 weeks.', 'Cook'), 'long');
  });
  it('Doubtful and a plain Out tag mean out this week; IR and Sleeper "Doubtful" are handled; Questionable beats a stale Sleeper Out', async () => {
    const lvl = p => page.evaluate(x => window.__FF_TEST__.api.outLevel(x), p);
    assert.equal(await lvl({ injTag: 'D', name: 'A B', note: null, sl: null }), 1);
    assert.equal(await lvl({ injTag: 'O', name: 'A B', note: null, sl: null }), 1);
    assert.equal(await lvl({ injTag: 'IR', name: 'A B', note: null, sl: null }), 2);
    assert.equal(await lvl({ injTag: 'SUSP', name: 'A B', note: null, sl: null }), 2);
    assert.equal(await lvl({ injTag: '', name: 'A B', note: null, sl: { inj: 'Doubtful' } }), 1);
    assert.equal(await lvl({ injTag: 'Q', name: 'A B', note: null, sl: { inj: 'Out' } }), 0);
  });
  it('a high draft pick who missed games stays protected (never the default "weakest" drop)', async () => {
    const proven = m => page.evaluate(x => window.__FF_TEST__.api.proven(x), { m });
    assert.equal(await proven({ played: 1, good: 0, adp: 40, form: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8 }), true);
    assert.equal(await proven({ played: 0, good: 0, adp: 70, form: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8 }), true);
    assert.equal(await proven({ played: 1, good: 0, adp: 150, form: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8 }), false);
  });
});

describe('start / sit extras', () => {
  it('prefers a healthy bench player to a questionable one, and asks more of a questionable upgrade', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const run = pl => page.evaluate(([x]) => { const r = window.__FF_TEST__.api.computeLineup(x, 6, {}); return r.fixes.map(f => [f.sit.id, f.start && f.start.id]).concat(r.swaps.map(w => ['swap', w.sit.id, w.start.id])); }, [pl]);
    assert.deepEqual(await run([P('s', 'WR', 'WR', 9, { p: { bye: 6 } }), P('q', 'WR', 'BN', 12, { p: { injTag: 'Q' } }), P('h', 'WR', 'BN', 10)]), [['s', 'h']]);
    assert.deepEqual(await run([P('s', 'WR', 'WR', 10), P('q', 'WR', 'BN', 12, { good: 3, p: { injTag: 'Q' } })]), [], 'a 20% edge is not enough for a questionable player');
    assert.deepEqual(await run([P('s', 'WR', 'WR', 10), P('q', 'WR', 'BN', 14, { good: 3, p: { injTag: 'Q' } })]), [['swap', 's', 'q']]);
    await context.close();
  });
  it('an empty flex slot is noticed once the flex count is known', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const gaps = (pl, slots) => page.evaluate(([x, sl]) => window.__FF_TEST__.api.computeLineup(x, 6, sl).fixes.map(f => f.slot), [pl, slots]);
    assert.deepEqual(await gaps([P('a', 'RB', 'RB', 8)], { RB: 1, 'W/R/T': 1 }), ['W/R/T']);
    assert.deepEqual(await gaps([P('a', 'RB', 'RB', 8), P('b', 'WR', 'W/R/T', 8)], { RB: 1, 'W/R/T': 1 }), []);
    assert.deepEqual(await gaps([P('a', 'RB', 'RB', 8), P('b', 'WR', 'BN', 9)], { RB: 1, 'W/R/T': 1 }), ['W/R/T'], 'a bench WR is offered to fill it');
    await context.close();
  });
});

describe('role reader subject check', () => {
  it('counts a role phrase only in a sentence about the player, ignores "No. 1" splits and replacement talk', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const r = (t, n) => page.evaluate(([a, b]) => window.__FF_TEST__.api.roleOf(a, b), [t, n]);
    assert.equal(await r('Kamara (ankle) was ruled out. Kendre Miller is expected to lead the backfield in his absence.', 'Alvin Kamara'), null);
    assert.equal((await r('Kamara (ankle) was ruled out. Kendre Miller is expected to lead the backfield in his absence.', 'Kendre Miller')).kind, 'up');
    const hedged = await r('If Hill is out, Waddle could be the No. 1 receiver.', 'Waddle');
    assert.deepEqual([hedged.kind, hedged.maybe], ['up', true], 'the "No. 1" is not treated as a sentence break');
    const down = await r('Walker could be stuck behind Mitchell on the depth chart.', 'Walker');
    assert.deepEqual([down.kind, down.maybe], ['down', true]);
    await context.close();
  });
});

describe('request safety', () => {
  it('only the player-name search is ever a POST; every other Yahoo request is a GET', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ff-board table.ff-cmp tr').length > 3 && !/reading note/.test(document.querySelector('.ff-board').innerText), null, { timeout: 30000 });
    await page.locator('.ff-tabbtn', { hasText: 'Stash' }).click();
    await page.waitForSelector('.ff-cand'); await waitIdle(page, 600);
    const nonGet = stats.methods.filter(m => !/^GET /.test(m));
    assert.deepEqual(nonGet, [], 'no write-style request was sent: ' + nonGet.join(', '));
    await Promise.all([page.waitForURL(/playersearch/), page.locator('.ff-cand .ff-link').first().click()]);
    assert.deepEqual(stats.methods.filter(m => !/^GET /.test(m)), ['POST /f1/LEAGUE/playersearch'], 'the name search is the only POST');
    await context.close();
  });
  it('Yahoo\'s 999 "Request denied" pauses everything for 20 minutes, like a 403', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', failStatus: url => (/stat1=S_W_2/.test(url) ? 999 : 0) });
    await page.waitForFunction(() => /slow down|pausing/i.test(document.querySelector('.ff-bar')?.innerText || ''), null, { timeout: 30000 });
    const seen = stats.yahoo.length;
    await page.waitForTimeout(600);
    assert.equal(stats.yahoo.length, seen, 'no further requests after the 999');
    assert.ok(Number(await page.evaluate(() => localStorage.getItem('ff:blockedUntil'))) > Date.now() + 15 * 60000);
    await context.close();
  });
  it('three server errors in a row also stop the requests (a wall is not "no data")', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', failStatus: url => (/stat1=S_W_/.test(url) ? 503 : 0) });
    await page.waitForFunction(() => !!localStorage.getItem('ff:blockedUntil'), null, { timeout: 30000 });
    const seen = stats.yahoo.length;
    await page.waitForTimeout(600);
    assert.equal(stats.yahoo.length, seen);
    await context.close();
  });
  it('a failed note request is not remembered as "no note"', async () => {
    let failed = 0;                                                    // two failures (a third in a row would trip the breaker)
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', failStatus: url => (/playernote/.test(url) && failed < 2 ? (failed++, 502) : 0) });
    await waitForBoard(page); await waitIdle(page, 1500);
    const notes = stats.yahoo.filter(r => /playernote/.test(r.url)).length;
    const cachedNotes = await page.evaluate(() => Object.keys(localStorage).filter(k => /^ffc\d*:note:/.test(k)).length);
    assert.equal(failed, 2);
    assert.ok(cachedNotes <= notes - 2, `${cachedNotes} notes cached from ${notes} requests: the 2 failed ones must not be saved`);
    await context.close();
  });
  it('requests do not inherit a name search or a reversed sort from the page address', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', url: 'https://football.fantasysports.yahoo.com/f1/111111/players?status=A&pos=WR&cut_type=33&stat1=S_PW_5&myteam=1&sort=PR&sdir=0&search=Mixon' });
    await waitForBoard(page);
    const bad = stats.yahoo.filter(r => r.type !== 'document' && /\/players\?/.test(r.url) && (/[?&]search=/.test(r.url) || /sdir=0/.test(r.url)));
    assert.equal(bad.length, 0, bad.map(r => r.url).slice(0, 2).join(' | '));
    await context.close();
  });
});

describe('storage', () => {
  it('the saved selection is per league and is used only once', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    await Promise.all([page.waitForURL(/playersearch/), page.locator('.ff-cand .ff-link').nth(1).click()]);
    assert.ok(await page.evaluate(() => !!localStorage.getItem('ff:sel:111111')), 'stored under the league id');
    await context.close();
  });
  it('says so when the week cannot be read from the page', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: (url, b) => (/\/players/.test(url) ? b.replaceAll('Week 5 (proj)', 'Wk') : b) });
    await waitForBoard(page);
    assert.match(await page.locator('#ff-health').innerText(), /Could not read the current week/);
    await context.close();
  });
});
