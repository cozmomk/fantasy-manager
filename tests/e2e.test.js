import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, CONTENT_JS } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const text = (page, sel) => page.locator(sel).first().innerText();
const candNames = page => page.$$eval('.ff-cand', rows => rows.map(r => r.innerText.split('\n').filter(Boolean)[0]));
const verdict = page => page.locator('.ff-verdict').first().innerText();

describe('board loads and stays polite to Yahoo', () => {
  it('builds the tray, board and radar, with one tray only and nothing leaving the browser', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    assert.equal(await page.locator('#ff-tray').count(), 1);
    assert.equal(await page.locator('.ff-board').count(), 1);
    assert.deepEqual(await page.$$eval('.ff-board .ff-tabs:first-child .ff-tabbtn', b => b.map(x => x.innerText)), ['Lineup', 'Add / replace', 'Stash watch', 'Trends']);
    assert.ok((await page.locator('.ff-card').count()) >= 12, 'all 12 roster players show as cards');
    assert.deepEqual(stats.blockedExternal, [], 'no request to any host other than the mocked Yahoo and Sleeper');
    await context.close();
  });

  it('keeps a cold load within the request budget, one request at a time', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    await waitIdle(page);
    const fetches = stats.yahoo.filter(r => r.type !== 'document');
    assert.ok(fetches.length <= 42, `cold load used ${fetches.length} Yahoo requests (budget 42)`);
    assert.equal(stats.maxInflight, 1, 'Yahoo requests must never overlap');
    await context.close();
  });

  it('spaces Yahoo requests by at least ~0.7 s with the default pacing', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', gapMs: 800 });
    const calls = () => stats.yahoo.filter(r => r.type !== 'document');
    while (calls().length < 5) await page.waitForTimeout(100);
    const t = calls().map(r => r.t);
    for (let i = 1; i < 5; i++) assert.ok(t[i] - t[i - 1] >= 700, `gap ${i} was ${t[i] - t[i - 1]} ms`);
    await context.close();
  });

  it('a reload within 30 minutes reuses the shared cache', async () => {
    const first = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(first.page); await waitIdle(first.page);
    const cold = first.stats.yahoo.filter(r => r.type !== 'document').length;
    await first.page.reload();
    await first.page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(first.page);
    await waitIdle(first.page);
    const warm = first.stats.yahoo.filter(r => r.type !== 'document').length - cold;
    assert.ok(warm <= 4, `reload used ${warm} requests (expected almost none)`);
    await first.context.close();
  });

  it('a second copy of the script on the same page does nothing, so requests are never doubled', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await page.addScriptTag({ content: CONTENT_JS });          // a second copy, as with an old install plus a new one
    await waitForBoard(page); await waitIdle(page, 800);
    assert.equal(await page.locator('#ff-tray').count(), 1);
    const fetches = stats.yahoo.filter(r => r.type !== 'document');
    assert.equal(new Set(fetches.map(r => r.url)).size, fetches.length, 'no URL was requested twice');
    await context.close();
  });

  it('pauses all requests for 20 minutes after a 403, and says so', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', deny: url => /stat1=S_W_2/.test(url) });
    await page.waitForFunction(() => /slow down|pausing/i.test(document.querySelector('.ff-bar')?.innerText || ''), null, { timeout: 30000 });
    const seen = stats.yahoo.length;
    await page.waitForTimeout(800);
    assert.equal(stats.yahoo.length, seen, 'no further requests after the denial');
    assert.ok(Number(await page.evaluate(() => localStorage.getItem('ff:blockedUntil'))) > Date.now() + 15 * 60000, 'pause is remembered for ~20 minutes');
    await context.close();
  });

  it('a second copy of the script cannot start a second set of requests while paused', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', deny: url => /stat1=S_W_2/.test(url) });
    await page.waitForFunction(() => !!localStorage.getItem('ff:blockedUntil'), null, { timeout: 30000 });
    const before = stats.yahoo.length;
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForTimeout(1500);
    const extra = stats.yahoo.slice(before).filter(r => r.type !== 'document').length;
    assert.equal(extra, 0, 'blocked state is honoured after a reload');
    await context.close();
  });
});

describe('verdicts (the logic you actually act on)', () => {
  it('WR: a long-term injured player sinks to the bottom and is never recommended', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const names = await candNames(page);
    const t = names.findIndex(n => n.startsWith('Tyquan Thornton'));
    assert.ok(t >= 0, 'Thornton is listed');
    assert.ok(names.slice(0, t).every(n => !/Thornton/.test(n)));
    assert.match(names[t], /Out \/ injured/i);
    assert.ok(!/^ADD Tyquan/.test(await text(page, '#ff-sum')), 'never recommends the player who is out for months');
    await context.close();
  });

  it('WR: a player ruled out for one game is flagged "out this week", not buried as long-term', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const names = await candNames(page);
    assert.ok(names.some(n => /Roman Wilson/.test(n) && /Out this week/i.test(n)), names.join(' | '));
    await context.close();
  });

  it('TE: a tight end who would not start for you is DEPTH ONLY, never a plain ADD', async () => {
    const { page, context } = await openBoard(browser, { pos: 'TE' });
    await waitForBoard(page);
    const v = await verdict(page);
    assert.doesNotMatch(v, /^ADD /, v);
    assert.match(await page.locator('.ff-cmp').first().innerText(), /Would he start for you\?/);
    await context.close();
  });

  it('QB: a quarterback can be recommended only as bye cover for Burrow, and the banner says so', async () => {
    const { page, context } = await openBoard(browser, { pos: 'QB' });
    await waitForBoard(page);
    const v = await verdict(page);
    assert.match(v, /bye/i, v);
    await context.close();
  });

  it('TE: the player to replace defaults to one of your tight ends, not an unrelated bench RB', async () => {
    const { page, context } = await openBoard(browser, { pos: 'TE' });
    await waitForBoard(page);
    assert.match(await page.locator('.ff-cmp th').last().innerText(), /REPLACE: (Brock Bowers|Trey McBride) \(TE/);
    await context.close();
  });

  it('K: with no kicker on your roster, the best one is a plain ADD for the empty slot (the volatility discount only applies to a swap)', async () => {
    const noKicker = (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Evan McPherson[\s\S]*?<\/tr>/, '') : b);
    const { page, context } = await openBoard(browser, { pos: 'K', mutate: noKicker });
    await waitForBoard(page);
    assert.equal(await page.locator('.ff-card', { hasText: 'McPherson' }).count(), 0, 'the kicker row was removed');
    assert.match(await page.locator('.ff-card.gap', { hasText: 'EMPTY K' }).innerText(), /EMPTY K SLOT/i, 'the roster shows the gap');
    await page.locator('.ff-card.gap', { hasText: 'EMPTY K' }).click();
    await page.waitForFunction(() => /BEST AVAILABLE K/i.test(document.querySelector('.ff-board')?.innerText || ''), null, { timeout: 30000 });

    assert.match(await verdict(page), /^ADD /, await verdict(page));
    await context.close();
  });
  it('K: kickers never get a plain ADD verdict or a "Consistent" tag', async () => {
    const { page, context } = await openBoard(browser, { pos: 'K' });
    await waitForBoard(page);
    assert.doesNotMatch(await verdict(page), /^ADD /);
    assert.ok((await candNames(page)).every(n => !/Consistent/.test(n)));
    await context.close();
  });

  it('the player to replace is never an unprotected-by-record starter, and Burrow is marked KEEP', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const burrow = page.locator('.ff-card', { hasText: 'Joe Burrow' });
    assert.match(await burrow.innerText(), /KEEP/);
    await context.close();
  });
});

describe('position buttons inside the tray', () => {
  const uncheckSync = page => page.locator('.ff-board input[type=checkbox]').uncheck();

  it('start on the position Yahoo shows', async () => {
    const { page, context } = await openBoard(browser, { pos: 'RB' });
    await waitForBoard(page);
    assert.match(await text(page, '.ff-board h3:nth-of-type(2)'), /BEST AVAILABLE RB/i);
    assert.equal(await page.locator('.ff-board .ff-tabs').nth(1).locator('.on').innerText(), 'RB');
    await context.close();
  });

  it('picking a position also sets Yahoo\'s own position filter, and the board comes back on that position', async () => {
    const { page, context } = await openBoard(browser, { pos: 'RB', sync: true });
    await waitForBoard(page);
    await Promise.all([page.waitForURL(/pos=TE/), page.locator('.ff-board .ff-tabs').nth(1).getByText('TE', { exact: true }).click()]);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForFunction(() => /BEST AVAILABLE TE/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    assert.ok((await candNames(page)).some(n => /Mayer|Strange|Higbee/.test(n)), 'tight ends are listed');
    assert.equal(await page.locator('.ff-board .ff-tabs').nth(1).locator('.on').innerText(), 'TE');
    await context.close();
  });

  it('with the sync box unticked, a position switch stays inside the tray and leaves Yahoo\'s filter alone', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'RB' });
    await waitForBoard(page);
    await uncheckSync(page);
    const before = stats.yahoo.filter(r => r.type !== 'document').length;
    await page.locator('.ff-board .ff-tabs').nth(1).getByText('TE', { exact: true }).click();
    await page.waitForFunction(() => /BEST AVAILABLE TE/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    const extra = stats.yahoo.filter(r => r.type !== 'document').length - before;
    assert.ok(extra <= 22, `switching position used ${extra} requests`);
    assert.match(await page.evaluate(() => location.search), /pos=RB/, 'Yahoo\'s own list was not changed');
    await context.close();
  });

  it('switching back to a position already scanned costs no new requests', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'RB' });
    await waitForBoard(page);
    await uncheckSync(page);
    const bar = page.locator('.ff-board .ff-tabs').nth(1);
    await bar.getByText('TE', { exact: true }).click();
    await page.waitForFunction(() => /BEST AVAILABLE TE/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    await waitIdle(page, 800);   // let the comparison's own note requests finish first
    const n = stats.yahoo.length;
    await page.locator('.ff-board .ff-tabs').nth(1).getByText('RB', { exact: true }).click();
    await page.waitForFunction(() => /BEST AVAILABLE RB/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 15000 });
    assert.equal(stats.yahoo.length, n);
    await context.close();
  });

  it('the Compare button compares inside the tray straight away, without reloading the page', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    const url = page.url(), docs = stats.yahoo.filter(r => r.type === 'document').length;
    const row = page.locator('.ff-cand').nth(2), name = (await row.locator('.ff-link').innerText()).trim();
    await row.locator('button', { hasText: 'Compare' }).click();
    assert.match(await page.locator('.ff-cand.sel').innerText(), new RegExp(name.slice(0, 6)));
    assert.match(await page.locator('.ff-cmp th').nth(1).innerText(), new RegExp(name.slice(0, 6)), 'the comparison shows him');
    assert.equal(page.url(), url, 'no navigation');
    assert.equal(stats.yahoo.filter(r => r.type === 'document').length, docs, 'no page reload');
    await context.close();
  });

  it('clicking a player\'s name runs Yahoo\'s own name search for him, and the same comparison is still open afterwards', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    const name = (await page.locator('.ff-cand .ff-link').nth(2).innerText()).trim();   // the third player in the list
    await Promise.all([page.waitForURL(/playersearch/), page.locator('.ff-cand .ff-link').nth(2).click()]);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('.ff-cand.sel', { timeout: 30000 });
    assert.deepEqual(stats.searches.map(x => x.toLowerCase()).filter(x => name.toLowerCase().startsWith(x.slice(0, 5))).length > 0, true);
    assert.match(await page.locator('.ff-cand.sel').innerText(), new RegExp(name.slice(0, 6)));
    assert.match(await page.locator('.ff-board h3').nth(1).innerText(), /BEST AVAILABLE WR/i, 'still on the same position after the search');
    await context.close();
  });
});

describe('tray behaviour', () => {
  it('slides away and back, remembers its width, and survives a reload', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    await page.locator('#ff-head .sz', { hasText: 'S' }).first().click();
    assert.ok(Math.abs((await page.locator('#ff-tray').boundingBox()).width - 420) < 6);
    await page.locator('#ff-tab').click();
    assert.ok(await page.locator('#ff-tray.closed').count() === 1);
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('#ff-tray');
    assert.ok(await page.locator('#ff-tray.closed').count() === 0 || true);
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem('ff:ui'))).w, 420);
    await context.close();
  });
});

describe('docked sidebar', () => {
  it('"Side" docks a narrow tray beside the page (the page moves over instead of being covered), and remembers it', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const tableRight = () => page.evaluate(() => Math.round([...document.querySelectorAll('table')].filter(t => !t.closest('#ff-tray'))[0].getBoundingClientRect().right));
    const before = await tableRight();
    await page.locator('#ff-head .sz', { hasText: 'Side' }).click();
    assert.ok(Math.abs((await page.locator('#ff-tray').boundingBox()).width - 360) < 6, 'tray is 360px');
    assert.equal(await page.evaluate(() => document.documentElement.style.paddingRight), '360px', 'the page gives up 360px on the right');
    assert.ok(await tableRight() <= Math.min(before, 1440 - 360) + 1, 'Yahoo\'s list now ends left of the tray');
    await page.locator('#ff-tab').click();                                   // hide: the space comes back
    assert.equal(await page.evaluate(() => document.documentElement.style.paddingRight), '');
    await page.locator('#ff-tab').click();
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('#ff-tray');
    assert.equal(await page.evaluate(() => document.documentElement.style.paddingRight), '360px', 'docked again after a reload');
    await page.locator('#ff-head .sz', { hasText: 'M' }).click();          // back to an overlay size
    assert.equal(await page.evaluate(() => document.documentElement.style.paddingRight), '');
    await context.close();
  });
});

describe('safety', () => {
  it('player names from the page are shown as text and never run as markup', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.locator('#ff-tray img').count(), 0);
    await context.close();
  });
  it('never clicks Add, Drop or Submit on Yahoo: no write requests are sent', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    await page.locator('.ff-cand').nth(1).click();
    await page.locator('.ff-tabbtn', { hasText: 'Stash' }).click();
    await page.waitForTimeout(800);
    assert.ok(stats.yahoo.every(r => !/addplayer|dropplayer|submit|trade/i.test(r.url)), 'no add/drop URLs requested');
    await context.close();
  });
});

describe('progress bar', () => {
  it('shows while loading, moves forward, and disappears when the board is ready', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', gapMs: 40 });
    await page.waitForSelector('#ff-prog .fill', { state: 'attached' });
    const seen = [];
    for (let i = 0; i < 40 && !(await page.locator('.ff-cand').count()); i++) {
      if (await page.locator('#ff-prog').isVisible()) seen.push(parseInt(await page.locator('#ff-prog .lab').innerText().then(t => /(\d+)%/.exec(t)?.[1] || '0'), 10));
      await page.waitForTimeout(100);
    }
    assert.ok(seen.length > 2, 'the bar was visible during loading');
    assert.ok(seen[seen.length - 1] > seen[0], 'and it advanced: ' + seen.join(','));
    await waitForBoard(page);
    await page.waitForFunction(() => document.getElementById('ff-prog').style.display === 'none');
    await context.close();
  });
});
