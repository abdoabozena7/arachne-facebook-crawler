import { randomUUID } from 'node:crypto';
import { StateMachine } from './state.js';
import { RunStorage } from './storage.js';
import { BrowserController } from './browser-controller.js';
import { CompanionBrowser, type CrawlBrowser, type BridgeHub } from './bridge.js';
import { emptyCounters, countEvent } from './events.js';
import { recordKey, stableRecordId, validateRecord } from './records.js';
import type { CrawlConfig, CrawlEvent, CrawlState, EventType, Snapshot, Candidate, PostRecord } from './types.js';

export class Crawler {
  readonly machine = new StateMachine();
  private storage?: RunStorage;
  private controller?: CrawlBrowser;
  private config: CrawlConfig | null = null;
  private counters = emptyCounters();
  private events: CrawlEvent[] = [];
  private seq = 0;
  private reason: string | null = null;
  private runId: string | null = null;
  private stopRequested = false;
  private browserClosed = false;
  private eventQueue: Promise<void> = Promise.resolve();
  private task: Promise<void> = Promise.resolve();
  private listeners = new Set<(event: CrawlEvent) => void>();
  constructor(readonly runsDir: string, readonly bridge?: BridgeHub, readonly createBrowser?: (config: CrawlConfig, storage: RunStorage, onClosed: () => void) => CrawlBrowser) {}
  subscribe(listener: (e: CrawlEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  snapshot(): Snapshot { return { state: this.machine.state, run_id: this.runId, mode: this.config?.mode ?? null, config: this.config, counters: { ...this.counters }, records: [...this.storage?.records ?? []], events: [...this.events], reason: this.reason }; }
  get outputDirectory(): string | null { return this.storage?.dir ?? null; }
  async emit(type: EventType, fields: Partial<CrawlEvent> = {}): Promise<void> {
    const event: CrawlEvent = { ...fields, type, seq: ++this.seq, run_id: this.runId!, timestamp: new Date().toISOString(), animationSpeed: this.config?.animationSpeed };
    const operation = this.eventQueue.then(async () => {
      event.saved_count = this.counters.saved + (type === 'record_saved' ? 1 : 0);
      await this.storage?.event(event);
      countEvent(this.counters, event);
      this.events.push(event); if (this.events.length > 300) this.events.shift();
      for (const listener of this.listeners) { try { listener(event); } catch { /* A disconnected dashboard cannot abort a crawl. */ } }
      await this.controller?.overlay(event);
    });
    this.eventQueue = operation.catch(() => {});
    return operation;
  }
  private async setState(state: CrawlState, reason?: string): Promise<void> {
    if (state === 'running') this.reason = null;
    this.machine.transition(state); if (reason) this.reason = reason;
    await this.emit('state_changed', { state, reason, message: reason ?? `Crawler ${state}` });
  }
  async start(config: CrawlConfig): Promise<string> {
    if (this.machine.active) throw new Error('A crawl is already active');
    await this.task;
    await this.controller?.close(); this.controller = undefined;
    this.runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    this.config = config; this.seq = 0; this.events = []; this.counters = emptyCounters(); this.reason = null;
    this.stopRequested = false; this.browserClosed = false;
    this.storage = new RunStorage(this.runsDir, this.runId, config);
    try { await this.storage.init(); } catch (error) { await this.storage.close().catch(() => {}); throw error; }
    await this.setState('starting', config.browserMode === 'companion' ? 'Waiting for the signed-in Chrome companion connection' : undefined);
    this.task = this.run();
    return this.runId;
  }
  async pause(): Promise<void> {
    if (!['running', 'starting'].includes(this.machine.state)) throw new Error('Pause requires a starting or running crawl');
    await this.setState('paused', 'Paused by user');
  }
  async resume(): Promise<void> {
    if (!['paused', 'waiting_login'].includes(this.machine.state)) throw new Error('Resume requires a paused crawl or manual sign-in');
    if (this.machine.state === 'waiting_login') {
      let access = await this.controller?.adapter?.access();
      if (access?.status === 'login_required' || access?.status === 'denied') throw new Error(access.reason);
      const page = this.controller?.page;
      const sourceRef = (url: string) => { const u = new URL(url); return `${u.pathname}?id=${u.searchParams.get('id') ?? ''}`; };
      if (page && this.config && sourceRef(page.url()) !== sourceRef(this.config.url)) {
        await page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForFunction(() => !!window.__arachneDom, { timeout: 8000 });
      }
      for (let i = 0; i < 5; i++) {
        access = await this.controller?.adapter?.access();
        if (access?.status === 'accessible' || access?.status === 'login_required' || access?.status === 'denied') break;
        await new Promise(r => setTimeout(r, 500));
      }
      if (!access || access.status !== 'accessible') throw new Error(access?.reason ?? 'Browser content is not ready');
    }
    this.reason = null; await this.setState('running');
  }
  async stop(): Promise<void> {
    if (!this.machine.active || this.machine.state === 'stopping') throw new Error('No stoppable crawl');
    this.stopRequested = true; await this.setState('stopping', 'Stop requested by user');
    this.controller?.cancelOpening?.();
  }
  async wait(): Promise<void> { await this.task; }
  async shutdown(): Promise<void> { if (this.machine.active && this.machine.state !== 'stopping') await this.stop(); await this.wait(); await this.controller?.close(); }
  private async gate(): Promise<boolean> {
    while (['paused', 'waiting_login'].includes(this.machine.state) && !this.stopRequested && !this.browserClosed) await new Promise(r => setTimeout(r, 80));
    if (this.browserClosed) throw new Error('browser_closed_unexpectedly');
    return !this.stopRequested;
  }
  private async delay(ms: number): Promise<boolean> {
    let remaining = ms;
    while (remaining > 0) {
      if (!await this.gate()) return false;
      const interval = Math.min(remaining, 80); await new Promise(r => setTimeout(r, interval)); remaining -= interval;
    }
    return this.gate();
  }
  private async process(candidate: Candidate, seen: Set<string>, attempted: Set<string>): Promise<void> {
    const adapter = this.controller!.adapter!;
    attempted.add(candidate.element_id);
    await this.emit('post_discovered', { ...candidate, message: `Visible ${this.config!.collectionTarget === 'comments' ? 'comment' : 'post'} candidate discovered` });
    try {
      const focused = await adapter.focus(candidate);
      await this.emit('post_focused', { ...focused, message: 'Spider focused on observed element' });
      // Keep each genuine target focused long enough to see it before extraction.
      // This wait is interruptible by pause/stop and follows the animation speed.
      if (!await this.delay(1600 / this.config!.animationSpeed)) return;
      await this.emit('extraction_started', { element_id: candidate.element_id, preview: candidate.preview, message: 'Extracting actual visible DOM content' });
      const access = await adapter.access();
      if (access.status === 'login_required' || access.status === 'denied') throw new Error(access.status);
      const fields = await adapter.extract(candidate.element_id);
      const capturedAt = new Date().toISOString();
      if (!await this.gate()) return;
      const key = recordKey(fields, this.config!.url, candidate.element_id);
      if (seen.has(key)) { await this.emit('post_skipped', { element_id: candidate.element_id, reason: 'duplicate_detected', message: 'Post identifier or permalink already saved' }); return; }
      const record: PostRecord = { ...fields, record_id: stableRecordId(key), run_id: this.runId!, source_url: this.config!.url, captured_at: capturedAt, extraction_status: 'success', source_mode: this.config!.mode };
      validateRecord(record);
      await this.emit('post_extracted', { element_id: candidate.element_id, record_id: record.record_id, preview: fields.text.slice(0, 140), message: 'Visible data extracted and validated' });
      await this.storage!.save(record);
      seen.add(key);
      await this.emit('record_saved', { element_id: candidate.element_id, record_id: record.record_id, record, preview: fields.text.slice(0, 140), message: 'Record committed to storage' });
      await this.controller!.screenshot(candidate.element_id, record.record_id).catch(async error => { await this.emit('diagnostic', { reason: 'screenshot_unavailable', message: String(error) }); });
      await this.delay(this.config!.operationDelayMs);
    } catch (error) {
      if (this.stopRequested) return;
      if (this.browserClosed) throw error;
      // A disk failure is fatal; retrying a partly committed append could create ambiguous evidence.
      if (error instanceof Error && /ENOSPC|EACCES|EPERM|EIO/.test(error.message)) throw error;
      await this.emit('extraction_failed', { element_id: candidate.element_id, reason: error instanceof Error ? error.message : String(error), message: 'Extraction failed; no collection success emitted' });
    }
  }
  private async run(): Promise<void> {
    let outcome: CrawlState = 'completed', reason = 'post_limit_reached';
    try {
      const onClosed = () => { this.browserClosed = true; };
      this.controller = this.createBrowser ? this.createBrowser(this.config!, this.storage!, onClosed) : this.config!.browserMode === 'companion' && this.bridge ? new CompanionBrowser(this.config!, this.storage!, this.bridge) : new BrowserController(this.config!, this.storage!, onClosed);
      await this.controller.open();
      await this.emit('page_opened', { message: this.config!.browserMode === 'companion' ? 'Existing visible Chrome tab connected' : 'Visible Chromium opened', reason: this.config!.mode === 'fixture' ? 'TEST FIXTURE — not Facebook data' : undefined });
      if (this.machine.state === 'starting') await this.setState('running');
      const seen = new Set<string>(), attempted = new Set<string>();
      let idleRounds = 0, scanned = 0, recordingChecked = false, observedSource: string | null = null, dismissedPrompts = 0;
      while (await this.gate()) {
        const adapter = this.controller.adapter!;
        const access = await adapter.access();
        if (access.status === 'login_required') {
          if (dismissedPrompts < 2 && await adapter.dismissOptionalLogin()) {
            dismissedPrompts++; await this.emit('diagnostic', { reason: 'optional_login_prompt_dismissed', message: 'Closed an optional sign-in dialog using its visible Close control' });
            await this.delay(Math.max(800, this.config!.operationDelayMs)); continue;
          }
          if (this.config!.publicOnly) {
            outcome = 'failed'; reason = 'public_content_requires_login';
            await this.emit('access_blocked', { reason, message: 'Facebook requires sign-in for this content. Public-only mode stops without collecting credentials or restricted content.' });
            break;
          }
          await this.controller.suspendRecording();
          await this.emit('access_blocked', { reason: 'login_required', message: access.reason });
          await this.setState('waiting_login', access.reason);
          continue;
        }
        if (access.status === 'denied') { outcome = 'failed'; reason = 'access_denied'; await this.emit('access_blocked', { reason, message: access.reason }); break; }
        const currentURL = new URL(adapter.url());
        const permittedOrigin = this.config!.mode === 'fixture' ? currentURL.origin === new URL(this.config!.url).origin : /(^|\.)facebook\.com$/i.test(currentURL.hostname);
        const currentSource = `${currentURL.pathname.replace(/\/$/, '')}?id=${currentURL.searchParams.get('id') ?? ''}&fbid=${currentURL.searchParams.get('fbid') ?? ''}`;
        if (!permittedOrigin || observedSource && currentSource !== observedSource) {
          outcome = 'failed'; reason = 'source_navigation_changed';
          await this.emit('access_blocked', { reason, message: 'Browser navigated away from the selected source. Start a new run for a different page.' }); break;
        }
        if (access.status === 'accessible' && !observedSource) observedSource = currentSource;
        if (access.status === 'accessible' && !recordingChecked) {
          recordingChecked = true;
          const changed = await this.controller.startRecording();
          if (changed) { await this.emit('diagnostic', { reason: 'recording_started', message: 'Recording context ready after access check' }); continue; }
          if (this.config!.recordVideo) await this.emit('diagnostic', { reason: 'recording_unavailable', message: 'Video unavailable; see manifest for the reason' });
        }
        const candidates = await adapter.discover();
        const pending = candidates.filter(c => !attempted.has(c.element_id));
        for (const candidate of pending) {
          if (!await this.gate()) break;
          await this.process(candidate, seen, attempted);
          if (this.storage!.records.length >= this.config!.maxPosts) break;
        }
        if (this.stopRequested || this.storage!.records.length >= this.config!.maxPosts) break;
        if (this.config!.visibleOnly && candidates.length > 0) {
          reason = this.counters.saved > 0 ? 'visible_content_processed' : 'no_extractable_visible_content';
          if (this.counters.saved === 0) outcome = 'failed';
          break;
        }
        // Redrawn duplicate elements are not progress. Bound unsuccessful scrolling even on virtual feeds.
        if (this.storage!.records.length === scanned) idleRounds++; else { idleRounds = 0; scanned = this.storage!.records.length; }
        if (idleRounds >= this.config!.idleRoundLimit) {
          reason = this.counters.discovered === 0 ? access.status === 'loading' ? 'content_not_loaded' : 'unsupported_page_layout' : this.counters.saved === 0 ? 'no_extractable_posts' : 'no_additional_posts_discovered';
          if (this.counters.saved === 0) outcome = 'failed';
          await this.emit('diagnostic', { reason, message: `Stopped after ${idleRounds} ${this.config!.visibleOnly ? 'visible-content checks' : 'scroll rounds'} without new candidates` }); break;
        }
        if (!this.config!.visibleOnly) {
          await this.emit('scroll_started', { message: 'Scrolling the source to observe more content' });
          if (this.config!.collectionTarget === 'comments' && await adapter.loadMore()) await this.emit('diagnostic', { reason: 'more_comments_clicked', message: 'Clicked the visible load-more-comments control' });
          const scroll = await adapter.scroll();
          if (scroll) await this.emit('diagnostic', { reason: scroll.after !== scroll.before ? 'scroll_position_changed' : 'scroll_boundary_reached', scroll, message: `${scroll.scope === 'comments' ? 'Comment pane' : 'Page'} scroll: ${Math.round(scroll.before)} → ${Math.round(scroll.after)} px` });
        } else await this.emit('diagnostic', { reason: 'waiting_visible_content', message: 'Waiting for the current visible content to load; no scrolling or expansion' });
        // Wait for newly scrolled content only, without slowing each comment's extraction.
        if (!await this.delay(Math.max(800, this.config!.operationDelayMs))) break;
      }
      if (this.stopRequested) { outcome = 'stopped'; reason = 'stopped_by_user'; }
    } catch (error) {
      outcome = this.stopRequested ? 'stopped' : 'failed';
      reason = this.stopRequested ? 'stopped_by_user' : this.browserClosed ? 'browser_closed_unexpectedly' : error instanceof Error ? error.message : String(error);
      await this.emit('diagnostic', { reason, message: 'Crawler ended with an explicit failure reason' }).catch(() => {});
    } finally {
      try {
        await this.controller?.close(this.config?.keepBrowserOpen === true);
        if (this.machine.state !== outcome) await this.setState(outcome, reason);
        await this.emit('crawl_completed', { state: outcome, reason, message: `${this.counters.saved} real records saved; ${reason}` });
        await this.storage?.finish(outcome, reason, this.counters);
      } catch (error) { this.reason = `evidence_finalization_failed: ${String(error)}`; if (this.machine.state !== 'failed') { try { this.machine.transition('failed'); } catch {} } }
      await this.storage?.close().catch(() => {});
    }
  }
}
