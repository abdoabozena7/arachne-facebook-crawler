import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { FacebookAdapter } from '../src/adapter.js';
import { recordKey } from '../src/records.js';

test('comment extraction uses actual semantic Arabic DOM, short text, emojis and comment permalink identity', async () => {
  const browser = await chromium.launch();
  try {
    const bundle = await readFile(path.resolve('dist/overlay.js'), 'utf8');
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await context.addInitScript({ content: `window.__ARACHNE_MODE__='facebook';window.__ARACHNE_TARGET__='comments';\n${bundle}` });
    const page = await context.newPage(); await page.goto('about:blank');
    await page.setContent('<div role="article" aria-label="تعليق من Fixture Author منذ سنة" style="width:350px;min-height:90px"><a href="https://www.facebook.com/fixture-author">Fixture Author</a><a href="https://www.facebook.com/photo/?fbid=100&comment_id=200&set=tracking">One year</a><span dir="auto">بواسطة الكاتب</span><span lang="ar"><div dir="auto">تعليق تجريبي قصير <img width="16" height="16" alt="😂" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'16\' height=\'16\'/%3E"></div></span><button>أعجبني</button><button>رد</button></div>');
    const adapter = new FacebookAdapter(page, 'facebook'); const candidates = await adapter.discover(); assert.equal(candidates.length, 1);
    const fields = await adapter.extract(candidates[0].element_id); assert.equal(fields.record_type, 'comment'); assert.equal(fields.text, 'تعليق تجريبي قصير 😂');
    assert.equal(fields.comment_id, '200'); assert.equal(fields.post_id, '100'); assert.equal(fields.post_url, 'https://www.facebook.com/photo/?fbid=100&comment_id=200');
    assert.equal(fields.parent_post_url, 'https://www.facebook.com/photo/?fbid=100'); assert.equal(fields.published_at, null);
    assert.notEqual(recordKey(fields, 'source', 'a'), recordKey({ ...fields, comment_id: '201' }, 'source', 'b'));
    await page.setContent('<div role="dialog"><h1>Log in to Facebook</h1><input type="password"><button aria-label="Close" onclick="this.closest(\'div\').remove()">Close</button></div>');
    assert.equal((await adapter.access()).status, 'login_required'); assert.equal(await adapter.dismissOptionalLogin(), true); assert.equal((await adapter.access()).status, 'unsupported');
    await context.close();
  } finally { await browser.close(); }
});

test('public comments beside a login banner remain accessible, while a covering login modal blocks extraction', async () => {
  const browser = await chromium.launch();
  try {
    const bundle = await readFile(path.resolve('dist/overlay.js'), 'utf8');
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await context.addInitScript({ content: `window.__ARACHNE_MODE__='facebook';window.__ARACHNE_TARGET__='comments';\n${bundle}` });
    const page = await context.newPage(); await page.goto('about:blank');
    await page.setContent('<header style="height:90px"><input type="password" aria-label="Empty sign-in invitation"><button>Log in</button></header><div role="article" aria-label="Comment by Fixture Author" style="width:400px;min-height:100px"><a href="https://www.facebook.com/photo/?fbid=100&comment_id=200">6y</a><span lang="en"><div dir="auto">Publicly visible controlled comment.</div></span></div>');
    const adapter = new FacebookAdapter(page, 'facebook');
    assert.equal((await adapter.access()).status, 'accessible');
    const candidate = (await adapter.discover())[0]; assert.equal((await adapter.extract(candidate.element_id)).text, 'Publicly visible controlled comment.');
    await page.evaluate(() => { const modal = document.createElement('div'); modal.setAttribute('role', 'dialog'); modal.style.cssText = 'position:fixed;inset:0;background:white;z-index:1000'; modal.innerHTML = '<h1>Log in to Facebook</h1><input type="password">'; document.body.append(modal); });
    assert.equal((await adapter.access()).status, 'login_required'); assert.equal((await adapter.discover()).length, 0);
    await assert.rejects(adapter.extract(candidate.element_id), /post_left_viewport/);
    await page.setContent('<header><input type="password"></header><img alt="Controlled public photo" width="300" height="300" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'300\' height=\'300\'/%3E">');
    await page.waitForLoadState('load');
    assert.equal((await adapter.access()).status, 'unsupported', 'An exposed photo with no matching comments is not proof of an enforced login gate');
    await context.close();
  } finally { await browser.close(); }
});

test('logged-out comment language blocks exclude author/date labels and preserve observed encoded comment identity', async () => {
  const browser = await chromium.launch();
  try {
    const bundle = await readFile(path.resolve('dist/overlay.js'), 'utf8');
    const context = await browser.newContext();
    await context.addInitScript({ content: `window.__ARACHNE_MODE__='facebook';window.__ARACHNE_TARGET__='comments';\n${bundle}` });
    const page = await context.newPage(); await page.goto('about:blank');
    await page.setContent('<html lang="en"><body><header><input type="password"></header><div role="article" aria-label="Comment by Test Author 6 years ago" style="width:400px;min-height:110px"><a href="https://www.facebook.com/photo/?fbid=100&comment_id=Y29tbWVudDoyMDA%3D"><span dir="auto">Test Author</span></a><span lang="ar-AR" dir="auto"><div dir="auto">تعليق ظاهر فقط</div></span><span dir="auto">6y</span></div></body></html>');
    const adapter = new FacebookAdapter(page, 'facebook'); const candidate = (await adapter.discover())[0];
    assert.equal((await adapter.access()).status, 'accessible'); assert.equal(candidate.preview, 'تعليق ظاهر فقط');
    const fields = await adapter.extract(candidate.element_id);
    assert.equal(fields.text, 'تعليق ظاهر فقط'); assert.equal(fields.comment_id, '200');
    assert.equal(fields.post_url, 'https://www.facebook.com/photo/?fbid=100&comment_id=200'); assert.equal(fields.published_at, null);
    const composite = Buffer.from('comment:100_200').toString('base64');
    await page.locator('a').evaluate((a, value) => a.setAttribute('href', 'https://www.facebook.com/photo/?fbid=100&comment_id=' + encodeURIComponent(value)), composite);
    const normalized = await adapter.extract(candidate.element_id);
    assert.equal(normalized.comment_id, '200'); assert.equal(normalized.post_url, fields.post_url);
    assert.equal(recordKey(normalized, 'source', 'a'), recordKey(fields, 'source', 'a'));
    await context.close();
  } finally { await browser.close(); }
});

test('comment fixture crawl saves separate comments on the same post and skips only genuine duplicate IDs', { timeout: 60000 }, async () => {
  const app = await createApp({ port: 0, openDashboard: false, runsDir: await mkdtemp(path.join(os.tmpdir(), 'arachne-comments-')) });
  try {
    const res = await fetch(app.url + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixture', collectionTarget: 'comments', maxPosts: 4, operationDelayMs: 80, animationSpeed: 3, screenshots: false }) });
    assert.equal(res.status, 202); await app.crawler.wait();
    const result = app.crawler.snapshot(); assert.equal(result.state, 'completed', result.reason ?? ''); assert.equal(result.counters.saved, 4); assert.equal(result.counters.duplicates, 1);
    assert.ok(result.records.every(r => r.record_type === 'comment' && r.post_id === 'fixture-001' && r.source_mode === 'fixture'));
    assert.equal(new Set(result.records.map(r => r.comment_id)).size, 4); assert.doesNotMatch(JSON.stringify(result.records), /HIDDEN COMMENT/);
  } finally { await app.close(); }
});

test('crawler scrolls inside the comment pane, loads more real DOM comments, and stops at exhaustion', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-scroll-comments-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  try {
    const response = await fetch(app.url + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixture', collectionTarget: 'comments', fixtureScroll: true, maxPosts: 100, operationDelayMs: 0, animationSpeed: 0.85, idleRoundLimit: 2 }) });
    assert.equal(response.status, 202); await app.crawler.wait();
    const result = app.crawler.snapshot();
    assert.equal(result.state, 'completed', result.reason ?? ''); assert.equal(result.reason, 'no_additional_posts_discovered');
    assert.equal(result.counters.saved, 12); assert.equal(new Set(result.records.map(r => r.comment_id)).size, 12);
    const saves = result.events.filter(e => e.type === 'record_saved');
    assert.ok(saves.slice(1).every((e, i) => Date.parse(e.timestamp) - Date.parse(saves[i].timestamp) >= 1000), 'Comments are visibly processed one at a time, not saved in a burst');
    for (const attempt of result.events.filter(e => e.type === 'extraction_started')) {
      const focus = result.events.find(e => e.type === 'post_focused' && e.element_id === attempt.element_id);
      assert.ok(focus && Date.parse(attempt.timestamp) - Date.parse(focus.timestamp) >= 1000, 'The real element stays focused before extraction');
    }
    assert.ok(result.records.some(r => r.comment_id === 'scroll-comment-12'));
    assert.ok(result.events.some(e => e.reason === 'more_comments_clicked'));
    const movement = result.events.filter(e => e.scroll && e.scroll.after > e.scroll.before);
    assert.ok(movement.length > 0); assert.ok(movement.every(e => e.scroll!.scope === 'comments'));
    const exported = await (await fetch(app.url + '/api/export')).json(); assert.equal(exported.length, 12);
    assert.equal(result.counters.errors, 0);
  } finally { await app.close(); }
});

test('local companion extension drives real fixture DOM through the complete crawler pipeline', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-companion-'));
  const app = await createApp({ port: 0, openDashboard: false, runsDir: root });
  const extension = path.resolve('companion');
  const context = await chromium.launchPersistentContext(path.join(root, 'test-profile'), { headless: false, channel: 'chromium', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1000, height: 850 } });
  try {
    const page = await context.newPage(); await page.goto(app.url + '/fixture?target=comments'); await page.bringToFront();
    const start = await fetch(app.url + '/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixture', collectionTarget: 'comments', browserMode: 'companion', maxPosts: 4, operationDelayMs: 80, animationSpeed: 3 }) }); assert.equal(start.status, 202);
    const { token } = await (await fetch(app.url + '/api/companion')).json() as { token: string };
    const denied = await fetch(app.url + '/bridge/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: page.url() }) }); assert.equal(denied.status, 403);
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const result = await worker.evaluate(async ({ server, token }) => {
      return (self as unknown as { arachneCompanion: { connect: (message: { server: string; token: string }) => Promise<{ ok: boolean }> } }).arachneCompanion.connect({ server, token });
    }, { server: app.url, token }); assert.equal(result.ok, true);
    await app.crawler.wait();
    const snapshot = app.crawler.snapshot(); assert.equal(snapshot.state, 'completed', snapshot.reason ?? ''); assert.equal(snapshot.counters.saved, 4); assert.equal(snapshot.counters.duplicates, 1);
    assert.equal(await page.locator('[data-fixture-comment]').count(), 5); assert.equal(await page.locator('[data-arachne-overlay]').count(), 0);
    const manifest = JSON.parse(await readFile(path.join(app.crawler.outputDirectory!, 'manifest.json'), 'utf8')); assert.equal(manifest.browser_backend, 'signed_in_chrome_companion'); assert.equal(manifest.recording.status, 'unavailable');
  } finally { await context.close(); await app.close(); }
});
