import { randomBytes, randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import type { SourceAdapter } from './adapter.js';
import type { CrawlConfig, CrawlEvent, Candidate, ExtractedFields, AccessObservation, ScrollObservation } from './types.js';
import type { RunStorage } from './storage.js';
export interface CrawlBrowser {
  adapter?: SourceAdapter; page?: Page;
  open(): Promise<void>; cancelOpening?(): void;
  startRecording(): Promise<boolean>; suspendRecording(): Promise<void>;
  overlay(event: CrawlEvent): Promise<void>; screenshot(elementId: string, recordId: string): Promise<void>; close(keepOpen?: boolean): Promise<void>;
}
interface Command { id: string; action: string; payload?: unknown }
interface Pending { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
export class BridgeHub {
  readonly token = randomBytes(24).toString('hex');
  private config?: CrawlConfig;
  private session?: string;
  private queue: Command[] = [];
  private pending = new Map<string, Pending>();
  private wakePoll?: (command: Command | null) => void;
  private connected?: () => void;
  private rejectConnection?: (error: Error) => void;
  currentURL = '';
  begin(config: CrawlConfig): void { this.reset(); this.config = config; this.currentURL = config.url; }
  async wait(): Promise<void> {
    if (this.session) return;
    await new Promise<void>((resolve, reject) => { this.connected = resolve; this.rejectConnection = reject; });
  }
  connect(url: string): { session_id: string; config: CrawlConfig } {
    if (!this.config) throw new Error('Start a run with Existing Chrome selected before pairing the companion');
    const actual = new URL(url), expected = new URL(this.config.url);
    const match = this.config.mode === 'fixture' ? actual.origin === expected.origin && actual.pathname === '/fixture' : /(^|\.)facebook\.com$/i.test(actual.hostname) && actual.pathname.replace(/\/$/, '') === expected.pathname.replace(/\/$/, '') && actual.searchParams.get('fbid') === expected.searchParams.get('fbid') && actual.searchParams.get('id') === expected.searchParams.get('id');
    if (!match) throw new Error('Open the selected source URL in the signed-in Chrome tab before connecting');
    if (this.session) throw new Error('A Chrome tab is already connected to this run');
    this.currentURL = url; this.session = randomUUID(); this.connected?.();
    return { session_id: this.session, config: this.config };
  }
  authorize(token: string | undefined): boolean { return token === this.token; }
  private check(session: string): void { if (!this.session || session !== this.session) throw new Error('Companion session is no longer active'); }
  async poll(session: string, url: string): Promise<Command | null> {
    this.check(session); this.currentURL = url;
    if (this.queue.length) return this.queue.shift()!;
    if (this.wakePoll) throw new Error('Only one companion poll can be active');
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wakePoll = undefined; resolve(null); }, 20000);
      this.wakePoll = command => { clearTimeout(timer); this.wakePoll = undefined; resolve(command); };
    });
  }
  result(session: string, id: string, value: unknown, error?: string): void {
    this.check(session); const item = this.pending.get(id); if (!item) return;
    clearTimeout(item.timer); this.pending.delete(id);
    if (error) item.reject(new Error(error)); else item.resolve(value);
  }
  async command<T>(action: string, payload?: unknown): Promise<T> {
    if (!this.session) throw new Error('chrome_companion_not_connected');
    const id = randomUUID();
    const response = new Promise<T>((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('chrome_companion_disconnected: no browser response')); }, 10000); this.pending.set(id, { resolve, reject, timer }); });
    const command = { id, action, payload };
    if (this.wakePoll) this.wakePoll(command); else this.queue.push(command);
    return response;
  }
  reset(): void {
    this.rejectConnection?.(new Error('chrome_companion_connection_cancelled')); this.rejectConnection = undefined; this.connected = undefined;
    this.wakePoll?.(null); this.wakePoll = undefined; this.config = undefined; this.session = undefined; this.queue = [];
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('chrome_companion_disconnected')); } this.pending.clear();
  }
}
class CompanionAdapter implements SourceAdapter {
  constructor(readonly hub: BridgeHub) {}
  url(): string { return this.hub.currentURL; }
  access(): Promise<AccessObservation> { return this.hub.command('access'); }
  discover(): Promise<Candidate[]> { return this.hub.command('discover'); }
  focus(candidate: Candidate): Promise<Candidate> { return this.hub.command('focus', candidate.element_id); }
  extract(id: string): Promise<ExtractedFields> { return this.hub.command('extract', id); }
  scroll(): Promise<ScrollObservation> { return this.hub.command('scroll'); }
  loadMore(): Promise<boolean> { return this.hub.command('load_more'); }
  dismissOptionalLogin(): Promise<boolean> { return this.hub.command('dismiss_optional_login'); }
}
export class CompanionBrowser implements CrawlBrowser {
  adapter?: SourceAdapter;
  constructor(readonly config: CrawlConfig, readonly storage: RunStorage, readonly hub: BridgeHub) {}
  async open(): Promise<void> {
    this.hub.begin(this.config);
    await this.storage.updateManifest({ browser_backend: 'signed_in_chrome_companion', recording: { status: 'unavailable', reason: 'Existing Chrome companion does not record browser video. No authentication state is transferred.' }, screenshots_status: 'unavailable_in_companion_mode' });
    await this.hub.wait(); this.adapter = new CompanionAdapter(this.hub);
  }
  cancelOpening(): void { this.hub.reset(); }
  async startRecording(): Promise<boolean> { return false; }
  async suspendRecording(): Promise<void> {}
  async overlay(event: CrawlEvent): Promise<void> { await this.hub.command('overlay', event).catch(() => {}); }
  async screenshot(): Promise<void> {}
  async close(): Promise<void> { await this.hub.command('close').catch(() => {}); this.hub.reset(); }
}
