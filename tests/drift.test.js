import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const health = page => page.locator('#ff-health').innerText();
const verdictText = page => page.locator('.ff-verdict').first().innerText();

// Each case changes one thing about Yahoo's pages, as if Yahoo redesigned it, and checks that the board says so.
const only = (re, fn) => (url, body) => (re.test(url) ? fn(body) : body);

describe('layout drift: the board must say so instead of guessing', () => {
  it('baseline: untouched pages show no warning', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', snapDelayMs: 100 });
    await waitForBoard(page); await waitIdle(page, 1500);
    assert.equal((await health(page)).trim(), '');
    await context.close();
  });

  const critical = [
    ['the "Roster Status" column is renamed', /players/, b => b.replaceAll('Roster Status', 'Status'), /Roster Status/],
    ['the "Fan Pts" column is renamed', /players/, b => b.replaceAll('Fan Pts', 'Points'), /Fan Pts/],
    ['the "% Ros" column is renamed', /players/, b => b.replaceAll('% Ros', 'Own %'), /% Ros/],
  ];
  for (const [name, re, fn, expect] of critical) {
    it(`${name}: a clear banner, and no ADD recommendation`, async () => {
      const { page, context } = await openBoard(browser, { pos: 'WR', mutate: only(re, fn) });
      await page.waitForSelector('#ff-health.bad', { timeout: 30000 });
      assert.match(await health(page), expect);
      assert.match(await health(page), /Do not rely/);
      if (await page.locator('.ff-verdict').count()) assert.doesNotMatch(await verdictText(page), /^ADD /);
      await context.close();
    });
  }

  it('your team page tables are renamed: says the roster could not be read (not a cryptic error)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: (url, b) => (/\/f1\/\d+\/6(\?|$)/.test(url) ? b.replaceAll('statTable', 'tbl') : b) });
    await page.waitForSelector('#ff-health.bad', { timeout: 30000 });
    const t = await health(page);
    assert.match(t, /team page/i);
    assert.doesNotMatch(t, /reading 'data'/);
    await context.close();
  });

  it('player notes change format: warns that injury news is missing (Sleeper tags still used)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: only(/playernote/, b => b.replaceAll('noteitem', 'n-item')) });
    await waitForBoard(page);
    await page.locator('.ff-cand').nth(2).click();
    await page.waitForSelector('#ff-health.warn, #ff-health.bad', { timeout: 30000 });
    assert.match(await health(page), /notes could not be read/i);
    await context.close();
  });

  it('transactions markup changes: warns that trends are incomplete', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', snapDelayMs: 100, mutate: only(/transactions/, b => b.replaceAll('/players/', '/p/').replaceAll('Pbot-xs', 'x')) });
    await waitForBoard(page);
    await page.waitForSelector('#ff-health.warn', { timeout: 30000 });
    assert.match(await health(page), /transactions page/i);
    await context.close();
  });

  it('a layout warning is never cached: the next load checks again', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: only(/players/, b => b.replaceAll('Fan Pts', 'Points')) });
    await page.waitForSelector('#ff-health.bad', { timeout: 30000 });
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => /^ffc\d*:.*stat1=S_/.test(k) && !/count=/.test(k)).length), 0);
    await context.close();
  });

  it('a sorted column (Yahoo adds an icon glyph to its header) is not mistaken for a layout change', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: only(/players/, b => b.replaceAll('Fan Pts', 'Fan Pts\uE002').replaceAll('% Ros', '% Ros\uE002')) });
    await waitForBoard(page); await waitIdle(page, 1000);
    assert.equal((await health(page)).trim(), '');
    assert.doesNotMatch(await page.locator('.ff-verdict').first().innerText(), /NO RECOMMENDATION/);
    await context.close();
  });
});
