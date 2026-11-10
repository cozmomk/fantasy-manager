import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, openBoard, waitForBoard, waitIdle, api, CONTENT_JS } from './helpers.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

const openTrends = async (page, ms = 2500) => {
  await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.ff-board table.ff-cmp tr').length > 3 && !/reading note/.test(document.querySelector('.ff-board').innerText), null, { timeout: 30000 });
  await waitIdle(page, ms);
};

describe('role reader', () => {
  it('spots a player moving into a bigger role, or out of one, from his note', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    const r = t => api(page, 'roleOf', t);
    assert.equal((await r('Stevenson is expected to take on a heavier workload for the next few weeks while Henderson recovers.')).kind, 'up');
    assert.equal((await r('Cooper will step into the lead back role after the trade.')).kind, 'up');
    assert.equal((await r('White lost his starting job and is now in a committee.')).kind, 'down');
    assert.equal(await r('Smith caught two of three targets for 31 yards on Sunday.'), null);
    assert.equal(await r("Worthy finished second on the team in targets and receiving yards behind Tyquan Thornton."), null, '"behind" alone is not a role loss');
    assert.equal(await r('The Giants played from behind after Washington scored.'), null);
    assert.equal((await r('Rodriguez is stuck behind Walker on the depth chart.')).kind, 'down');
    const maybe = await r("If Kamara's back issue continues to linger, Miller could be the Saints' lead back for Week 6.");
    assert.deepEqual([maybe.kind, maybe.maybe], ['up', true], 'a hedged phrase is only a possible role change');
    assert.equal((await r('Stevenson is expected to take on a heavier workload while Henderson recovers.')).maybe, false);
    assert.equal((await r('Wilson has taken advantage of a larger workload with Smith sidelined.')).kind, 'up');
    await context.close();
  });
});

describe('Trends tab', () => {
  it('puts global player trends above your league, drops "most added / dropped", and ranks the Yahoo buzz by net adds', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', snapDelayMs: 100 });
    await waitForBoard(page);
    await page.waitForFunction(() => Object.keys(localStorage).some(k => /^ff:snap:/.test(k)), null, { timeout: 30000 });
    await openTrends(page);
    const h3 = await page.$$eval('.ff-board h3', x => x.map(e => e.innerText.toLowerCase()));
    assert.ok(h3.findIndex(t => /global player trends/.test(t)) >= 0 && h3.findIndex(t => /global player trends/.test(t)) < h3.findIndex(t => /your league/.test(t)), h3.join(' | '));
    const text = await page.locator('.ff-board').innerText();
    assert.doesNotMatch(text, /most added|most dropped/i);
    assert.match(text, /Yahoo adds \/ drops/i);
    const nets = await page.$$eval('.ff-board table.ff-cmp tr', rows => rows.map(r => r.cells[1] && (/([+-]?[\d,]+) net/.exec(r.cells[1].innerText) || [])[1]).filter(Boolean).map(v => +v.replace(/,/g, '')));
    assert.ok(nets.length >= 4, 'buzz rows are listed');
    assert.deepEqual(nets, [...nets].sort((a, b) => b - a), 'sorted by net adds');
    await context.close();
  });

  it('the position buttons filter the buzz list', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR' });
    await waitForBoard(page);
    await openTrends(page);
    await page.locator('.ff-board .ff-tabs').nth(1).getByText('QB', { exact: true }).click();
    const kinds = await page.$$eval('.ff-board table.ff-cmp tr td.lab .nt', x => x.map(e => e.innerText.split(' ')[0]));
    assert.ok(kinds.length > 0 && kinds.every(k => k === 'QB'), kinds.join(','));
    await context.close();
  });

  it('flags a "Role up" from the latest Yahoo note of a buzzing player', async () => {
    const roleNote = (url, b) => (/playernote/.test(url) && /pid=22\b/.test(url) ? b.replace(/caught two of three targets[^"<]*/, 'is expected to take on a heavier workload for the next few weeks') : b);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: roleNote });
    await waitForBoard(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.ff-board tr')].some(r => /Bo Nix/.test(r.innerText) && /Role up/.test(r.innerText)), null, { timeout: 30000 });
    assert.match(await page.locator('.ff-board tr', { hasText: 'Bo Nix' }).first().innerText(), /Role up/);
    await context.close();
  });

  it('opening Trends stays light on Yahoo and a changed Buzz Index layout is reported, not guessed at', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', mutate: (url, b) => (/buzzindex/.test(url) ? b.replaceAll('>Adds<', '>Pickups<') : b) });
    await waitForBoard(page); await waitIdle(page, 600);
    const before = stats.yahoo.filter(r => r.type !== 'document').length;
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForSelector('#ff-health.warn', { timeout: 30000 });
    assert.match(await page.locator('#ff-health').innerText(), /Buzz Index columns changed/);
    assert.ok(stats.yahoo.filter(r => r.type !== 'document').length - before <= 14, 'few extra requests');
    await context.close();
  });

  it('clicking a name in Trends runs Yahoo\'s name search and comes back to the Trends tab', async () => {
    const { page, context, stats } = await openBoard(browser, { pos: 'WR', sync: true });
    await waitForBoard(page);
    await openTrends(page);
    const name = (await page.locator('.ff-board .ff-link').first().innerText()).trim();
    await Promise.all([page.waitForURL(/playersearch/), page.locator('.ff-board .ff-link').first().click()]);
    await page.addScriptTag({ content: CONTENT_JS });
    await page.waitForFunction(() => /global player trends/i.test(document.querySelector('.ff-board')?.innerText || '') && document.querySelectorAll('.ff-board .ff-link').length > 0, null, { timeout: 30000 });
    assert.ok(stats.searches.includes(name), `searched for ${name}`);
    assert.match(await page.locator('.ff-tabbtn.on').first().innerText(), /Trends/);
    await context.close();
  });

  it('finds role news about a player inside SOMEONE ELSE\'s note, and skips the player who is out', async () => {
    const news = (url, b) => (/playernote/.test(url) && /pid=22\b/.test(url)
      ? b.replace(/caught two of three targets[^"<]*/, 'is listed as questionable. While Tyquan Thornton is out, Darius Cooper will handle more reps alongside Kalif Raymond')
      : b);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: news });
    await waitForBoard(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.getByText('Role changes in the news', { exact: false }).first().waitFor({ timeout: 30000 });
    await page.waitForFunction(() => /will handle more reps/.test(document.querySelector('.ff-board')?.innerText || ''), null, { timeout: 30000 });
    const players = await page.$$eval('.ff-board table.ff-cmp', ts => {
      const t = ts.find(x => /From the note/.test(x.innerText));
      return t ? [...t.rows].slice(1).map(r => r.cells[0].querySelector('.ff-link').innerText.trim()) : null;
    });
    assert.ok(players, 'the news table is shown');
    assert.deepEqual(players, ['Darius Cooper'], 'only the player gaining the work: not Thornton (out) or Raymond (named after the phrase)');
    await context.close();
  });

  it('gives a "No. 1 option" title to the player named after it, not to the backups named before it', async () => {
    const news = (url, b) => (/playernote/.test(url) && /pid=22\b/.test(url)
      ? b.replace(/caught two of three targets[^"<]*/, 'is listed as questionable. Darius Cooper and Kalif Raymond will be the complementary options behind No. 1 option Roman Wilson')
      : b);
    const { page, context } = await openBoard(browser, { pos: 'WR', mutate: news });
    await waitForBoard(page);
    await page.locator('.ff-tabbtn', { hasText: 'Trends' }).click();
    await page.waitForFunction(() => /behind No\. 1 option/.test(document.querySelector('.ff-board')?.innerText || ''), null, { timeout: 30000 });
    const players = await page.$$eval('.ff-board table.ff-cmp', ts => {
      const t = ts.find(x => /From the note/.test(x.innerText));
      return t ? [...t.rows].slice(1).map(r => r.cells[0].querySelector('.ff-link').innerText.trim()) : null;
    });
    assert.deepEqual(players, ['Roman Wilson']);
    await context.close();
  });
});
