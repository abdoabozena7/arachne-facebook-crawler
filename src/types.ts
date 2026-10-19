export type Mode = 'facebook' | 'fixture';
export type CrawlState = 'idle' | 'starting' | 'running' | 'paused' | 'waiting_login' | 'stopping' | 'completed' | 'stopped' | 'failed';
export type EventType = 'page_opened' | 'post_discovered' | 'post_focused' | 'extraction_started' | 'post_extracted' | 'record_saved' | 'post_skipped' | 'extraction_failed' | 'scroll_started' | 'crawl_completed' | 'state_changed' | 'access_blocked' | 'diagnostic';
export interface Rect { x: number; y: number; width: number; height: number }
export interface ScrollObservation { scope: 'comments' | 'page'; before: number; after: number; height: number }
export interface Candidate { element_id: string; strategy: string; rect: Rect; locator: string; preview?: string }
export interface ExtractedFields {
  record_type?: 'post' | 'comment'; comment_id?: string | null; parent_post_url?: string | null;
  post_url: string | null; post_id: string | null; text: string;
  published_at: string | null; reaction_count: number | null; comment_count: number | null; share_count: number | null;
  diagnostic: { strategy: string; locator: string; text_strategy: string; observed_url?: string; reference_kind: 'permalink' | 'observed_element'; visible_only: true; truncated: boolean };
}
export interface PostRecord extends ExtractedFields {
  record_id: string; run_id: string; source_url: string; captured_at: string; extraction_status: 'success'; source_mode: Mode;
}
export interface CrawlEvent {
  seq: number; run_id: string; timestamp: string; type: EventType;
  element_id?: string; record_id?: string; rect?: Rect; message?: string;
  state?: CrawlState; reason?: string; record?: PostRecord; preview?: string; strategy?: string; animationSpeed?: number; saved_count?: number;
  scroll?: ScrollObservation;
}
export interface Counters { discovered: number; extracted: number; saved: number; duplicates: number; errors: number; skipped: number }
export interface CrawlConfig {
  collectionTarget?: 'posts' | 'comments'; browserMode?: 'fresh' | 'companion';
  publicOnly?: boolean; visibleOnly?: boolean; keepBrowserOpen?: boolean;
  mode: Mode; url: string; maxPosts: number; animationSpeed: number; operationDelayMs: number;
  idleRoundLimit: number; recordVideo: boolean; screenshots: boolean;
}
export interface Snapshot {
  state: CrawlState; run_id: string | null; mode: Mode | null; config: CrawlConfig | null;
  counters: Counters; records: PostRecord[]; events: CrawlEvent[]; reason: string | null;
}
export interface AccessObservation { status: 'accessible' | 'login_required' | 'denied' | 'loading' | 'unsupported'; reason: string }
export interface DomAPI {
  discover(): Candidate[];
  extract(id: string): ExtractedFields;
  access(): AccessObservation;
  loadMore(): Promise<boolean>;
  dismissOptionalLogin(): boolean;
  scroll(): Promise<ScrollObservation>;
  target(id: string): Element | undefined;
  clear(): void;
}
export interface OverlayAPI { event(event: CrawlEvent): void; destroy(): void; setSpeed(speed: number): void }
declare global {
  interface Window { __arachneDom?: DomAPI; __arachneOverlay?: OverlayAPI; __ARACHNE_MODE__?: Mode; __ARACHNE_TARGET__?: 'posts' | 'comments'; __arachneNoticeAuthentication?: () => Promise<void> }
}
