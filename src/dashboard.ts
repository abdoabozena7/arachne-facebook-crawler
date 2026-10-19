import { countEvent, emptyCounters } from './events.js';
import type { CrawlEvent, Snapshot, PostRecord } from './types.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const query = new URLSearchParams(location.search);
const fixture = query.get('fixture');
const mode = fixture === 'posts' || fixture === 'comments' ? 'fixture' : 'facebook';
const collectionTarget = mode === 'fixture' && fixture === 'posts' ? 'posts' : 'comments';
let snapshot: Snapshot = { state: 'idle', run_id: null, mode: null, config: null, counters: emptyCounters(), records: [], events: [], reason: null };
let defaults: Record<string, unknown> = {};
let lastSeq = 0, submitting = false, disconnected = false;
let visibleRunId: string | null = null;
let requestError: string | null = null;
let sourceEdited = false;
let scrolling = false;
const knownRecords = new Set<string>();
const active = (): boolean => ['starting', 'running', 'paused', 'waiting_login', 'stopping'].includes(snapshot.state);
const reasons: Record<string, string> = {
  public_content_requires_login: 'No public comments are accessible. Facebook is asking for sign-in.',
  access_denied: 'Facebook says this content is unavailable.',
  unsupported_page_layout: 'No readable comments were found on this page.',
  content_not_loaded: 'Comments did not finish loading. You can try Start again.',
  no_extractable_visible_content: 'The visible comments could not be read.',
  no_extractable_posts: 'No readable source content was found.',
  browser_closed_unexpectedly: 'Chromium was closed. Click Start to try again.',
  source_navigation_changed: 'The source page changed. Paste its link to start a new collection.',
};
function status(text: string, error = false): void { $('status').textContent = text; $('status').classList.toggle('error', error); }
function renderState(): void {
  const running = active(), saved = snapshot.records.length;
  $<HTMLTextAreaElement>('source-url').disabled = running || submitting;
  const button = $<HTMLButtonElement>('start');
  button.disabled = submitting || snapshot.state === 'stopping';
  button.textContent = snapshot.state === 'stopping' ? 'Stopping…' : submitting ? 'Opening…' : running ? 'Stop' : 'Start';
  $('record-count').textContent = String(saved);
  $('empty').hidden = saved > 0;
  const download = $<HTMLAnchorElement>('download');
  download.hidden = saved === 0 || !snapshot.run_id;
  if (snapshot.run_id) download.href = `/api/runs/${encodeURIComponent(snapshot.run_id)}/data.json`;
  if (requestError) status(requestError, true);
  else if (disconnected) status('Connecting to the local app…');
  else if (submitting || snapshot.state === 'starting') status('Opening Chromium beside this panel…');
  else if (snapshot.state === 'stopping') status('Stopping. Saved comments are kept.');
  else if (snapshot.state === 'running') status(scrolling ? `Scrolling through comments · ${saved} saved.` : saved ? `Collecting comments · ${saved} saved.` : 'Reading the comments in Chromium…');
  else if (snapshot.state === 'paused') status('Collection is paused.');
  else if (snapshot.state === 'waiting_login') status('Facebook is asking for sign-in.');
  else if (snapshot.state === 'failed') status(snapshot.reason === 'public_content_requires_login' && saved ? `${saved} comments saved. Facebook is asking for sign-in to continue.` : reasons[snapshot.reason ?? ''] ?? 'Collection stopped. Check the source in Chromium and try Start again.', true);
  else if (snapshot.state === 'completed' || snapshot.state === 'stopped') status(`${saved} ${saved === 1 ? 'comment' : 'comments'} collected${snapshot.state === 'stopped' ? ' · stopped' : snapshot.reason === 'post_limit_reached' ? ' · collection limit reached' : ''}.`);
  else status('Ready.');
}
const collectionMotion = new Map<HTMLElement, Animation>();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function move(el: HTMLElement, frames: Keyframe[], duration: number): void {
  collectionMotion.get(el)?.cancel();
  const animation = el.animate(frames, { duration, easing: 'cubic-bezier(.22,1,.36,1)' });
  collectionMotion.set(el, animation);
  void animation.finished.catch(() => {}).then(() => { if (collectionMotion.get(el) === animation) collectionMotion.delete(el); });
}
reducedMotion.addEventListener('change', () => { if (reducedMotion.matches) { for (const animation of collectionMotion.values()) animation.cancel(); collectionMotion.clear(); } });
function appendRecord(record: PostRecord, arriving = false): void {
  if (knownRecords.has(record.record_id)) return;
  const list = $('record-list');
  // Measure the current animated positions so bursts smoothly retarget existing rows.
  const previous = arriving && !reducedMotion.matches ? [...list.children].map(el => ({ el: el as HTMLElement, rect: el.getBoundingClientRect() })).filter(({ rect }) => rect.bottom > 0 && rect.top < innerHeight).slice(0, 16) : [];
  for (const { el } of previous) collectionMotion.get(el)?.cancel();
  knownRecords.add(record.record_id);
  const item = document.createElement('li'); item.className = 'record'; item.dataset.recordId = record.record_id;
  if (record.source_mode === 'fixture') { const label = document.createElement('span'); label.className = 'test-label'; label.textContent = 'TEST FIXTURE'; item.append(label); }
  const text = document.createElement('p'); text.dir = 'auto'; text.textContent = record.text;
  const meta = document.createElement('div'); meta.className = 'record-meta';
  const time = document.createElement('time'); time.dateTime = record.captured_at;
  time.textContent = new Date(record.captured_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const link = document.createElement('a'); link.href = record.post_url ?? record.source_url; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = record.post_url ? 'Source ↗' : 'Source page ↗';
  meta.append(link, time); item.append(text, meta); list.prepend(item);
  if (arriving && !reducedMotion.matches) {
    for (const { el, rect } of previous) {
      const shift = rect.top - el.getBoundingClientRect().top;
      if (Math.abs(shift) > .5) move(el, [{ transform: `translateY(${shift}px)` }, { transform: 'translateY(0)' }], 460);
    }
    move(item, [{ opacity: 0, transform: 'translate(24px,-12px) scale(.98)', backgroundColor: '#e9fff7' }, { opacity: 1, transform: 'translate(0,0) scale(1)', backgroundColor: '#fff' }], 520);
    move($('record-count'), [{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], 380);
  }
}
function renderRecords(): void { for (const animation of collectionMotion.values()) animation.cancel(); collectionMotion.clear(); knownRecords.clear(); $('record-list').replaceChildren(); snapshot.records.forEach(record => appendRecord(record)); }
async function api(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? 'Request failed'); return result;
}
$('fixture-note').hidden = mode !== 'fixture';
$('source-url').addEventListener('input', () => { sourceEdited = true; });
if (mode === 'fixture') {
  $<HTMLTextAreaElement>('source-url').value = new URL(`/fixture${collectionTarget === 'comments' ? '?target=comments' : ''}`, location.origin).href;
}
$('crawl-form').addEventListener('submit', async event => {
  event.preventDefault();
  requestError = null;
  if (submitting || snapshot.state === 'stopping') return;
  if (active()) {
    submitting = true; renderState();
    try { await api('/api/stop', {}); } catch (error) { requestError = String(error); } finally { submitting = false; renderState(); }
    return;
  }
  const url = $<HTMLTextAreaElement>('source-url').value.trim();
  if (!url) { status('Paste a Facebook post link.', true); return; }
  submitting = true; renderState();
  try {
    await api('/api/start', { mode, collectionTarget, url, authorized: true, browserMode: 'fresh', publicOnly: mode === 'facebook', visibleOnly: false, keepBrowserOpen: mode === 'facebook', ...(mode === 'fixture' ? { fixtureScroll: query.get('scroll') === '1', recordVideo: defaults.recordVideo === true, screenshots: defaults.screenshots === true } : {}) });
  } catch (error) { requestError = error instanceof Error ? error.message : String(error); }
  finally { submitting = false; renderState(); }
});
const stream = new EventSource('/api/events');
stream.addEventListener('snapshot', event => {
  const incoming = JSON.parse((event as MessageEvent).data) as Snapshot;
  lastSeq = incoming.events.at(-1)?.seq ?? 0;
  // A new panel starts empty. Reconnects retain this panel's run, and opening
  // during an active crawl shows its real progress without starting another one.
  const inProgress = ['starting', 'running', 'paused', 'waiting_login', 'stopping'].includes(incoming.state);
  snapshot = inProgress || incoming.run_id === visibleRunId ? incoming : { state: 'idle', run_id: null, mode: null, config: null, counters: emptyCounters(), records: [], events: [], reason: null };
  visibleRunId = snapshot.run_id;
  if (snapshot.config && snapshot.mode === mode) $<HTMLTextAreaElement>('source-url').value = snapshot.config.url;
  renderRecords(); renderState();
});
stream.addEventListener('crawl', event => {
  const item = JSON.parse((event as MessageEvent).data) as CrawlEvent;
  if (snapshot.run_id !== item.run_id) {
    snapshot = { state: 'starting', run_id: item.run_id, mode, config: null, counters: emptyCounters(), records: [], events: [], reason: null }; lastSeq = 0; visibleRunId = item.run_id; renderRecords();
  }
  if (item.seq <= lastSeq) return;
  lastSeq = item.seq; countEvent(snapshot.counters, item);
  if (item.type === 'scroll_started') scrolling = true;
  if (['post_discovered', 'extraction_started', 'record_saved', 'state_changed'].includes(item.type)) scrolling = false;
  if (item.state) snapshot.state = item.state;
  if (item.reason && (item.type === 'state_changed' || item.type === 'crawl_completed')) snapshot.reason = item.reason;
  if (item.type === 'record_saved' && item.record) { snapshot.records.push(item.record); appendRecord(item.record, true); }
  renderState();
});
stream.onopen = () => { disconnected = false; renderState(); };
stream.onerror = () => { disconnected = true; renderState(); };
void fetch('/api/config').then(r => r.json()).then(value => {
  defaults = value; if (!snapshot.run_id && !sourceEdited && mode === 'facebook') $<HTMLTextAreaElement>('source-url').value = String(value.url);
}).catch(() => {});
renderState();
