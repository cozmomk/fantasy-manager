import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, teamUrl, CONTENT_JS } from './helpers.js';
import { players, LEAGUE_ID, TEAM_ID } from './fixtures.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const P = (id, pos, slot, avg, o = {}) => ({ id, name: id, pos, slot, bye: 99, out: 0, injTag: '',
  m: { played: 4, good: o.good ?? 2, avg, form: o.form ?? avg, adp: NaN, trendKnown: false, start: { v: 0, d: 0 }, thr: 8, ...(o.m || {}) }, ...(o.p || {}) });
const lineup = (page, players, week = 6) => page.evaluate(([pl, w]) => { const r = window.__FF_TEST__.api.computeLineup(pl, w); return { fixes: r.fixes.map(f => [f.slot, f.sit.id, f.start && f.start.id, f.why]), swaps: r.swaps.map(s => [s.slot, s.sit.id, s.start.id]), q: r.questionable.map(x => x.id) }; }, [players, week]);
const week6 = (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace('</body>', '<div>Week 6: Oct 13 - Oct 19</div></body>') : b);

describe('start / sit rules (pure)', () => {
  let page, context;
  before(async () => { ({ page, context } = await openBoard(browser, { pos: 'WR' })); await waitForBoard(page); });
  after(async () => { await context.close(); });

  it('starts a bench player who is clearly better, but not for a mild edge', async () => {
    const r1 = await lineup(page, [P('s', 'WR', 'WR', 8), P('b', 'WR', 'BN', 12, { good: 3 })]);
    assert.deepEqual(r1.swaps, [['WR', 's', 'b']]);
    const r2 = await lineup(page, [P('s', 'WR', 'WR', 10), P('b', 'WR', 'BN', 11, { good: 3 })]);
    assert.deepEqual(r2.swaps, [], 'a 10% edge is not enough');
    const r3 = await lineup(page, [P('s', 'WR', 'WR', 9), P('b', 'WR', 'BN', 10.5)]);
    assert.deepEqual(r3.swaps, [], 'under 2 points is not enough');
  });
  it('a proven starter is only benched for a clearly better record or a big gap', async () => {
    const proven = { good: 4, m: { good: 4 } };
    const r1 = await lineup(page, [P('s', 'WR', 'WR', 10, proven), P('b', 'WR', 'BN', 12, { good: 4 })]);
    assert.deepEqual(r1.swaps, [], 'same record, modest gap: keep the proven starter');
    const r2 = await lineup(page, [P('s', 'WR', 'WR', 10, proven), P('b', 'WR', 'BN', 14, { good: 4 })]);
    assert.deepEqual(r2.swaps, [['WR', 's', 'b']], 'a 40% gap is big enough');
  });
  it('a starter on bye or out must be replaced by the best eligible healthy bench player, including at flex', async () => {
    const r = await lineup(page, [P('qb', 'QB', 'QB', 20, { p: { bye: 6 } }), P('wr', 'WR', 'W/R/T', 9, { p: { out: 1 } }),
      P('rb', 'RB', 'BN', 11), P('te', 'TE', 'BN', 7), P('qb2', 'QB', 'BN', 15, { p: { bye: 6 } })]);
    assert.deepEqual(r.fixes, [['QB', 'qb', null, 'on bye this week'], ['W/R/T', 'wr', 'rb', 'out this week']]);
  });
  it('never starts a bench player who is out, on bye or on IR, and never uses one bench player twice', async () => {
    const r = await lineup(page, [P('a', 'RB', 'RB', 8, { p: { out: 2 } }), P('b', 'WR', 'W/R/T', 8, { p: { out: 2 } }),
      P('x', 'RB', 'BN', 14), P('y', 'RB', 'BN', 9, { p: { out: 1 } }), P('z', 'RB', 'IR', 18)]);
    assert.deepEqual(r.fixes.map(f => f[2]), ['x', null]);
  });
  it('ignores players without scoring data (kickers and defenses not loaded) and flags Questionable starters', async () => {
    const nodata = await lineup(page, [P('k', 'K', 'K', NaN), P('k2', 'K', 'BN', NaN)]);
    assert.deepEqual(nodata.swaps, []);
    const q = await lineup(page, [P('s', 'RB', 'RB', 10, { p: { injTag: 'Q' } })]);
    assert.deepEqual(q.q, ['s']);
  });
});

describe('empty starting slots', () => {
  it('flags a slot with nobody in it (a dropped kicker), fills it from the bench if possible, and points to the wire if not', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const run = (pl) => page.evaluate(([x]) => { const r = window.__FF_TEST__.api.computeLineup(x, 6, { QB: 1, K: 1 }); return r.fixes.map(f => [f.slot, f.sit && f.sit.id, f.start && f.start.id, f.why]); }, [pl]);
    assert.deepEqual(await run([P('qb', 'QB', 'QB', 20)]), [['K', null, null, 'empty']]);
    assert.deepEqual(await run([P('qb', 'QB', 'QB', 20), P('k', 'K', 'BN', 9)]), [['K', null, 'k', 'empty']]);
    assert.deepEqual(await run([P('qb', 'QB', 'QB', 20), P('k', 'K', 'K', 9)]), []);
    await context.close();
  });
  it('on the team page, a missing kicker shows as an empty slot with a wire button', async () => {
    const noKicker = (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Evan McPherson[\s\S]*?<\/tr>/, '') : b);
    const { page, context } = await openBoard(browser, { url: teamUrl('6'), mutate: noKicker });
    await page.waitForSelector('.ff-board');
    await waitIdle(page, 600);
    const t = await page.locator('.ff-board').innerText();
    assert.match(t, /your K slot is empty/i);
    assert.match(t, /EMPTY SLOT/i);
    assert.match(t, /K\s+EMPTY\s+(0\s+)?nobody in the slot/i, 'the lineup table lists the gap');
    await page.getByText('Find a free-agent K').waitFor();
    await context.close();
  });
});

describe('season-ending injuries: drop him, do not spend the IR slot', () => {
  it('a note saying season-ending (or back after the playoffs) rules out IR and makes him the first drop', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const r = await page.evaluate(() => {
      const api = window.__FF_TEST__.api;
      const mk = (id, text) => ({ id, name: id, pos: 'WR', slot: 'BN', out: 2, injTag: 'IR', bye: 99, note: text ? { date: 'Yesterday', text } : null, m: { played: 3, good: 1, avg: 6, form: 5, thr: 8, adp: 20, trendKnown: false, start: { v: 0, d: 0 } } });
      const done = mk('done', 'The Commanders placed McLaurin (knee) on injured reserve. Advice: a torn patellar tendon that will require season-ending surgery.');
      const late = mk('late', 'He is expected to miss 12-16 weeks.');
      const back = mk('back', 'He is expected to miss 4-6 weeks with a hamstring strain.');
      const healthy = { ...mk('ok', null), out: 0, injTag: '', m: { played: 4, good: 0, avg: 2, form: 2, thr: 8, adp: NaN, trendKnown: false, start: { v: 0, d: 0 } } };
      const R = pl => ({ players: pl, irFree: 1, week: 8 });
      return {
        doneSeason: api.seasonDone(done, 8), lateSeason: api.seasonDone(late, 8), backSeason: api.seasonDone(back, 8),
        irDone: api.irOption(R([done, healthy]))?.id ?? null, irBack: api.irOption(R([done, back, healthy]))?.id ?? null,
        drop: api.suggestReplace(R([healthy, done]))?.id ?? null,
      };
    });
    assert.deepEqual([r.doneSeason, r.lateSeason, r.backSeason], [true, true, false]);
    assert.equal(r.irDone, null, 'no IR suggestion for a season-ending injury');
    assert.equal(r.irBack, 'back', 'a player who will return still gets the IR suggestion');
    assert.equal(r.drop, 'done', 'he is the first drop, ahead of a healthy weak player');
    await context.close();
  });
});

describe('weeks he missed are not bad games', () => {
  it('a week listed with GP "-" and 0.00 points (out injured) counts as not played; a real zero still counts', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const m = await page.evaluate(() => {
      const row = (gp, pts) => ({ 'GP*': gp, 'Fan Pts': pts, 'Att*': gp === '-' ? '-' : '15', 'Tgt*': gp === '-' ? '-' : '2' });
      const data = { weekNums: [4, 5, 6, 7], research: {}, weekly: { 4: { x: row('-', '0.00') }, 5: { x: row('-', '0.00') }, 6: { x: row('-', '–') }, 7: { x: row('1', '6.80') } } };
      const a = window.__FF_TEST__.api.metrics('x', 'RB', data, false);
      const dud = { ...data, weekly: { ...data.weekly, 5: { x: row('1', '0.00') } } };
      const b = window.__FF_TEST__.api.metrics('x', 'RB', dud, false);
      return { played: a.played, avg: a.avg, form: a.form, oppAvg: a.oppAvg, playedB: b.played, avgB: b.avg };
    });
    assert.equal(m.played, 1, 'only week 7 was a game');
    assert.equal(m.avg, 6.8);
    assert.equal(m.form, 6.8);
    assert.equal(m.oppAvg, 17);
    assert.equal(m.playedB, 2, 'a game he played and scored 0 in is still a game');
    assert.equal(m.avgB, 3.4);
    await context.close();
  });
});

describe('second QB / TE: insurance once the top one\'s bye is done', () => {
  let page, context;
  before(async () => { ({ page, context } = await openBoard(browser, { pos: 'WR' })); await waitForBoard(page); });
  after(async () => { await context.close(); });
  const spare = (pl, id, week) => page.evaluate(([pl, id, w]) => { const r = window.__FF_TEST__.api.surplusStarter(pl, w, pl.find(p => p.id === id)); return r ? r.id : null; }, [pl, id, week]);
  const goff = P('goff', 'QB', 'QB', 24, { p: { bye: 6 } }), cousins = P('cousins', 'QB', 'BN', 20, { p: { bye: 13 } });
  it('a bench QB behind a starter whose bye is past is backup only; the starter is not', async () => {
    assert.equal(await spare([goff, cousins], 'cousins', 7), 'goff');
    assert.equal(await spare([goff, cousins], 'goff', 7), null);
  });
  it('still needed while the starter\'s bye is ahead, or the starter is hurt', async () => {
    assert.equal(await spare([goff, cousins], 'cousins', 5), null);
    assert.equal(await spare([{ ...goff, injTag: 'Q' }, cousins], 'cousins', 7), null);
  });
  it('judged on who is better, not who sits in the slot: a weaker QB starting ahead of a better one is the spare', async () => {
    const burrow = P('burrow', 'QB', 'BN', 23, { p: { bye: 6 } }), kc = P('cousins', 'QB', 'QB', 20, { p: { bye: 13 } });
    assert.equal(await spare([kc, burrow], 'cousins', 7), 'burrow');
    assert.equal(await spare([kc, burrow], 'burrow', 7), null);
  });
  it('a second TE at flex is flagged only once the top TE\'s bye is done', async () => {
    const mcb = P('mcbride', 'TE', 'W/R/T', 8, { p: { bye: 14 } });
    assert.equal(await spare([P('bowers', 'TE', 'TE', 12, { p: { bye: 13 } }), mcb], 'mcbride', 7), null);
    assert.equal(await spare([P('bowers', 'TE', 'TE', 12, { p: { bye: 5 } }), mcb], 'mcbride', 7), 'bowers');
  });
  it('an injured TE on IR is never called a spare', async () => {
    assert.equal(await spare([P('higbee', 'TE', 'TE', 9, { p: { bye: 5 } }), P('warren', 'TE', 'IR', 11, { p: { bye: 13 } })], 'warren', 7), null);
  });
});

describe('lineup tab on your team and matchup pages', () => {
  it('opens first on your team page, loads K/DEF stats, and never scans the wire', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl('6') });
    await page.waitForSelector('.ff-board');
    await waitIdle(page, 800);
    assert.match(await page.locator('.ff-tabbtn.on').first().innerText(), /Lineup/);
    assert.match(await page.locator('.ff-board').innerText(), /Your lineup/i);
    const fetches = stats.yahoo.filter(r => r.type !== 'document');
    assert.ok(fetches.length <= 20, `${fetches.length} requests on the team page`);
    assert.ok(fetches.every(r => !/S_S_2026|status=A/.test(r.url)), 'no free-agent scan on the team page');
    await context.close();
  });

  it('M and L add Yahoo\'s projection, the game and % started; S and Side keep the narrow table', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('6'), mutate: week6 });
    await page.waitForSelector('.ff-lineup');
    await waitIdle(page, 600);
    const heads = () => page.locator('.ff-lineup th').evaluateAll(th => th.filter(x => x.offsetParent).map(x => x.textContent));
    const size = async l => { await page.locator('#ff-head .sz', { hasText: new RegExp('^' + l + '$') }).click(); return heads(); };
    assert.deepEqual(await size('M'), ['Slot', 'Player', 'Proj', 'Recent scoring', 'Status']);
    assert.deepEqual(await size('L'), ['Slot', 'Player', 'Proj', 'Recent scoring', '% Start', 'Status']);
    const t = await page.locator('.ff-lineup').innerText();
    assert.match(t, /Sun 1:00 pm (vs|@) Kc/, 'the game is shown');
    assert.match(t, /Total\s+Starters, Yahoo projection\s+\d+\.\d/, 'starters total');
    assert.match(t, /\d+%/, '% started');
    assert.match(t, /Joe Burrow \(QB\)\s+Bye\s+-/, 'a bye row (Yahoo spans one "Bye" cell over three columns) has no projection, not his % Start');
    assert.deepEqual(await size('S'), ['Slot', 'Player', 'Recent scoring', 'Status']);
    assert.deepEqual(await size('Side'), ['Slot', 'Player', 'Recent scoring', 'Status']);
    await context.close();
  });

  it('week 6: shows who is on bye, the bench player to start, and when nobody can fill a slot', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('6'), mutate: week6 });
    await page.waitForSelector('.ff-board');
    await waitIdle(page, 600);
    const t = await page.locator('.ff-board').innerText();
    assert.match(t, /FIX YOUR LINEUP/);
    assert.match(t, /Joe Burrow on bye this week/);
    assert.match(t, /START: Terry McLaurin \(WR\)/);
    assert.match(t, /No bench player can play QB/);
    await page.getByText('Find a free-agent QB').click();
    await page.waitForFunction(() => /BEST AVAILABLE QB/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
    await context.close();
  });

  it('with an open IR slot, a QB fill suggests moving the injured bench player to IR instead of dropping anyone', async () => {
    const brooks = players.find(p => p.id === '10'), saved = brooks.slot;
    brooks.slot = 'BN';                                       // free the IR slot (Coleman is also an out player on the bench)
    try {
      const { page, context } = await openBoard(browser, { url: teamUrl('6'), mutate: week6 });
      await page.waitForSelector('.ff-board');
      await waitIdle(page, 600);
      const t = await page.locator('.ff-board').innerText();
      assert.match(t, /Free option: move .* to your open IR slot/);
      await page.getByText('Compare a QB using the IR slot').click();
      await page.waitForFunction(() => /BEST AVAILABLE QB/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-cand').length > 0, null, { timeout: 30000 });
      assert.match(await page.locator('.ff-cmp').first().innerText(), /nobody is being dropped/);
      await context.close();
    } finally { brooks.slot = saved; }
  });

  it('a Sleeper "Out" does not override a current Yahoo "Questionable" (Sleeper lags)', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('6') });
    await page.waitForSelector('.ff-board');
    await waitIdle(page, 600);
    const row = await page.locator('.ff-board tr', { hasText: 'Jalen Coker' }).first().innerText();
    assert.match(row, /Questionable|on bye/, row);
    assert.doesNotMatch(row, /out this week|out for a long/, row);
    await context.close();
  });

  it('works on the matchup page and reads the week from its header', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('matchup') });
    await page.waitForSelector('.ff-board');
    assert.match(await page.locator('.ff-board').innerText(), /Week 5 start \/ sit/i);
    await context.close();
  });

  it('re-reads your roster when Yahoo changes it in place (no stale "fix your lineup")', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl('6'), mutate: week6 });
    await page.waitForSelector('.ff-lineup');
    await waitIdle(page, 600);
    assert.match(await page.locator('.ff-board .ff-verdict').first().innerText(), /Joe Burrow on bye/);
    const before = stats.yahoo.length;
    await page.evaluate(() => {                 // you move Burrow to the bench on Yahoo's page; Yahoo saves it without a reload
      const r = [...document.querySelectorAll('#statTable0 tr')].find(x => /Joe Burrow/.test(x.textContent));
      r.cells[0].textContent = 'BN';
    });
    await page.waitForFunction(() => !/Joe Burrow on bye/.test(document.querySelector('.ff-board .ff-verdict')?.innerText || ''), null, { timeout: 15000 });
    assert.match(await page.locator('.ff-board .ff-verdict').first().innerText(), /QB slot is empty/);
    assert.equal(stats.yahoo.filter((r, i) => i >= before && /\/f1\/\d+\/6(\?|$)/.test(r.url)).length, 0, 'the team page itself is read, not fetched again');
    await context.close();
  });

  it('also opens on the league home page, reading the week from its matchups box', async () => {
    const { page, context } = await openBoard(browser, { url: teamUrl('').replace(/\/$/, '') });
    await page.waitForSelector('.ff-board');
    await waitIdle(page, 600);
    assert.match(await page.locator('.ff-tabbtn.on').first().innerText(), /Lineup/);
    assert.match(await page.locator('.ff-board').innerText(), /Week 6 start \/ sit/i);
    await context.close();
  });

  it('does nothing on other teams\' pages or unrelated Yahoo pages', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl('9') });
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#ff-tray').count(), 0);
    assert.equal(stats.yahoo.filter(r => r.type !== 'document').length, 0);
    await context.close();
  });
});

describe('any league you belong to', () => {
  it('finds your team from the My Team link, and reads the league settings once', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl(TEAM_ID), firstVisit: true, load: false });
    await page.evaluate(([l, t]) => document.body.insertAdjacentHTML('afterbegin', `<a href="/f1/${l}/${t}">My Team</a>`), [LEAGUE_ID, TEAM_ID]);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForFunction(() => window.__FF_TEST__.api);
    await page.waitForSelector('#ff-tray', { state: 'attached' });
    await waitIdle(page);
    assert.equal(await page.evaluate(k => localStorage.getItem(k), 'ff:team:' + LEAGUE_ID), TEAM_ID);
    const { t, ...cfg } = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), 'ff:cfg:' + LEAGUE_ID);
    assert.deepEqual(cfg, { name: 'Friend League', playoffStart: 16, rec: 0.5, passTd: 6, unknown: ['DL'] });
    assert.ok(t > 0);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k))['Q/W/R/T'], 'ff:slots:' + LEAGUE_ID), 1);
    assert.deepEqual(await page.evaluate(() => window.__FF_TEST__.api.GOOD), { QB: 20, RB: 9, WR: 10, TE: 7, K: 7, DEF: 6 });
    assert.equal(stats.methods.filter(m => m === 'GET /f1/LEAGUE/settings').length, 1);
    await context.close();
  });
  it('does nothing in a league with no My Team link and nothing remembered', async () => {
    const { page, context, stats } = await openBoard(browser, { firstVisit: true });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.ffLoaded), undefined);
    assert.equal((stats.methods || []).filter(m => /\/f1\/LEAGUE\/(?!players)/.test(m)).length, 0);
    await context.close();
  });
  it('reads the settings again once they are a week old', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl(TEAM_ID), load: false });
    await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ name: 'Old', playoffStart: 15, rec: 0, t: 1 })), 'ff:cfg:' + LEAGUE_ID);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForSelector('#ff-tray', { state: 'attached' });
    await waitIdle(page);
    assert.equal(stats.methods.filter(m => m === 'GET /f1/LEAGUE/settings').length, 1);
    assert.equal(await page.evaluate(k => JSON.parse(localStorage.getItem(k)).name, 'ff:cfg:' + LEAGUE_ID), 'Friend League');
    await context.close();
  });
});

describe('superflex leagues', () => {
  const slots = { QB: 1, RB: 2, WR: 2, TE: 1, 'W/R/T': 1, 'Q/W/R/T': 1, K: 1, DEF: 1, IR: 1 };
  const openSuper = () => openBoard(browser, { url: teamUrl(TEAM_ID), slots });
  const Q = (id, slot, avg) => P(id, 'QB', slot, avg);

  it('a bench QB can fill the slot, and an empty one asks for a QB', async () => {
    const { page, context } = await openSuper();
    await page.waitForFunction(() => window.__FF_TEST__.api);
    const r = await page.evaluate(([pl, sl]) => {
      const a = window.__FF_TEST__.api, x = a.computeLineup(pl, 6, sl);
      return { fix: x.fixes.map(f => [f.slot, f.start && f.start.id]), need: a.needsOf(pl, 6, sl).map(n => n.pos) };
    }, [[Q('a', 'QB', 20), Q('b', 'BN', 18), P('r', 'RB', 'BN', 6)], slots]);
    assert.deepEqual(r.fix.find(f => f[0] === 'Q/W/R/T'), ['Q/W/R/T', 'b']);
    assert.ok(r.need.includes('QB'));
    await context.close();
  });
  it('your second QB is never spare or the suggested cut', async () => {
    const { page, context } = await openSuper();
    await page.waitForFunction(() => window.__FF_TEST__.api);
    const r = await page.evaluate(pl => {
      const a = window.__FF_TEST__.api;
      return { spare: a.surplusStarter(pl, 8, pl[1]), cut: a.suggestReplace({ players: pl, week: 8, irFree: 0 }).id };
    }, [{ ...Q('a', 'QB', 20), bye: 5 }, { ...Q('b', 'BN', 12), bye: 6 }, P('r', 'RB', 'BN', 9)]);
    assert.equal(r.spare, null);
    assert.equal(r.cut, 'r');
    await context.close();
  });
});
