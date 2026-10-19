import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StateMachine } from '../src/state.js';
import { recordKey, stableRecordId, validateRecord } from '../src/records.js';
import { animationAction, countEvent, emptyCounters } from '../src/events.js';
import { RunStorage } from '../src/storage.js';
import { validateConfig } from '../src/server.js';
import { splitDesktop } from '../src/windows.js';
import type { CrawlConfig, CrawlEvent, PostRecord } from '../src/types.js';

const config: CrawlConfig = { mode: 'fixture', url: 'http://127.0.0.1:4318/fixture', maxPosts: 5, animationSpeed: 1, operationDelayMs: 100, idleRoundLimit: 3, recordVideo: false, screenshots: true };
const record: PostRecord = { record_id: 'record-1', run_id: 'unit-run', source_url: config.url, source_mode: 'fixture', post_url: config.url + '?post=1', post_id: '1', text: 'Visible fixture text only.', published_at: null, reaction_count: null, comment_count: null, share_count: null, captured_at: '2026-10-14T12:00:00.000Z', extraction_status: 'success', diagnostic: { strategy: 'fixture', locator: 'fixture element 1', text_strategy: 'explicit', reference_kind: 'permalink', visible_only: true, truncated: false } };
test('deduplication uses identifiers or source references, never similar text', () => {
  assert.equal(recordKey(record, config.url, 'a'), recordKey(record, config.url, 'b'));
  assert.notEqual(recordKey(record, config.url, 'a'), recordKey({ ...record, post_id: '2' }, config.url, 'b'));
  assert.equal(recordKey({ post_id: null, post_url: record.post_url }, config.url, 'a'), `url:${record.post_url}`);
  assert.notEqual(recordKey({ post_id: null, post_url: null }, config.url, 'a'), recordKey({ post_id: null, post_url: null }, config.url, 'b'));
  assert.equal(stableRecordId('post:1'), stableRecordId('post:1'));
});
test('record validation rejects empty extraction and missing provenance', () => {
  validateRecord(record);
  assert.throws(() => validateRecord({ ...record, text: ' ' }), /no_visible_post_text/);
  assert.throws(() => validateRecord({ ...record, source_url: '' }), /missing_source_reference/);
});
test('event counters distinguish extraction, durable save, duplicate skip, and failure', () => {
  const counts = emptyCounters();
  for (const type of ['post_discovered', 'post_extracted', 'record_saved', 'extraction_failed'] as const) countEvent(counts, { type } as CrawlEvent);
  countEvent(counts, { type: 'post_skipped', reason: 'duplicate_detected' } as CrawlEvent);
  countEvent(counts, { type: 'post_skipped', reason: 'unsupported' } as CrawlEvent);
  assert.deepEqual(counts, { discovered: 1, extracted: 1, saved: 1, errors: 1, skipped: 2, duplicates: 1 });
});
test('animation success maps only to the persistence event', () => {
  assert.equal(animationAction('record_saved'), 'collect');
  assert.equal(animationAction('post_extracted'), 'none');
  assert.equal(animationAction('extraction_started'), 'scan');
  assert.equal(animationAction('extraction_failed'), 'failure');
  assert.equal(animationAction('post_focused'), 'focus');
  assert.equal(animationAction('state_changed'), 'state');
});
test('state transitions support pause, resume, manual login and stop', () => {
  const machine = new StateMachine();
  for (const state of ['starting', 'running', 'paused', 'running', 'waiting_login', 'running', 'stopping', 'stopped'] as const) machine.transition(state);
  assert.equal(machine.active, false);
  assert.throws(() => machine.transition('paused'), /Cannot/);
  machine.transition('starting'); machine.transition('failed'); machine.transition('starting');
});
test('JSONL, JSON export, event log and final manifest preserve actual records', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'arachne-storage-'));
  const storage = new RunStorage(root, 'unit-run', config); await storage.init();
  await storage.save(record);
  const event = { type: 'record_saved', run_id: 'unit-run', seq: 1, timestamp: record.captured_at, record_id: record.record_id, record } as CrawlEvent;
  await storage.event(event); await storage.finish('completed', 'post_limit_reached', { ...emptyCounters(), saved: 1 }); await storage.close();
  assert.deepEqual(JSON.parse(await readFile(path.join(storage.dir, 'data.json'), 'utf8')), [record]);
  assert.deepEqual(JSON.parse((await readFile(path.join(storage.dir, 'data.jsonl'), 'utf8')).trim()), record);
  assert.equal(JSON.parse((await readFile(path.join(storage.dir, 'events.jsonl'), 'utf8')).trim()).record_id, record.record_id);
  const manifest = JSON.parse(await readFile(path.join(storage.dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.source_mode, 'fixture'); assert.equal(manifest.recording.status, 'disabled'); assert.equal(manifest.credentials_exported, false);
});
test('live configuration requires authorization, bounded pacing and Facebook source URL', () => {
  const input = { mode: 'facebook', url: 'https://www.facebook.com/example?access_token=secret&ref=share', authorized: true };
  assert.equal(validateConfig(input, 'http://127.0.0.1:4318').url, 'https://www.facebook.com/example');
  assert.throws(() => validateConfig({ ...input, authorized: false }, 'http://127.0.0.1:4318'), /authorization/);
  assert.throws(() => validateConfig({ ...input, url: 'https://facebook.com.evil.example/' }, 'http://127.0.0.1:4318'), /facebook.com/);
  assert.throws(() => validateConfig({ ...input, url: 'https://user:pass@facebook.com/' }, 'http://127.0.0.1:4318'), /credentials/);
  assert.throws(() => validateConfig({ ...input, operationDelayMs: -1 }, 'http://127.0.0.1:4318'), /operationDelayMs/);
  assert.equal(validateConfig({ mode: 'fixture', url: 'https://evil.example/' }, 'http://127.0.0.1:4318').url, 'http://127.0.0.1:4318/fixture');
});
test('public collection defaults to isolated Chromium, automatic scrolling and no recording', () => {
  const base = 'http://127.0.0.1:4318';
  const input = { mode: 'facebook', authorized: true };
  const config = validateConfig(input, base);
  assert.equal(config.browserMode, 'fresh');
  assert.equal(config.collectionTarget, 'comments');
  assert.equal(config.publicOnly, true); assert.equal(config.visibleOnly, false); assert.equal(config.keepBrowserOpen, true);
  assert.equal(config.maxPosts, 200);
  assert.equal(config.animationSpeed, 0.85); assert.equal(config.operationDelayMs, 0);
  assert.equal(config.recordVideo, false); assert.equal(config.screenshots, false);
  assert.equal(validateConfig({ ...input, recordVideo: true }, base).recordVideo, false);
  assert.throws(() => validateConfig({ ...input, browserMode: 'companion' }, base), /fresh isolated Chromium/);
  const fixture = validateConfig({ mode: 'fixture', recordVideo: true }, base);
  assert.equal(fixture.publicOnly, false); assert.equal(fixture.visibleOnly, false); assert.equal(fixture.keepBrowserOpen, false); assert.equal(fixture.recordVideo, true);
});
test('collection panel and Chromium source divide the available desktop without overlapping', () => {
  for (const width of [1024, 1280, 1920]) {
    const desktop = { left: 100, top: 40, width, height: 900 };
    const layout = splitDesktop(desktop);
    assert.equal(layout.panel.left, 100); assert.equal(layout.source.top, 40);
    assert.equal(layout.source.left, layout.panel.left + layout.panel.width);
    assert.equal(layout.panel.width + layout.source.width, width);
    assert.ok(layout.panel.width >= 300 && layout.panel.width <= 420);
  }
});
