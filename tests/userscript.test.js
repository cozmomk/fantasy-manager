import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { build, version, releaseBase, RELEASE_REPO, FILE } from '../scripts/userscript.js';
import { launch, openBoard, waitForBoard } from './helpers.js';

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
