import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build, version, releaseBase, RELEASE_REPO, FILE } from '../scripts/userscript.js';
import { launch, openBoard, waitForBoard, CONTENT_JS } from './helpers.js';

describe('userscript build', () => {
  it('has the header a userscript manager needs, and the unchanged extension code after it', () => {
    const out = build('http://localhost:9999');
    assert.match(out, /^\/\/ ==UserScript==/);
    assert.match(out, /@match\s+https:\/\/football\.fantasysports\.yahoo\.com\/f1\/\*/);
    assert.match(out, /@grant\s+none/);
    assert.ok(out.includes(`@updateURL    http://localhost:9999/${FILE}`));
    assert.ok(out.endsWith(fs.readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8')));
  });
  it('a release build installs from, and updates from, the latest release of the public repo', () => {
    const out = build(releaseBase(RELEASE_REPO), Date.parse('2026-11-11T09:30:00'));
    const url = `https://github.com/${RELEASE_REPO}/releases/latest/download/${FILE}`;
    assert.ok(out.includes(`@updateURL    ${url}`) && out.includes(`@downloadURL  ${url}`));
    assert.match(out, /@version\s+1\.20261111\.093000/, 'versioned by the commit time it was given');
  });
  it('the version goes up whenever the source file changes, so the manager sees the update', () => {
    assert.ok(version(Date.parse('2026-10-13T10:00:00')) < version(Date.parse('2026-10-13T10:00:01')));
    assert.match(version(Date.now()), /^1\.\d{8}\.\d{6}$/);
  });
});

describe('userscript runs without the extension APIs', () => {
  let browser;
  before(async () => { browser = await launch(); });
  after(async () => { await browser.close(); });
  it('builds the board when injected as plain page script (no chrome.storage)', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', load: false });
    await page.addScriptTag({ content: build() });
    await waitForBoard(page);
    assert.equal(await page.evaluate(() => !(window.chrome && window.chrome.storage)), true);
    await context.close();
  });
});

describe('moving from the userscript to the installed extension', () => {
  let browser;
  before(async () => { browser = await launch(); });
  after(async () => { await browser.close(); });
  // extension storage stand-in, kept in sessionStorage so it survives a reload like the real one
  const fakeStore = () => {
    const read = () => JSON.parse(sessionStorage.getItem('__fakeStore') || '{}'), write = o => sessionStorage.setItem('__fakeStore', JSON.stringify(o));
    window.chrome = window.chrome || {};
    window.chrome.storage = { local: {
      get: (k, cb) => { const all = read(); setTimeout(() => cb(k === null ? all : typeof k === 'string' ? (k in all ? { [k]: all[k] } : {}) : all), 0); },
      set: (o, cb) => { write(Object.assign(read(), o)); setTimeout(() => cb && cb(), 0); },
      remove: (k, cb) => { const all = read(); delete all[k]; write(all); setTimeout(() => cb && cb(), 0); },
    } };
  };
  it('copies what the userscript saved into extension storage once, never over newer data', async () => {
    const { page, context } = await openBoard(browser, { pos: 'WR', load: false });
    await page.addInitScript(fakeStore);
    await page.evaluate(() => {
      sessionStorage.setItem('__fakeStore', JSON.stringify({ 'newsSeen:111111': ['kept'] }));   // the extension already saved this
      localStorage.setItem('ff:snap:111111:2026-11-20', JSON.stringify({ day: 1 }));
      localStorage.setItem('ff:newsSeen:111111', JSON.stringify(['old']));
      localStorage.setItem('ff:lastReq', '123');
    });
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(page);
    const s1 = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__fakeStore')));
    assert.deepEqual(s1['snap:111111:2026-11-20'], { day: 1 }, 'a saved day comes across');
    assert.deepEqual(s1['newsSeen:111111'], ['kept'], 'newer extension data is not overwritten');
    assert.ok(!('lastReq' in s1), 'pacing state stays in the page storage');
    assert.ok(s1.importedFromPage > 0);
    await page.evaluate(() => localStorage.setItem('ff:snap:111111:2026-11-20', JSON.stringify({ day: 2 })));
    await page.reload(); await page.addScriptTag({ content: CONTENT_JS });
    await waitForBoard(page);
    const s2 = await page.evaluate(() => JSON.parse(sessionStorage.getItem('__fakeStore')));
    assert.deepEqual(s2['snap:111111:2026-11-20'], { day: 1 }, 'only once');
    await context.close();
  });
});
