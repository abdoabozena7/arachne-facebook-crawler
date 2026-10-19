import { createHash } from 'node:crypto';
import type { ExtractedFields, PostRecord } from './types.js';
export function recordKey(fields: Pick<ExtractedFields, 'post_id' | 'post_url' | 'record_type' | 'comment_id'>, source: string, elementId: string): string {
  // Element identity is a deliberately conservative fallback: similar text is never a dedupe key.
  if (fields.record_type === 'comment') return fields.comment_id ? `comment:${fields.comment_id}` : fields.post_url && new URL(fields.post_url).searchParams.has('comment_id') ? `url:${fields.post_url}` : `element:${source}:${elementId}`;
  return fields.post_id ? `post:${fields.post_id}` : fields.post_url ? `url:${fields.post_url}` : `element:${source}:${elementId}`;
}
export function stableRecordId(key: string): string { return createHash('sha256').update(key).digest('hex').slice(0, 20); }
export function validateRecord(record: PostRecord): void {
  if (!record.text.trim()) throw new Error('no_visible_post_text');
  if (!record.source_url || !record.diagnostic.locator) throw new Error('missing_source_reference');
  if (!record.run_id || Number.isNaN(Date.parse(record.captured_at))) throw new Error('invalid_provenance');
  if (record.extraction_status !== 'success') throw new Error('invalid_extraction_status');
}
