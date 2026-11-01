import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { LEAGUE_ID, TEAM_ID, yahooResponse, sleeperPlayers, sleeperTrending, listPage } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTENT_JS = fs.readFileSync(path.join(ROOT, 'extension', 'content.js'), 'utf8');
export const teamUrl = (path = '6') => `https://football.fantasysports.yahoo.com/f1/${LEAGUE_ID}/${path}`;
export const listUrl = (pos = 'WR') => `https://football.fantasysports.yahoo.com/f1/${LEAGUE_ID}/players?status=A&pos=${pos}&cut_type=33&stat1=S_PW_5&myteam=1&sort=PR&sdir=1`;

export const launch = () => chromium.launch({ channel: 'chrome', headless: true });

/**
 * Opens a Yahoo list page in a fresh browser context where every network call is answered by the offline mocks.
 * opts: { pos, gapMs, snapDelayMs, deny: (url) => boolean (403), failStatus: (url) => status code or 0, delayMs, load: false (do not inject the script), sync: true (tray choices also change Yahoo's list) }
 */
export async function openBoard(browser, opts = {}) {
  const context = opts.context || await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const stats = { yahoo: [], sleeper: [], blockedExternal: [], inflight: 0, maxInflight: 0, deniedCount: 0 };
  await context.route('**/*', async route => {
    const url = route.request().url(), host = new URL(url).host;
    if (host === 'football.fantasysports.yahoo.com') {
      stats.inflight++; stats.maxInflight = Math.max(stats.maxInflight, stats.inflight);
      stats.yahoo.push({ url, t: Date.now(), type: route.request().resourceType() });
      await new Promise(r => setTimeout(r, opts.delayMs ?? 8));
      stats.inflight--;
      stats.methods = (stats.methods || []).concat(route.request().method() + ' ' + new URL(url).pathname.replace(/^\/f1\/\d+/, '/f1/LEAGUE'));
      const failCode = opts.failStatus ? opts.failStatus(url) : 0;     // simulate Yahoo answering with some other status (999, 500...)
      if (failCode) return route.fulfill({ status: failCode, contentType: 'text/html', body: 'error' });
      if (opts.deny && opts.deny(url)) { stats.deniedCount++; return route.fulfill({ status: 403, contentType: 'text/html', body: 'Request denied' }); }
      let res = yahooResponse(url);
      if (new URL(url).pathname.endsWith('/playersearch') && route.request().method() === 'POST') {   // Yahoo's own name search
        const name = new URLSearchParams(route.request().postData() || '').get('search');
        stats.searches = (stats.searches || []).concat(name);
        res = { type: 'text/html', body: listPage({ name, stat: 'S_PW_5' }) };
      }
      if (res && opts.mutate) res.body = opts.mutate(url, res.body);   // simulate Yahoo changing its page layout
      return res ? route.fulfill({ status: 200, contentType: res.type, body: res.body }) : route.fulfill({ status: 404, body: 'not in the mock' });
    }
    if (host === 'api.sleeper.app') {
      stats.sleeper.push(url);
      const body = url.includes('/trending/') ? sleeperTrending(url.includes('/trending/add') ? 'add' : 'drop') : sleeperPlayers();
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
    }
    stats.blockedExternal.push(url);          // nothing else may leave the browser
    return route.abort();
  });
  await page.addInitScript(({ gapMs, snapDelayMs, sync, slots, league, team, firstVisit }) => {
    window.__FF_TEST__ = { gapMs, snapDelayMs };
    try { if (slots) localStorage.setItem('ff:slots:' + league, JSON.stringify(slots)); } catch (e) { /* ignore */ }   // as if the league settings page had been read
    try {   // as if the league had been visited before; firstVisit skips this
      if (!firstVisit && !sessionStorage.getItem('ff:seeded')) { sessionStorage.setItem('ff:seeded', '1'); localStorage.setItem('ff:team:' + league, team); localStorage.setItem('ff:cfg:' + league, JSON.stringify({ name: 'Test League', playoffStart: 15, rec: 0, t: Date.now() })); }
    } catch (e) { /* ignore */ }
    try { if (!localStorage.getItem('ff:ui')) localStorage.setItem('ff:ui', JSON.stringify({ w: 560, open: true, sync })); } catch (e) { /* ignore */ }   // page-reloading sync is off unless a test asks for it
  }, { gapMs: opts.gapMs ?? 5, snapDelayMs: opts.snapDelayMs ?? 60000, sync: !!opts.sync, slots: opts.slots || null, league: LEAGUE_ID, team: TEAM_ID, firstVisit: !!opts.firstVisit });
  await page.goto(opts.url || listUrl(opts.pos || 'WR'));
  if (opts.load !== false) await page.addScriptTag({ content: CONTENT_JS });
  return { page, context, stats };
}

export const waitForBoard = async (page, { radar = true, timeout = 30000 } = {}) => {
  await page.waitForSelector('.ff-board', { timeout });
  if (radar) await page.waitForSelector('.ff-cand', { timeout });
  if (radar) await page.waitForFunction(() => !document.querySelector('.ff-notes-pending'), null, { timeout });
};
export const waitIdle = (page, ms = 600) => page.waitForTimeout(ms);
export const api = (page, fn, ...args) => page.evaluate(([f, a]) => window.__FF_TEST__.api[f](...a), [fn, args]);
