import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, CONTENT_JS } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

// every note the board reads gets one extra sentence naming a free player (Darius Cooper) and one of yours (Terry McLaurin)
const withNews = who => (url, b) => (/playernote/.test(url)
  ? b.replace('caught two of three targets', `caught two of three targets. While Tyquan Thornton is out, ${who} will handle more reps. He also`)
  : b);
const banner = page => page.locator('.ff-news');

describe('per-league role news alert', () => {
  it('a free player named for more work in a recent note shows at the top of the tray, with the sentence', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: withNews('Darius Cooper') });
    await waitForBoard(page);
    await banner(page).waitFor({ timeout: 30000 });
    const t = await banner(page).innerText();
    assert.match(t, /Role news: free in/i);
    assert.match(t, /Darius Cooper \(WR, PHI\) is named for "more reps"/);
    assert.match(t, /While Tyquan Thornton is out, Darius Cooper will handle more reps/);
    assert.doesNotMatch(t, /Tyquan Thornton \(/, 'the injured player is not the news');
    await context.close();
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
    await banner(page).waitFor({ timeout: 30000 });
    await banner(page).getByText('Got it').click();
    assert.equal(await banner(page).count(), 0);
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(page); await page.waitForTimeout(1500);
    assert.equal(await banner(page).count(), 0, 'not shown again');
    await context.close();
  });
});
