import { installDom } from './dom.js';
import { SpiderNetwork } from './network.js';
import { animationAction } from '../events.js';
import type { CrawlEvent, Rect } from '../types.js';

function install(): void {
  if (window !== window.top || window.__arachneOverlay) return;
  window.__arachneDom = installDom(window.__ARACHNE_MODE__ ?? 'facebook', window.__ARACHNE_TARGET__ ?? 'posts');
  const host = document.createElement('div'); host.setAttribute('data-arachne-overlay', 'true');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;contain:layout style;';
  const shadow = host.attachShadow({ mode: 'closed' });
  let authNotified = false, authCheckPending = false;
  const notifyAuthentication = (): void => {
    if (authNotified) return;
    authNotified = true; void window.__arachneNoticeAuthentication?.().catch(() => {});
  };
  const checkAuthentication = (): void => {
    authCheckPending = false;
    if (/\/login|\/checkpoint|\/two_step_verification/.test(location.pathname) || [...document.querySelectorAll('input[type="password"]')].some(el => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))) notifyAuthentication();
  };
  const authObserver = new MutationObserver(() => {
    if (authNotified || authCheckPending) return;
    authCheckPending = true; queueMicrotask(checkAuthentication);
  });
  authObserver.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['type', 'hidden', 'style', 'class'] });
  const passwordFocused = (event: Event): void => { if ((event.target as Element)?.matches('input[type="password"]')) notifyAuthentication(); };
  document.addEventListener('focusin', passwordFocused, true); document.addEventListener('input', passwordFocused, true);
  checkAuthentication();
  shadow.innerHTML = `<style>
    :host{pointer-events:none!important}*{box-sizing:border-box}canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
    .dock{position:absolute;left:-260px;top:35%;width:196px;visibility:hidden;font:12px system-ui}
    .brand{color:#b99aff;letter-spacing:3px;font-size:10px}.count{font-size:25px;margin:8px 0 4px}.status{color:#a8adbe}.field{position:absolute;border:1px solid #50e5d8;background:#50e5d818;border-radius:3px;box-shadow:0 0 15px #50e5d830}
    .label{position:absolute;background:#111524e8;color:#ad90ff;font:10px monospace;padding:4px 7px;border:1px solid #ad90ff70;border-radius:3px}
    .preview{position:absolute;width:260px;padding:12px 16px;border:1px solid #80f4c5;color:#111;background:#fffffff5;border-radius:5px;box-shadow:0 0 18px #80f4c525;font:650 13px/1.45 system-ui;white-space:normal;overflow:hidden;max-height:90px}
    .fragment{position:absolute;white-space:nowrap;overflow:hidden;max-width:75vw;padding:3px 7px;font:22px/1.3 Consolas,monospace;color:#130718;background:#f029d5;box-shadow:0 0 12px #f029d538;transform-origin:left center}.identifier{background:none;color:#77e9bd;font-size:29px;letter-spacing:2px;border:1px solid #77e9bd77}
  </style><canvas></canvas><div class="dock"><div class="brand">ARACHNE / ${window.__ARACHNE_MODE__ === 'fixture' ? 'TEST FIXTURE' : 'LIVE DOM'}</div><div class="count"><span>0</span> saved</div><div class="status">Awaiting observation</div></div>`;
  document.documentElement.append(host);
  let targetId: string | undefined;
  let saved = 0;
  const status = shadow.querySelector('.status')!;
  const animations = new Set<Animation>();
  const tethers = new Map<HTMLElement, { source: Element; label: boolean }>();
  let tetherFrame = 0;
  const followHighlights = (): void => {
    for (const [box, { source, label }] of tethers) {
      if (!box.isConnected || !source.isConnected) { box.remove(); tethers.delete(box); continue; }
      const r = source.getBoundingClientRect();
      box.style.left = `${label ? Math.max(8, r.x) : r.x}px`; box.style.top = `${label ? Math.max(8, r.y - 24) : r.y}px`;
      if (!label) { box.style.width = `${r.width}px`; box.style.height = `${r.height}px`; }
      box.style.visibility = r.bottom < 0 || r.top > innerHeight ? 'hidden' : 'visible';
    }
    tetherFrame = requestAnimationFrame(followHighlights);
  };
  tetherFrame = requestAnimationFrame(followHighlights);
  const getRect = (): Rect | null => {
    const el = targetId && window.__arachneDom?.target(targetId);
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const relatedRects = (): Rect[] => {
    const el = targetId ? window.__arachneDom?.target(targetId) : undefined; if (!el?.isConnected) return [];
    return [...el.querySelectorAll('[data-post-text], [data-comment-text], [lang] [dir="auto"], [data-ad-preview="message"], [data-ad-comet-preview="message"], a[href]')].filter(field => field.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).slice(0, 10).map(field => {
      const r = field.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  };
  const network = new SpiderNetwork(shadow.querySelector('canvas')!, getRect, 0.48, relatedRects);
  const animate = (el: HTMLElement, frames: Keyframe[], duration: number): void => {
    shadow.append(el); const a = el.animate(frames, { duration: duration / network.speed, easing: 'cubic-bezier(.22,.7,.25,1)', fill: 'forwards' });
    animations.add(a); a.finished.then(() => { animations.delete(a); tethers.delete(el); el.remove(); }).catch(() => { tethers.delete(el); el.remove(); });
    if (network.paused) a.pause();
  };
  const highlight = (): void => {
    const el = targetId && window.__arachneDom?.target(targetId); if (!el) return;
    const fields = [...el.querySelectorAll('[data-post-text], [data-comment-text], [lang] [dir="auto"], [data-ad-preview="message"], [data-ad-comet-preview="message"], a[href], [dir="auto"]')].slice(0, 14);
    for (const [index, field] of fields.entries()) {
      const r = field.getBoundingClientRect(); if (r.width < 5 || r.height < 5 || r.bottom < 0 || r.top > innerHeight) continue;
      const box = document.createElement('div'); box.className = 'field';
      box.style.cssText = `left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px`;
      const color = ['#f52bd3', '#7061ff', '#4bc5fa', '#66edc0'][index % 4]; box.style.borderColor = color;
      box.style.backgroundColor = color + (field.matches('a') ? '1a' : '40');
      animate(box, [{ opacity: 0, transform: 'scale(.99)' }, { opacity: 1, offset: 0.2, transform: 'scale(1.01)' }, { opacity: 0, transform: 'scale(1)' }], 1400);
      tethers.set(box, { source: field, label: false });
    }
    const r = getRect(); if (r) {
      const label = document.createElement('div'); label.className = 'label'; label.textContent = 'OBSERVED ELEMENT / VISIBLE TEXT';
      label.style.cssText = `left:${Math.max(8, r.x)}px;top:${Math.max(8, r.y - 24)}px`;
      animate(label, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 0 }], 1600);
      tethers.set(label, { source: el, label: true });
    }
  };
  const fragment = (text: string, id = false): void => {
    const r = getRect(); if (!r || !text) return;
    const piece = document.createElement('div'); piece.className = `fragment${id ? ' identifier' : ''}`; piece.textContent = text.slice(0, 76);
    piece.style.left = `${Math.max(10, Math.min(innerWidth - 200, r.x + 8))}px`; piece.style.top = `${Math.max(65, Math.min(innerHeight - 80, r.y + r.height * .6))}px`;
    animate(piece, [{ opacity: 0, transform: 'scale(.75) rotate(-7deg)' }, { opacity: .94, transform: 'scale(1.2) rotate(3deg)', offset: .2 }, { opacity: .8, transform: 'translate(70px,-55px) scale(1.15) rotate(-17deg)', offset: .65 }, { opacity: 0, transform: 'translate(120px,60px) scale(.6) rotate(18deg)' }], 1700);
  };
  window.__arachneOverlay = {
    setSpeed(speed) { network.speed = speed; },
    event(event: CrawlEvent) {
      if (event.saved_count !== undefined) { saved = event.saved_count; shadow.querySelector('.count span')!.textContent = String(saved); }
      if (event.animationSpeed) network.speed = event.animationSpeed;
      const action = animationAction(event.type);
      if (event.element_id && ['seek', 'focus', 'scan', 'collect', 'failure'].includes(action)) targetId = event.element_id;
      if (action === 'state') {
        network.paused = ['paused', 'waiting_login', 'stopping'].includes(event.state ?? '');
        for (const a of animations) network.paused ? a.pause() : a.play();
        status.textContent = event.state === 'waiting_login' ? 'Manual sign-in required' : event.state ?? 'Ready';
      }
      if (action === 'focus' || action === 'seek') { network.signal(); status.textContent = 'Observing visible post'; }
      if (action === 'scan') { network.signal(); highlight(); if (event.preview) fragment(event.preview); status.textContent = 'Extracting visible data'; }
      if (action === 'failure') { network.signal(false, true); status.textContent = event.reason === 'login_required' ? 'Manual sign-in required' : 'Extraction unavailable'; }
      if (action === 'skip') { status.textContent = 'Duplicate skipped'; }
      if (action === 'scroll') { targetId = undefined; status.textContent = 'Observing new viewport'; }
      // Only a persisted record can create a success preview or increment this count.
      if (action === 'collect' && event.record && event.record_id) {
        if (event.saved_count === undefined) saved++;
        shadow.querySelector('.count span')!.textContent = String(saved);
        network.signal(true); status.textContent = 'Committed to collection';
        fragment(event.record.comment_id ?? event.record.post_id ?? event.record.text.slice(0, 52), !!(event.record.comment_id ?? event.record.post_id));
        const r = getRect(); if (!r) return;
        const preview = document.createElement('div'); preview.className = 'preview'; preview.textContent = event.record.text.slice(0, 130);
        const x = Math.max(12, Math.min(innerWidth - 280, r.x + 25)), y = Math.max(80, Math.min(innerHeight - 120, r.y + 80));
        preview.style.left = `${x}px`; preview.style.top = `${y}px`;
        const dock = shadow.querySelector('.dock')!.getBoundingClientRect();
        animate(preview, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1.06)', offset: 0.24 }, { opacity: 1, transform: 'scale(1)', offset: 0.48 }, { opacity: 0, transform: `translate(${dock.x - x}px, ${dock.y - y}px) scale(.15)` }], 1700);
      }
    },
    destroy() { network.destroy(); authObserver.disconnect(); document.removeEventListener('focusin', passwordFocused, true); document.removeEventListener('input', passwordFocused, true); cancelAnimationFrame(tetherFrame); tethers.clear(); for (const a of animations) a.cancel(); host.remove(); window.__arachneOverlay = undefined; }
  };
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true }); else install();
