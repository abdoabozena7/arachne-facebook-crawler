import { mkdir, open, writeFile, rename } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { CrawlConfig, CrawlEvent, Counters, PostRecord } from './types.js';
export class RunStorage {
  readonly dir: string;
  readonly records: PostRecord[] = [];
  private data!: FileHandle;
  private events!: FileHandle;
  private manifest: Record<string, unknown>;
  constructor(root: string, readonly runId: string, config: CrawlConfig) {
    this.dir = path.resolve(root, runId);
    this.manifest = { run_id: runId, source_url: config.url, source_mode: config.mode, started_at: new Date().toISOString(), config, live_facebook_validation: config.mode === 'fixture' ? 'not_attempted_fixture_only' : 'requires_review_of_run', recording: { status: config.recordVideo ? 'pending_after_access_check' : 'disabled', reason: config.recordVideo ? 'Recording begins only after initial manual authentication.' : 'Video is opt-in to limit exposure of visible personal content.' }, screenshots: [], credentials_exported: false };
  }
  async init(): Promise<void> {
    await mkdir(path.join(this.dir, 'screenshots'), { recursive: true });
    this.data = await open(path.join(this.dir, 'data.jsonl'), 'a');
    this.events = await open(path.join(this.dir, 'events.jsonl'), 'a');
    await this.export(); await this.updateManifest({});
    await writeFile(path.join(this.dir, 'summary.md'), `# Crawl ${this.runId}\n\nRun in progress. This is not a completed collection. Inspect manifest.json and events.jsonl for its current configuration and observed activity. data.json contains only records already committed to storage.\n`);
  }
  async event(e: CrawlEvent): Promise<void> { await this.events.writeFile(JSON.stringify(e) + '\n'); await this.events.sync(); }
  async save(record: PostRecord): Promise<void> {
    await this.data.writeFile(JSON.stringify(record) + '\n');
    await this.data.sync(); // Durable JSONL is committed before record_saved or a collection animation.
    this.records.push(record);
    await this.export();
  }
  async export(): Promise<string> {
    const file = path.join(this.dir, 'data.json');
    await writeFile(file + '.tmp', JSON.stringify(this.records, null, 2) + '\n');
    await rename(file + '.tmp', file);
    return file;
  }
  async updateManifest(fields: Record<string, unknown>): Promise<void> {
    Object.assign(this.manifest, fields);
    await writeFile(path.join(this.dir, 'manifest.json'), JSON.stringify(this.manifest, null, 2) + '\n');
  }
  async finish(state: string, reason: string, counters: Counters): Promise<void> {
    await this.export(); await this.updateManifest({ finished_at: new Date().toISOString(), state, reason, counters });
    const recording = this.manifest.recording as { status: string; reason?: string };
    await writeFile(path.join(this.dir, 'summary.md'), `# Crawl ${this.runId}\n\nMode: **${this.manifest.source_mode}**\n\nSource: ${this.manifest.source_url}\n\nOutcome: ${state} — ${reason}\n\nSaved ${counters.saved} records from ${counters.discovered} observed elements. ${counters.duplicates} duplicates skipped; ${counters.errors} extraction errors.\n\nRecording: ${recording.status}${recording.reason ? ' — ' + recording.reason : ''}.\n\nCompare record_id and element_id in events.jsonl to the records and their DOM locators. Null fields were unavailable; observed-element references are scoped to this document and are weaker than permalinks. Fixture output is test data, never Facebook evidence. Screenshots and optional video contain visible content; review before sharing.\n`);
  }
  async close(): Promise<void> { await this.data?.close(); await this.events?.close(); }
}
