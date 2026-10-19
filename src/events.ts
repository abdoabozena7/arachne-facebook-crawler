import type { Counters, CrawlEvent, EventType } from './types.js';
export function emptyCounters(): Counters { return { discovered: 0, extracted: 0, saved: 0, duplicates: 0, errors: 0, skipped: 0 }; }
export function countEvent(c: Counters, e: CrawlEvent): void {
  if (e.type === 'post_discovered') c.discovered++;
  if (e.type === 'post_extracted') c.extracted++;
  if (e.type === 'record_saved') c.saved++;
  if (e.type === 'post_skipped') { c.skipped++; if (e.reason === 'duplicate_detected') c.duplicates++; }
  if (e.type === 'extraction_failed') c.errors++;
}
export type AnimationAction = 'seek' | 'focus' | 'scan' | 'collect' | 'skip' | 'failure' | 'scroll' | 'state' | 'none';
export function animationAction(type: EventType): AnimationAction {
  return ({ post_discovered: 'seek', post_focused: 'focus', extraction_started: 'scan', record_saved: 'collect', post_skipped: 'skip', extraction_failed: 'failure', scroll_started: 'scroll', state_changed: 'state', crawl_completed: 'state', access_blocked: 'failure' } as Partial<Record<EventType, AnimationAction>>)[type] ?? 'none';
}
