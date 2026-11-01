import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, api, CONTENT_JS } from './helpers.js';
import { players, LEAGUE_ID } from './fixtures.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const calls = stats => stats.yahoo.filter(r => r.type !== 'document');
const verdict = page => page.locator('.ff-verdict').first().innerText();

describe('parsers and rules (pure functions, run in the page)', () => {
  it('reads Yahoo\'s transaction table: adds, drops, sources, manager and time', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const rows = await page.evaluate(async () => {
      const html = await (await fetch('/f1/111111/transactions')).text();
      return window.__FF_TEST__.api.parseTransactions(new DOMParser().parseFromString(html, 'text/html'));
    });
    assert.equal(rows.length, 3);
    assert.deepEqual([rows[0].adds.map(x => x.name), rows[0].drops.map(x => x.name)], [['Brian Robinson'], ['Marvin Harrison Jr.']]);
    assert.deepEqual([rows[0].who, rows[0].when], ['Lazy Sundays', 'Oct 11, 10:53 am']);
    assert.equal(rows[0].adds[0].id, '34054');
    assert.deepEqual([rows[2].adds.map(x => x.name), rows[2].drops.length, rows[2].who], [['Denzel Boston'], 0, 'ED SHEERAN HALFTIME SHOW']);
    await context.close();
  });

  it('classifies notes: long-term, this week only, or nothing, and ignores news about teammates', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const c = (text, name) => api(page, 'classify', { text }, name);
    assert.equal(await c('Thornton is slated to undergo surgery, with a recovery timeline of 3-to-4 months.', 'Tyquan Thornton'), 'long');
    assert.equal(await c('Roman Wilson has been ruled out for the remainder of Week 5 with a dislocated finger.', 'Roman Wilson'), 'week');
    assert.equal(await c("White (ankle) has no designation.Advice: With Jalen Nailor (concussion) ruled out, White has a chance.", 'Cody White'), '');
    assert.equal(await c('Bryant will miss 12-16 weeks.', 'Someone Else'), '', 'a note that does not name the player is ignored');
    await context.close();
  });

  it('reads return timelines and checks them against the playoffs (week 15)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const r = (text) => api(page, 'parseReturn', { text }, 5);
    assert.deepEqual([(await r('recovery timeline of 3-to-4 months.')).lo, (await r('recovery timeline of 3-to-4 months.')).hi], [18, 22]);
    assert.deepEqual([(await r('will miss 12-16 weeks')).lo, (await r('will miss 12-16 weeks')).hi], [17, 21]);
    assert.equal((await r('expected to miss 3-4 weeks')).kind, 'range');
    assert.equal((await r('placed on the injured reserve Friday')).lo, 9);
    assert.equal((await r('out for the season with a torn ACL')).kind, 'season');
    assert.equal((await r('')).kind, 'unknown');
    assert.equal((await api(page, 'stashFit', { kind: 'range', lo: 9, hi: 12 })).k, 'good');
    assert.equal((await api(page, 'stashFit', { kind: 'range', lo: 13, hi: 16 })).k, 'tight');
    assert.equal((await api(page, 'stashFit', { kind: 'range', lo: 18, hi: 22 })).k, 'no');
    await context.close();
  });

  it('computes Yahoo % rostered movers and Sleeper add streaks across days', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const snap = (date, ros, add) => ({ date, wire: { WR: [{ id: 'a', name: 'A', ros: ros[0] }, { id: 'b', name: 'B', ros: ros[1] }] }, sleeper: { add24: add, names: { s1: 'Cooper', s2: 'Chism' } } });
    const snaps = [snap('d1', [2, 10], [['s1', 9], ['s2', 8]]), snap('d2', [4, 20], [['s1', 20]]), snap('d3', [8, 28], [['s1', 30], ['s2', 5]])];
    const movers = await api(page, 'computeMovers', snaps);
    assert.deepEqual(movers.map(m => [m.name, m.d]), [['B', 18], ['A', 6]]);
    assert.deepEqual(await api(page, 'computeMovers', [snaps[0]]), [], 'needs two days');
    const streaks = await api(page, 'computeStreaks', snaps);
    assert.equal(streaks.find(s => s.name === 'Cooper').streak, 3);
    assert.equal(streaks.find(s => s.name === 'Chism'), undefined, 'a gap breaks the streak');
    await context.close();
  });
});

describe('comparison rules', () => {
  it('comparing across positions marks the role check as not comparable', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    // the suggested player to replace is a bench RB (Coleman), so WR vs RB
    const role = page.locator('.ff-cmp tr', { hasText: 'Role on his team' });
    await role.waitFor();
    assert.match(await role.innerText(), /not comparable across positions/);
    await context.close();
  });

  it('loads the two compared players\' notes on demand instead of up front', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page); await waitIdle(page, 800);
    const notesBefore = stats.yahoo.filter(r => /playernote/.test(r.url)).length;
    assert.ok(notesBefore <= 12, `${notesBefore} notes on first load (budget 12)`);
    await page.locator('.ff-cand').nth(3).click();
    await page.waitForFunction(() => !/Note loading/.test(document.querySelector('.ff-cmp')?.innerText || ''), null, { timeout: 10000 });
    const added = stats.yahoo.filter(r => /playernote/.test(r.url)).length - notesBefore;
    assert.ok(added <= 2, `${added} extra notes for the two compared players`);
    assert.match(await page.locator('.ff-cmp tr', { hasText: 'Health and news' }).innerText(), /Note \(/);
    await context.close();
  });

  it('with an open IR slot, an injured player on your bench can be parked for a free add (facts only, no fake comparison)', async () => {
    const brooks = players.find(p => p.id === '10'), saved = brooks.slot;
    brooks.slot = 'BN';                                           // free the IR slot for this test
    try {
      const { page, context } = await openBoard(browser, { pos: 'WR' });
      await waitForBoard(page);
      await page.getByText('Compare using IR slot').click();
      const v = await verdict(page);
      assert.match(v, /for free/i, v);
      assert.match(await page.locator('.ff-cmp').first().innerText(), /nobody is being dropped/);
      assert.equal(await page.locator('.ff-cmp td .mk').count(), 0, 'no win/lose marks when nobody is replaced');
      await context.close();
    } finally { brooks.slot = saved; }
  });
});

describe('stash watch', () => {
  it('ranks productive injured players first, skips long absences and low output, and stays light on Yahoo', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page); await waitIdle(page);
    const before = calls(stats).length;
    await page.locator('.ff-tabbtn', { hasText: 'Stash' }).click();
    await page.waitForSelector('.ff-cand');
    await waitIdle(page, 800);
    assert.ok(calls(stats).length - before <= 12, `stash tab used ${calls(stats).length - before} requests`);
    const rows = await page.$$eval('.ff-cand', r => r.map(x => x.innerText.replace(/\n+/g, ' | ')));
    assert.match(rows[0], /Caleb Williams/, rows[0]);
    assert.match(rows[0], /Worth a spot/);
    assert.match(rows.find(r => /Thornton/.test(r)), /Skip/);
    assert.match(rows.find(r => /Bryant/.test(r)), /Skip: low output/);
    assert.match(await verdict(page), /^STASH/);
    await page.locator('.ff-cand', { hasText: 'Thornton' }).click();
    assert.match(await verdict(page), /^SKIP Tyquan Thornton/);
    assert.match(await verdict(page), /after your playoffs/);
    await context.close();
  });
});

describe('stash watch name search', () => {
  it('clicking a player in the Stash tab runs Yahoo\'s name search, then returns to the Stash tab with him selected', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    await page.locator('.ff-tabbtn', { hasText: 'Stash' }).click();
    await page.waitForSelector('.ff-cand');
    await Promise.all([page.waitForURL(/playersearch/), page.locator('.ff-cand .ff-link', { hasText: 'Caleb Williams' }).click()]);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('.ff-cand.sel', { timeout: 30000 });
    assert.ok(stats.searches.some(x => /Caleb Williams/.test(x)), 'Yahoo\'s own search ran for him');
    assert.match(await page.locator('.ff-tabbtn.on').first().innerText(), /Stash/);
    assert.match(await page.locator('.ff-cand.sel').innerText(), /Caleb Williams/);
    assert.match(await verdict(page), /Caleb Williams/);
    assert.equal(await page.locator('.ff-notes-pending').count(), 0);
    await context.close();
  });
});

describe('daily snapshots and trends', () => {
  it('saves one snapshot a day with roster, wire, transactions and Sleeper data, and does not repeat it', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', snapDelayMs: 100 });
    await waitForBoard(page);
    await page.waitForFunction(() => Object.keys(localStorage).some(k => /^ff:snap:/.test(k)), null, { timeout: 30000 });
    const snap = await page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /^ff:snap:/.test(k)))));
    assert.equal(snap.roster.length, 12);
    assert.deepEqual(Object.keys(snap.wire).sort(), ['K', 'QB', 'RB', 'TE', 'WR']);
    assert.equal(snap.tx.length, 3, 'transactions parsed from the feed');
    assert.ok(snap.sleeper.add24.length > 0 && Object.keys(snap.sleeper.names).length > 0);
    assert.ok(JSON.stringify(snap).length < 40000, 'a snapshot stays small');
    assert.ok(snap.yahooRequests <= 6, `${snap.yahooRequests} Yahoo requests for the snapshot`);
    const n = calls(stats).length;
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(page); await page.waitForTimeout(1500);
    assert.equal(calls(stats).filter(r => /transactions/.test(r.url)).length, 1, 'transactions fetched only once');
    assert.ok(calls(stats).length - n <= 4);
    await context.close();
  });

  it('the Trends tab shows league activity, movers and Sleeper streaks from saved days', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', snapDelayMs: 100 });
    await waitForBoard(page);
    await page.waitForFunction(() => Object.keys(localStorage).some(k => /^ff:snap:/.test(k)), null, { timeout: 30000 });
    await page.evaluate(({ id }) => {                       // pretend two earlier days exist with lower ownership
      const today = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => /^ff:snap:/.test(k))));
      const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      const idx = [];
      [2, 1].forEach(n => {
        const old = JSON.parse(JSON.stringify(today)); old.date = day(n);
        Object.values(old.wire).flat().forEach(p => { p.ros = Math.max(0, p.ros - 5 * n); });
        localStorage.setItem('ff:snap:' + id + ':' + old.date, JSON.stringify(old)); idx.push(old.date);
      });
      localStorage.setItem('ff:snapidx:' + id, JSON.stringify([...idx, today.date].sort()));
    }, { id: LEAGUE_ID });
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForSelector('.ff-cmp');
    const t = await page.locator('.ff-board').innerText();
    assert.match(t, /Snapshots saved for 3 days/);
    assert.match(t, /most active managers/i);
    assert.doesNotMatch(t, /most added|most dropped/i, 'the most added / dropped lists are gone');
    assert.match(t, /ED SHEERAN HALFTIME SHOW/);
    assert.match(t, /pts since/, 'movers appear once there are two days');
    assert.match(t, /Days in a row/, 'Sleeper streaks appear');
    await context.close();
  });
});

describe('pending transactions (Yahoo lists them on your team page)', () => {
  // same structure as the live page: a "Pending Transactions" box whose rows read "Waiver 1 (Oct 14): Name Add"
  const box = rows => `<div class="Bdr"><div class="Bg-shade"><span class="Fz-xl">Pending Transactions</span></div><div class="notes-module"><div class="Content">${rows.map(([n, k]) => `<a class="D-b"><div class="Fz-xs Bfc">Waiver 1 (Oct 14): ${n}<span class="Fw-b">${k}</span><div class="Absolute"><span>View Details</span></div></div></a>`).join('')}</div></div></div>`;
  const withPending = rows => (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace('</body>', box(rows) + '</body>') : b);

  it('a suggested add that is already pending says so instead of recommending it again', async () => {
    const wire = players.filter(p => !p.mine).map(p => [p.name, 'Add']);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withPending(wire) });
    await waitForBoard(page);
    assert.match(await verdict(page), /^ALREADY PENDING/, await verdict(page));
    assert.match(await page.locator('.ff-verdict').first().innerText(), /Check Yahoo's pending transactions/);
    await context.close();
  });

  it('reads add+drop claims too ("Add <name>, Drop <name>"), as Yahoo shows them', async () => {
    const wire = players.filter(p => !p.mine)[0], mine = players.filter(p => p.mine && p.slot === 'BN')[0];
    const html = `<div class="Bdr"><span class="Fz-xl">Pending Transactions</span><div class="notes-module"><a class="D-b"><div class="Fz-xs Bfc">Waiver 1 (Oct 14): <span class="Fw-b">Add</span> ${wire.name}, Drop ${mine.name}<div class="Absolute"><span>View Details</span></div></div></a></div></div>`;
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace('</body>', html + '</body>') : b) });
    await waitForBoard(page);
    const got = await page.evaluate(() => { const n = window.__FF_TEST__.api; return n.getPending(); });
    assert.deepEqual(got.adds.map(x => x.name), [wire.name]);
    assert.deepEqual(got.drops.map(x => x.name), [mine.name]);
    await context.close();
  });

  it('a suggested drop that is already pending is flagged too', async () => {
    const mine = players.filter(p => p.mine).map(p => [p.name, 'Drop']);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withPending(mine) });
    await waitForBoard(page);
    assert.match(await verdict(page), /^ALREADY PENDING.*pending drop/, await verdict(page));
    await context.close();
  });

  it('marks the players on your roster who are in a pending drop', async () => {
    const html = `<div class="Bdr"><span class="Fz-xl">Pending Transactions</span><div class="notes-module"><a class="D-b"><div class="Fz-xs Bfc">Waiver 2 (Oct 14): Add Seahawks, Drop Ravens</div></a></div></div>`;
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace('</body>', html + '</body>') : b) });
    await waitForBoard(page);
    assert.match(await page.locator('.ff-card', { hasText: 'Ravens' }).innerText(), /PENDING DROP/);
    assert.doesNotMatch(await page.locator('.ff-card', { hasText: 'Joe Burrow' }).innerText(), /PENDING DROP/);
    await context.close();
  });

  it('with nothing pending, verdicts are unchanged and no warning shows', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    assert.doesNotMatch(await verdict(page), /ALREADY PENDING/);
    assert.equal((await page.locator('#ff-health').innerText()).trim(), '');
    await context.close();
  });
});

describe('bye week this week', () => {
  const week6 = (url, b) => (/\/players/.test(url) ? b.replaceAll('Week 5 (proj)', 'Week 6 (proj)') : b);

  it('warns about starters on bye this week, and says when there is no cover on your bench', async () => {
    const { page, context } = await openBoard(browser, { pos: 'QB', mutate: week6 });
    await waitForBoard(page);
    const alert = await page.locator('.ff-verdict').first().innerText();
    assert.match(alert, /On bye this week:.*Joe Burrow/);
    assert.match(alert, /Joe Burrow: no healthy QB on your bench/);
    assert.match(await page.locator('.ff-card', { hasText: 'Joe Burrow' }).innerText(), /BYE THIS WEEK/);
    await context.close();
  });

  it('never offers up the only bench player who covers a bye this week (but may when another healthy one exists)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const P = (id, pos, slot, bye, out = 0) => ({ id, pos, slot, bye, out });
    const only = [P('a', 'WR', 'WR', 6), P('b', 'WR', 'BN', 9)];
    assert.equal(await page.evaluate(([pl]) => window.__FF_TEST__.api.coversBye(pl, 6, pl[1]), [only]), true);
    const two = [...only, P('c', 'WR', 'BN', 10)];
    assert.equal(await page.evaluate(([pl]) => window.__FF_TEST__.api.coversBye(pl, 6, pl[1]), [two]), false, 'a second healthy bench WR exists');
    const hurt = [P('a', 'WR', 'WR', 6), P('b', 'WR', 'BN', 9, 2)];
    assert.equal(await page.evaluate(([pl]) => window.__FF_TEST__.api.coversBye(pl, 6, pl[1]), [hurt]), false, 'an injured player covers nothing');
    await context.close();
  });

  it('with your only QB on bye and no bench QB, adding one is recommended even over a bench player with a track record', async () => {
    const { page, context } = await openBoard(browser, { pos: 'QB', mutate: week6 });
    await waitForBoard(page);
    const v = await page.locator('.ff-verdict').nth(1).innerText();
    assert.match(v, /^ADD /, v);
    assert.match(v, /bye/i);
    await context.close();
  });
});

describe('defense names', () => {
  it('matches the city on your roster to the nickname in a pending claim, and leaves other names alone', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const key = n => page.evaluate(x => window.__FF_TEST__.api.nameKey(x), n);
    assert.equal(await key('Chicago'), await key('Bears'));
    assert.equal(await key('Seattle'), await key('Seahawks'));
    assert.equal(await key('New York Giants'), await key('NY Giants'));
    assert.equal(await key('Los Angeles Rams'), await key('Rams'));
    assert.equal(await key('San Francisco'), await key('49ers'));
    assert.notEqual(await key('Chicago'), await key('Seahawks'));
    assert.equal(await key('Kirk Cousins'), await key('kirk cousins'));
    await context.close();
  });
});
