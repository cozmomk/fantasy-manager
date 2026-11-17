import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, teamUrl, CONTENT_JS } from './helpers.js';
import { TEAM_ID } from './fixtures.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

// every note the board reads gets one extra sentence naming a free player (Darius Cooper) and one of yours (Terry McLaurin)
const withNews = who => (url, b) => (/playernote/.test(url)
  ? b.replace('caught two of three targets', `caught two of three targets. While Tyquan Thornton is out, ${who} will handle more reps. He also`)
  : b);
const banner = page => page.locator('.ff-news');
// role news sits in the collapsed "Opportunities" strip under the tabs: open it, then read the banner
const openNews = async page => {
  await page.locator('.ff-opp > .ff-more').waitFor({ timeout: 30000 });
  if (await page.locator('.ff-opp > .ff-more').getAttribute('aria-expanded') !== 'true') await page.locator('.ff-opp > .ff-more').click();
  await banner(page).first().waitFor({ timeout: 30000 });
};

describe('per-league role news alert', () => {
  it('a free player named for more work in a recent note shows at the top of the tray, with the sentence', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withNews('Darius Cooper') });
    await waitForBoard(page);
    await openNews(page);
    const t = await banner(page).innerText();
    assert.match(t, /Role news: free in/i);
    assert.match(await page.locator('.ff-opp > .ff-more').innerText(), /Opportunities · 1/);
    assert.match(t, /Darius Cooper \(WR, PHI\) is named for "more reps"/);
    assert.match(t, /While Tyquan Thornton is out, Darius Cooper will handle more reps/);
    assert.match(t, /Room: (open bench spot|move \S.* to IR first|drop \S.* \(|no safe drop right now)/, 'the alert says where he would go');
    assert.doesNotMatch(t, /Tyquan Thornton \(/, 'the injured player is not the news');
    await context.close();
  });

  it('on your team page, with no fresh free-agent list, the news reads that position\'s list once and still shows', async () => {
    const { page, context, stats } = await openBoard(browser, { url: teamUrl(TEAM_ID), mutate: withNews('Darius Cooper') });
    await waitForBoard(page, { radar: false });
    await openNews(page);
    assert.match(await banner(page).innerText(), /Darius Cooper \(WR, PHI\) is named for "more reps"/);
    const lists = stats.yahoo.map(r => r.url).filter(u => /status=A/.test(u) && /pos=WR/.test(u) && /S_S_2026/.test(u));
    assert.ok(lists.length >= 1 && lists.length <= 2, 'one free WR list read for the news (the snapshot may reuse it): ' + lists.length);
    await context.close();
  });

  it('a free-agent page saved long ago does not make a since-claimed player look free', async () => {
    // Darius Cooper is gone from today's lists (claimed); only an old Transaction Trends page still lists him
    const claimed = (url, b) => withNews('Darius Cooper')(url, /\/players\?/.test(url) ? b.replace(/<tr>(?:(?!<tr>).)*?Darius Cooper.*?<\/tr>/g, '') : b);
    const run = async ageHours => {
      const context = await browser.newContext();
      await context.addInitScript(t => { localStorage.setItem('ffc3:buzz:111111:WR:old', JSON.stringify({ t, d: [{ name: 'Darius Cooper' }] })); }, Date.now() - ageHours * 3600000);
      const { page } = await openBoard(browser, { pos: 'WR', mutate: claimed, context });
      await waitForBoard(page);
      await page.waitForTimeout(1500);
      const n = await banner(page).count();
      await context.close();
      return n;
    };
    assert.equal(await run(48), 0, 'a two-day-old page is not trusted');
    assert.equal(await run(1), 1, 'an hour-old page still counts');
  });

  it('a player already on your roster is not announced', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withNews('Terry McLaurin') });
    await waitForBoard(page);
    await page.waitForTimeout(1500);
    assert.equal(await banner(page).count(), 0);
    await context.close();
  });

  it('"Got it" dismisses the alert, and it stays dismissed after a reload', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withNews('Darius Cooper') });
    await waitForBoard(page);
    await openNews(page);
    await banner(page).getByText('Got it').click();
    assert.equal(await banner(page).count(), 0);
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(page); await page.waitForTimeout(1500);
    assert.equal(await banner(page).count(), 0, 'not shown again');
    await context.close();
  });
});
