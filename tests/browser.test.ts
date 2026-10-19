import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';
import { FacebookAdapter } from '../src/adapter.js';
import { BrowserController } from '../src/browser-controller.js';
import { RunStorage } from '../src/storage.js';
import { Crawler } from '../src/crawler.js';
import type { PostRecord, CrawlEvent, CrawlConfig } from '../src/types.js';

async function eventually(check: () => boolean | Promise<boolean>, timeout = 45000): Promise<void> {
  const start = Date.now(); while (!await check()) { if (Date.now() - start > timeout) throw new Error('Timed out waiting for browser state'); await new Promise(r => setTimeout(r, 50)); }
}
const bundle = await readFile(path.resolve('dist/overlay.js'), 'utf8');

test('public-only crawl stops at a real DOM login gate without sign-in and leaves its isolated viewer open', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-public-gate-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  class LoginFixtureBrowser extends BrowserController {
    async open(): Promise<void> {
      await super.open();
      assert.deepEqual(await this.context!.cookies(), []);
      // An empty authentication form in our local controlled document, not Facebook content.
      await this.page!.evaluate(() => window.__arachneOverlay?.destroy());
      await this.page!.setContent('<h1>Controlled login-gate fixture</h1><form><input type="password" aria-label="Empty test password field"></form>');
      await this.page!.addScriptTag({ content: `window.__ARACHNE_MODE__='facebook';\n${bundle}` });
      this.adapter = new FacebookAdapter(this.page!, 'facebook', false);
    }
  }
  let controller: LoginFixtureBrowser | undefined;
  const crawler = new Crawler(root, undefined, (config, storage, onClosed) => controller = new LoginFixtureBrowser(config, storage, onClosed));
  try {
    await crawler.start({ mode: 'fixture', url: app.url + '/fixture', publicOnly: true, visibleOnly: true, keepBrowserOpen: true, maxPosts: 100, animationSpeed: 3, operationDelayMs: 80, idleRoundLimit: 2, recordVideo: false, screenshots: false });
    await crawler.wait();
    const state = crawler.snapshot();
    assert.equal(state.state, 'failed'); assert.equal(state.reason, 'public_content_requires_login'); assert.equal(state.counters.saved, 0);
    assert.ok(state.events.some(e => e.type === 'access_blocked')); assert.ok(!state.events.some(e => e.state === 'waiting_login' || e.type === 'record_saved'));
    assert.equal(controller!.page!.isClosed(), false); assert.equal(await controller!.page!.locator('input').inputValue(), '');
    assert.equal(await controller!.page!.locator('[data-arachne-overlay]').count(), 0);
    const manifest = JSON.parse(await readFile(path.join(crawler.outputDirectory!, 'manifest.json'), 'utf8'));
    assert.equal(manifest.browser_viewer, 'left_open_for_viewing'); assert.equal(manifest.recording.status, 'disabled');
    assert.deepEqual(JSON.parse(await readFile(path.join(crawler.outputDirectory!, 'data.json'), 'utf8')), []);
    await crawler.shutdown(); assert.equal(controller!.page!.isClosed(), true);
  } finally { await crawler.shutdown(); await app.close(); }
});

test('visible-only crawl extracts real fixture text without scrolling or expanding and closes its retained viewer on a new run', { timeout: 45000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-visible-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  const controllers: BrowserController[] = [];
  const crawler = new Crawler(root, undefined, (config, storage, onClosed) => { const controller = new BrowserController(config, storage, onClosed); controllers.push(controller); return controller; });
  const config: CrawlConfig = { mode: 'fixture', url: app.url + '/fixture', visibleOnly: true, keepBrowserOpen: true, maxPosts: 100, animationSpeed: 3, operationDelayMs: 80, idleRoundLimit: 2, recordVideo: false, screenshots: false };
  try {
    await crawler.start(config); await crawler.wait(); const result = crawler.snapshot();
    assert.equal(result.state, 'completed', result.reason ?? ''); assert.equal(result.reason, 'visible_content_processed');
    assert.ok(result.counters.saved > 0 && result.counters.saved < 5); assert.match(result.records[0].text, /Morning field note/);
    assert.ok(!result.events.some(e => e.type === 'scroll_started' || e.reason === 'more_comments_clicked'));
    assert.equal(await controllers[0].page!.evaluate(() => scrollY), 0); assert.equal(controllers[0].page!.isClosed(), false);
    await crawler.start({ ...config, maxPosts: 1, keepBrowserOpen: false });
    assert.equal(controllers[0].page!.isClosed(), true);
    await crawler.wait(); assert.equal(controllers[1].page!.isClosed(), true);
  } finally { await crawler.shutdown(); await app.close(); }
});

test('controlled HTML extraction excludes hidden text, retains nulls, and diagnoses removed nodes', async () => {
  const app = await createApp({ port: 0, openDashboard: false, runsDir: await mkdtemp(path.join(os.tmpdir(), 'arachne-dom-')) });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript({ content: `window.__ARACHNE_MODE__='fixture';\n${bundle}` });
    const page = await context.newPage(); await page.goto(app.url + '/fixture');
    const adapter = new FacebookAdapter(page, 'fixture');
    const candidates = await adapter.discover(); assert.ok(candidates.length > 0);
    const first = await adapter.focus(candidates[0]); const fields = await adapter.extract(first.element_id);
    assert.equal(fields.post_id, 'fixture-001'); assert.match(fields.text, /Morning field note/); assert.doesNotMatch(fields.text, /HIDDEN|Like|Share|Fixture Observatory/);
    assert.equal(fields.published_at, '2026-10-01T08:30:00.000Z'); assert.equal(fields.reaction_count, 23); assert.equal(fields.comment_count, 4); assert.equal(fields.share_count, 2);
    const second = await page.evaluate(() => { document.querySelectorAll('[data-fixture-post]')[1].scrollIntoView({ block: 'center' }); return window.__arachneDom!.discover().find(c => window.__arachneDom!.target(c.element_id)?.querySelector('a')?.href.includes('fixture-002')); });
    assert.ok(second); const other = await adapter.extract(second.element_id);
    assert.equal(other.reaction_count, null); assert.equal(other.published_at, null);
    await page.evaluate(id => window.__arachneDom!.target(id)?.remove(), second.element_id);
    await assert.rejects(adapter.extract(second.element_id), /post_removed_from_dom/);
    // Pointer-transparent overlay: original source remains clickable and its text is never replaced.
    assert.equal(await page.locator('[data-arachne-overlay]').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
    const before = fields.text;
    await page.evaluate(id => window.__arachneOverlay!.event({ type: 'post_extracted', seq: 1, run_id: 'test', timestamp: new Date().toISOString(), element_id: id }), first.element_id);
    assert.ok(before.includes('controlled local fixture'));
    await context.close();
  } finally { await browser.close(); await app.close(); }
});

test('Facebook adapter strategies work on explicitly controlled semantic DOM; login/access gates are honest', async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript({ content: `window.__ARACHNE_MODE__='facebook';\n${bundle}` });
    const page = await context.newPage(); await page.goto('about:blank');
    await page.setContent(`<main><div role="article" style="width:600px;min-height:160px"><a href="https://www.facebook.com/example/posts/123?ref=tracking">Source</a><div data-ad-preview="message">Controlled adapter text, observed in this test document.</div><div role="article"><div data-ad-preview="message">Nested comment must not become a post</div></div></div><div data-pagelet="FeedUnit_2" style="width:600px;min-height:160px"><a href="https://www.facebook.com/permalink.php?story_fbid=456&id=42&ref=tracking">Source</a><div data-ad-comet-preview="message">Alternate feed-unit evidence from a controlled DOM.</div></div></main>`);
    const adapter = new FacebookAdapter(page, 'facebook'); const candidates = await adapter.discover();
    assert.equal(candidates.length, 2); assert.equal(candidates[0].strategy, 'facebook:role_article'); assert.equal(candidates[1].strategy, 'facebook:feed_unit');
    const fields = await adapter.extract(candidates[0].element_id); assert.equal(fields.post_url, 'https://www.facebook.com/example/posts/123');
    assert.equal(fields.post_id, '123'); assert.equal(fields.text, 'Controlled adapter text, observed in this test document.');
    await page.setContent('<section style="width:600px;min-height:180px"><a href="https://www.facebook.com/example/posts/789">Source</a><div dir="auto">An alternate visible text block used by the permalink ancestor strategy.</div><button>Like</button><button>Comment</button></section>');
    const fallback = await adapter.discover(); assert.equal(fallback.length, 1); assert.equal(fallback[0].strategy, 'facebook:permalink_ancestor');
    assert.equal((await adapter.extract(fallback[0].element_id)).diagnostic.text_strategy, 'facebook:visible_dir_auto');
    await page.setContent('<div role="article" style="width:600px;min-height:160px"><a href="https://www.facebook.com/example/posts/900">Source</a><p>No supported visible message evidence here</p></div>');
    const unsupported = await adapter.discover(); assert.equal(unsupported.length, 1); await assert.rejects(adapter.extract(unsupported[0].element_id), /selector_not_found/);
    await page.setContent('<form><input type="password" aria-label="Password"></form>'); assert.equal((await adapter.access()).status, 'login_required');
    await page.setContent('<h1>This content isn’t available</h1>'); assert.equal((await adapter.access()).status, 'denied');
    await page.setContent('<h1>Unrecognized layout</h1>'); assert.equal((await adapter.access()).status, 'unsupported');
    await context.close();
  } finally { await browser.close(); }
});

test('headed fixture crawl persists five real DOM records, skips duplicate, streams events and finalizes video', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-run-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  const observed: CrawlEvent[] = []; app.crawler.subscribe(e => observed.push(e));
  try {
    const badOrigin = await fetch(app.url + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://foreign.example' }, body: '{}' }); assert.equal(badOrigin.status, 403);
    const response = await fetch(app.url + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixture', maxPosts: 5, animationSpeed: 3, operationDelayMs: 80, recordVideo: true, screenshots: true }) });
    assert.equal(response.status, 202);
    await eventually(() => app.crawler.snapshot().state === 'running');
    await app.crawler.pause(); assert.equal(app.crawler.snapshot().state, 'paused');
    const savedBefore = app.crawler.snapshot().counters.saved;
    await new Promise(r => setTimeout(r, 300)); assert.equal(app.crawler.snapshot().counters.saved, savedBefore);
    await app.crawler.resume(); await app.crawler.wait();
    const result = app.crawler.snapshot(); assert.equal(result.state, 'completed', result.reason ?? ''); assert.equal(result.counters.saved, 5); assert.equal(result.counters.duplicates, 1); assert.equal(result.counters.errors, 0);
    assert.equal(result.records.at(-1)?.post_id, 'fixture-005');
    assert.equal(result.records[1].text, result.records[2].text); assert.notEqual(result.records[1].post_id, result.records[2].post_id);
    const dir = app.crawler.outputDirectory!;
    const records = JSON.parse(await readFile(path.join(dir, 'data.json'), 'utf8')) as PostRecord[];
    const log = (await readFile(path.join(dir, 'events.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as CrawlEvent);
    assert.equal(records.length, 5); assert.equal(log.filter(e => e.type === 'record_saved').length, 5);
    assert.deepEqual(log.filter(e => e.type === 'record_saved').map(e => e.saved_count), [1, 2, 3, 4, 5]);
    for (const record of records) {
      assert.equal(record.source_mode, 'fixture');
      const saved = log.find(e => e.type === 'record_saved' && e.record_id === record.record_id)!;
      assert.ok(log.some(e => e.type === 'post_extracted' && e.record_id === record.record_id && e.seq < saved.seq));
      assert.ok(log.some(e => e.type === 'post_discovered' && e.element_id === saved.element_id && e.seq < saved.seq));
      assert.equal(saved.record?.text, record.text);
    }
    assert.deepEqual(observed.map(e => e.seq), observed.map((_, i) => i + 1));
    const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8')); assert.equal(manifest.recording.status, 'saved'); assert.equal(manifest.screenshots.length, 3);
    assert.ok((await stat(path.join(dir, 'session.webm'))).size > 1000);
    const exported = await fetch(app.url + '/api/export'); assert.equal(exported.status, 200); assert.deepEqual(await exported.json(), records);
    await app.crawler.start({ ...result.config!, maxPosts: 100, recordVideo: false });
    await eventually(() => app.crawler.snapshot().state === 'running'); await app.crawler.pause(); await app.crawler.stop(); await app.crawler.wait();
    assert.equal(app.crawler.snapshot().state, 'stopped');
    await app.crawler.start({ ...result.config!, maxPosts: 100, recordVideo: false, screenshots: false, idleRoundLimit: 2 });
    await app.crawler.wait();
    assert.equal(app.crawler.snapshot().state, 'completed'); assert.equal(app.crawler.snapshot().reason, 'no_additional_posts_discovered'); assert.equal(app.crawler.snapshot().counters.saved, 5);
  } finally { await app.close(); }
});

test('headed recording is discarded if an authentication field appears, and unexpected closure is observable', { timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-privacy-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  const config: CrawlConfig = { mode: 'fixture', url: app.url + '/fixture', maxPosts: 1, animationSpeed: 1, operationDelayMs: 100, idleRoundLimit: 2, recordVideo: true, screenshots: false };
  const storage = new RunStorage(root, 'privacy-fixture', config); await storage.init();
  let closed = 0;
  const controller = new BrowserController(config, storage, () => closed++);
  try {
    await controller.open(); assert.equal(await controller.startRecording(), true);
    // This is an empty test input, never a user's password. Field presence alone invalidates the recording.
    await controller.page!.evaluate(() => { const input = document.createElement('input'); input.type = 'password'; input.setAttribute('aria-label', 'Empty fixture authentication field'); document.body.prepend(input); input.focus(); });
    await new Promise(r => setTimeout(r, 100)); await controller.close();
    const manifest = JSON.parse(await readFile(path.join(storage.dir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.recording.status, 'discarded'); await assert.rejects(stat(path.join(storage.dir, 'session.webm')), /ENOENT/); assert.equal(closed, 0);
    const plain = new BrowserController({ ...config, recordVideo: false }, storage, () => closed++);
    await plain.open(); await plain.page!.close(); assert.equal(closed, 1); await plain.close(); assert.equal(closed, 1);
  } finally { await controller.close(); await storage.close(); await app.close(); }
});
