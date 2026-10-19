import type { AccessObservation, Candidate, DomAPI, ExtractedFields, Mode, Rect, ScrollObservation } from '../types.js';

export function installDom(mode: Mode, collectionTarget: 'posts' | 'comments' = 'posts'): DomAPI {
  const identities = new WeakMap<Element, string>();
  const elements = new Map<string, Element>();
  let serial = 0;
  let commentScrollRoot: HTMLElement | null = null;
  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const visible = (el: Element): boolean => {
    if (!el.isConnected || el.closest('[data-arachne-overlay]')) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0' && !!el.getClientRects().length;
  };
  const exposed = (el: Element, r: DOMRect): boolean => {
    const left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    if (right <= left || bottom <= top) return false;
    // CSS-visible content can still be covered by a login modal or fixed banner.
    return [0.2, 0.5, 0.8].some(y => [0.2, 0.5, 0.8].some(x => {
      const hit = document.elementFromPoint(left + (right - left) * x, top + (bottom - top) * y);
      return !!hit && (hit === el || el.contains(hit));
    }));
  };
  const inViewport = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    return visible(el) && exposed(el, r);
  };
  const rectOf = (el: Element): Rect => {
    const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const permalink = (href: string): string | null => {
    try {
      const url = new URL(href, location.href);
      if (mode === 'fixture') return url.origin === location.origin && url.pathname === '/fixture' && (url.searchParams.has('post') || url.searchParams.has('comment_id')) ? url.href : null;
      if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return null;
      const postPath = /\/(posts|videos|reel)\/[^/]+|\/permalink\/|\/(story|permalink)\.php|\/photo\/?$/i;
      let base = url;
      if (!postPath.test(url.pathname)) {
        // Logged-out Facebook puts a genuine encoded comment ID on an author
        // link. Attach that observed identity to the current actual post URL.
        if (collectionTarget !== 'comments' || !url.searchParams.has('comment_id') || !/(^|\.)facebook\.com$/i.test(location.hostname) || !postPath.test(location.pathname)) return null;
        base = new URL(location.href);
      }
      const clean = new URL(base.pathname, 'https://www.facebook.com');
      for (const key of ['story_fbid', 'id', 'fbid']) if (base.searchParams.has(key)) clean.searchParams.set(key, base.searchParams.get(key)!);
      for (const key of ['story_fbid', 'id', 'fbid', 'comment_id', 'reply_comment_id']) if (url.searchParams.has(key)) clean.searchParams.set(key, url.searchParams.get(key)!);
      for (const key of ['comment_id', 'reply_comment_id']) {
        const value = clean.searchParams.get(key);
        if (!value || /^\d+$/.test(value)) continue;
        try {
          const match = atob(value).match(/^comment:(?:(\d+)_)?(\d+)$/);
          const parentId = clean.searchParams.get('fbid') ?? clean.searchParams.get('story_fbid') ?? clean.pathname.match(/\/posts\/([^/]+)/)?.[1];
          if (match && (!match[1] || !parentId || match[1] === parentId)) clean.searchParams.set(key, match[2]);
        } catch { /* Retain a genuine opaque identity rather than guess a value. */ }
      }
      return clean.href;
    } catch { return null; }
  };
  const sourceLink = (el: Element): string | null => {
    for (const a of el.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!visible(a) || a.closest('[role="article"]') && a.closest('[role="article"]') !== el && el.matches('[role="article"]')) continue;
      const link = permalink(a.href);
      if (link && (collectionTarget !== 'comments' || new URL(link).searchParams.has('comment_id'))) return link;
    }
    return null;
  };
  const discover = (): Candidate[] => {
    for (const [id, el] of elements) if (!el.isConnected) elements.delete(id);
    const found = new Map<Element, string>();
    if (mode === 'fixture') document.querySelectorAll(collectionTarget === 'comments' ? '[data-fixture-comment]' : '[data-fixture-post]').forEach(el => found.set(el, `fixture:semantic_${collectionTarget === 'comments' ? 'comment' : 'article'}`));
    else if (collectionTarget === 'comments') {
      document.querySelectorAll('[role="article"], [aria-label]').forEach(el => {
        const label = el.getAttribute('aria-label') ?? '';
        if (/^(comment by|reply by|تعليق من|رد من)/i.test(label)) found.set(el, 'facebook:comment_aria_label');
      });
      document.querySelectorAll<HTMLAnchorElement>('a[href*="comment_id="]').forEach(a => {
        if (!visible(a)) return;
        const article = a.closest('[role="article"]');
        if (article && ![...found.keys()].some(other => other === article || article.contains(other))) found.set(article, 'facebook:comment_permalink_article');
      });
    }
    else {
      document.querySelectorAll('[role="article"]').forEach(el => {
        if (el.parentElement?.closest('[role="article"]')) return; // Nested articles are usually comments.
        const r = el.getBoundingClientRect();
        const message = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
        if (r.width >= 240 && r.height >= 90 && (message || sourceLink(el))) found.set(el, 'facebook:role_article');
      });
      document.querySelectorAll('[data-pagelet^="FeedUnit"]').forEach(el => {
        if (![...found.keys()].some(other => other.contains(el) || el.contains(other))) found.set(el, 'facebook:feed_unit');
      });
      document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
        if (!permalink(a.href) || !visible(a)) return;
        let el: Element | null = a.parentElement;
        for (let depth = 0; el && depth < 9; depth++, el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (el.matches('main, [role="main"], [role="feed"], body')) break;
          const message = el.querySelector('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
          const actions = [...el.querySelectorAll('[role="button"], button')].some(b => /^(like|comment|share)$/i.test((b.textContent ?? '').trim()));
          if (r.width >= 240 && r.height >= 110 && r.height <= 2500 && (message || actions)) {
            if (![...found.keys()].some(other => other.contains(el!) || el!.contains(other))) found.set(el, 'facebook:permalink_ancestor');
            break;
          }
        }
      });
    }
    return [...found].filter(([el]) => inViewport(el)).map(([el, strategy]) => {
      let id = identities.get(el);
      if (!id) { id = `dom-${documentId}-${++serial}`; identities.set(el, id); }
      elements.set(id, el);
      const message = [...el.querySelectorAll(collectionTarget === 'comments' ? '[data-comment-text], [lang], [data-post-text]' : '[data-post-text], [data-ad-preview="message"], [data-ad-comet-preview="message"]')].find(b => !b.closest('a, [role="link"], button, [role="button"], [role="heading"]'));
      const preview = message ? visibleText(message).slice(0, 480) : undefined;
      return { element_id: id, strategy, rect: rectOf(el), preview, locator: `${strategy}; document element ${id}; ${sourceLink(el) ?? 'no permalink observed'}` };
    }).filter(candidate => collectionTarget !== 'comments' || candidate.preview !== '');
  };
  const visibleText = (root: Element): string => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    const parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const image = node as HTMLImageElement;
        if (image.tagName === 'IMG' && inViewport(image) && /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]+$/u.test(image.alt)) parts.push(image.alt);
        continue;
      }
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest('script, style, noscript, button, [role="button"], [aria-hidden="true"], [role="menu"], [role="textbox"]')) continue;
      // A text node must actually intersect the viewport; hidden or offscreen text isn't evidence.
      const range = document.createRange(); range.selectNodeContents(node);
      if (![...range.getClientRects()].some(r => exposed(parent, r))) continue;
      const value = node.textContent?.replace(/\s+/g, ' ').trim(); if (value) parts.push(value);
    }
    return parts.join(' ').trim();
  };
  const extract = (id: string): ExtractedFields => {
    const el = elements.get(id);
    if (!el?.isConnected) throw new Error('post_removed_from_dom');
    if (!inViewport(el)) throw new Error('post_left_viewport');
    let textStrategy = mode === 'fixture' ? 'fixture:explicit_text' : collectionTarget === 'comments' ? 'facebook:comment_lang_text' : 'facebook:message_attribute';
    let blocks = [...el.querySelectorAll(mode === 'fixture' ? collectionTarget === 'comments' ? '[data-comment-text]' : '[data-post-text]' : collectionTarget === 'comments' ? '[lang]' : '[data-ad-preview="message"], [data-ad-comet-preview="message"]')].filter(block => {
      if (!visible(block)) return false;
      if (collectionTarget === 'comments' && block.closest('a, [role="link"], button, [role="button"], header, footer, [role="heading"], [role="textbox"]')) return false;
      const article = block.closest('[role="article"]');
      if (el.matches('[role="article"]')) return article === el;
      return !article?.parentElement?.closest('[role="article"]');
    });
    if (!blocks.length && mode === 'facebook') {
      textStrategy = 'facebook:visible_dir_auto';
      blocks = [...el.querySelectorAll('[dir="auto"]')].filter(b => {
        const article = b.closest('[role="article"]');
        return inViewport(b) && (!el.matches('[role="article"]') || article === el) &&
          !b.closest('button, a, [role="link"], [role="button"], header, footer, [role="heading"], [role="textbox"]') &&
          visibleText(b).length >= (collectionTarget === 'comments' ? 1 : 30) &&
          !/^(author|top fan|بواسطة الكاتب|من أبرز المعجبين)$/i.test(visibleText(b));
      });
      // Prefer leaf text blocks so a container cannot bring in unrelated action rows.
      blocks = blocks.filter(b => !blocks.some(other => other !== b && b.contains(other)));
    }
    if (!blocks.length) throw new Error('selector_not_found: visible post message');
    blocks = blocks.filter(b => !blocks.some(other => other !== b && b.contains(other)));
    const text = [...new Set(blocks.map(visibleText).filter(Boolean))].join('\n');
    if (!text) throw new Error('no_visible_post_text');
    const url = sourceLink(el);
    let postId: string | null = null;
    if (url) {
      const parsed = new URL(url);
      postId = mode === 'fixture' ? parsed.searchParams.get('post') : parsed.searchParams.get('story_fbid') ?? parsed.searchParams.get('fbid') ?? parsed.pathname.match(/\/(?:posts|videos|reel|permalink)\/([^/]+)/)?.[1] ?? null;
    }
    let published: string | null = null;
    const time = el.querySelector('time[datetime], [data-utime]');
    if (time && visible(time)) {
      const raw = time.getAttribute('datetime');
      const utime = time.getAttribute('data-utime');
      const date = raw ? new Date(raw) : utime && /^\d{10}$/.test(utime) ? new Date(Number(utime) * 1000) : null;
      if (date && !Number.isNaN(date.valueOf())) published = raw && !/(Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : date.toISOString();
    }
    const metric = (word: string): number | null => {
      for (const item of el.querySelectorAll('[aria-label], span')) {
        if (!inViewport(item)) continue;
        if (el.matches('[role="article"]') && item.closest('[role="article"]') !== el) continue;
        const label = item.getAttribute('aria-label') ?? item.textContent?.trim() ?? '';
        const match = label.match(new RegExp(`^([0-9]+(?:,[0-9]{3})*) ${word}s?$`, 'i'));
        if (match) return Number(match[1].replaceAll(',', ''));
      }
      return null;
    };
    const strategy = discover().find(c => c.element_id === id)?.strategy ?? 'observed_element';
    const observedURL = new URL(location.href);
    for (const key of [...observedURL.searchParams.keys()]) if (!['id', 'story_fbid', 'fbid', ...(mode === 'fixture' ? ['post'] : [])].includes(key)) observedURL.searchParams.delete(key);
    observedURL.hash = '';
    return {
      record_type: collectionTarget === 'comments' ? 'comment' : 'post',
      ...(collectionTarget === 'comments' ? { comment_id: url ? new URL(url).searchParams.get('comment_id') : null, parent_post_url: (() => { const u = new URL(url ?? observedURL.href); u.searchParams.delete('comment_id'); u.searchParams.delete('reply_comment_id'); return u.href; })() } : {}),
      post_url: url, post_id: postId, text, published_at: published,
      reaction_count: metric('reaction'), comment_count: collectionTarget === 'comments' ? null : metric('comment'), share_count: collectionTarget === 'comments' ? null : metric('share'),
      diagnostic: { strategy, locator: `${strategy}; ${id}; ${url ?? observedURL.href}`, observed_url: observedURL.href, text_strategy: textStrategy, reference_kind: url ? 'permalink' : 'observed_element', visible_only: true, truncated: [...el.querySelectorAll('button, [role="button"]')].some(b => /^(see more|عرض المزيد)$/i.test(b.textContent?.trim() ?? '')) }
    };
  };
  const access = (): AccessObservation => {
    if (mode === 'fixture') return { status: 'accessible', reason: 'Explicit local fixture mode' };
    const text = document.body?.innerText?.slice(0, 24000) ?? '';
    const password = [...document.querySelectorAll('input[type="password"]')].some(visible);
    if (/\/login|\/checkpoint|\/two_step_verification/.test(location.pathname)) return { status: 'login_required', reason: 'Facebook navigated to a sign-in or verification page.' };
    const candidates = discover();
    const authDialog = [...document.querySelectorAll('[role="dialog"]')].find(el => visible(el) && (
      [...el.querySelectorAll('input[type="password"]')].some(visible) ||
      [...el.querySelectorAll('h1, h2, [role="heading"]')].some(h => /^(log in|sign in|تسجيل الدخول)/i.test(h.textContent?.trim() ?? ''))
    ));
    if (authDialog && !candidates.some(c => authDialog.contains(elements.get(c.element_id)!))) return { status: 'login_required', reason: 'A sign-in dialog blocks the source content.' };
    // A header/footer login invitation does not revoke access to exposed public posts.
    if (candidates.length) return { status: 'accessible', reason: `Exposed ${collectionTarget} candidates observed${password ? ' alongside a non-blocking sign-in banner' : ''}` };
    const visibleSourceImage = [...document.querySelectorAll('img')].some(el => { const r = el.getBoundingClientRect(); return r.width > 180 && r.height > 180 && inViewport(el); });
    if (password && !visibleSourceImage) return { status: 'login_required', reason: 'Sign-in fields are visible and no exposed source content was found.' };
    if (/you.re temporarily blocked|access denied|this content isn.t available|this page isn.t available|you can.t use this feature|تم حظرك مؤقت|هذا المحتوى غير متاح/i.test(text)) return { status: 'denied', reason: 'Facebook reports unavailable content or an access restriction. Collection stopped.' };
    if (document.readyState !== 'complete' || [...document.querySelectorAll('[role="progressbar"], [aria-busy="true"]')].some(visible)) return { status: 'loading', reason: 'Content has not finished loading' };
    return { status: 'unsupported', reason: 'No visible post candidates match the adapter. Layout, language, or unloaded content may be unsupported.' };
  };
  const loadMore = async (): Promise<boolean> => {
    if (collectionTarget !== 'comments') return false;
    const button = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find(b => inViewport(b) && /^(?:(?:view|see|load)(?:\s+[\d,]+)?\s+(?:more|previous)\s+comments|عرض (?:المزيد|مزيد)(?: من)? التعليقات|عرض التعليقات السابقة)$/i.test(b.innerText.trim()));
    if (!button) return false; button.click(); return true;
  };
  const scroll = async (): Promise<ScrollObservation> => {
    let root: HTMLElement | null = null;
    if (collectionTarget === 'comments') {
      const candidate = [...elements.values()].find(el => el.isConnected && inViewport(el)) ?? [...elements.values()].find(el => el.isConnected);
      let parent = candidate?.parentElement;
      while (parent && parent !== document.body) {
        if (parent.scrollHeight > parent.clientHeight + 20 && parent.clientHeight > 120 && /auto|scroll/.test(getComputedStyle(parent).overflowY)) { root = parent; commentScrollRoot = parent; break; }
        parent = parent.parentElement;
      }
      if (!root && commentScrollRoot?.isConnected) root = commentScrollRoot;
    }
    const before = root ? root.scrollTop : window.scrollY, height = root ? root.clientHeight : innerHeight;
    (root ?? window).scrollBy({ top: Math.round(height * 0.55), behavior: 'smooth' });
    await new Promise(resolve => setTimeout(resolve, 450));
    return { scope: root ? 'comments' : 'page', before, after: root ? root.scrollTop : window.scrollY, height };
  };
  const dismissOptionalLogin = (): boolean => {
    if (/\/login|\/checkpoint/.test(location.pathname)) return false;
    const dialog = [...document.querySelectorAll('[role="dialog"]')].find(el => visible(el) && (el.querySelector('input[type="password"]') || /log in|sign in|تسجيل الدخول/i.test(el.textContent ?? '')));
    const close = dialog && [...dialog.querySelectorAll<HTMLElement>('button, [role="button"]')].find(b => visible(b) && /^(close|dismiss|إغلاق)$/i.test(b.getAttribute('aria-label') ?? b.innerText.trim()));
    if (!close) return false; close.click(); return true;
  };
  return { discover, extract, access, loadMore, scroll, dismissOptionalLogin, target: id => elements.get(id), clear: () => elements.clear() };
}
