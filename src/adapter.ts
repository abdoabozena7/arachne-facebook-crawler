import type { Page } from 'playwright';
import type { AccessObservation, Candidate, ExtractedFields, Mode, ScrollObservation } from './types.js';
export interface SourceAdapter { access(): Promise<AccessObservation>; discover(): Promise<Candidate[]>; focus(c: Candidate): Promise<Candidate>; extract(id: string): Promise<ExtractedFields>; scroll(): Promise<ScrollObservation | void>; loadMore(): Promise<boolean>; dismissOptionalLogin(): Promise<boolean>; url(): string }
export class FacebookAdapter {
  constructor(readonly page: Page, readonly mode: Mode, readonly focusScroll = true) {}
  async access(): Promise<AccessObservation> { return this.page.evaluate(() => window.__arachneDom?.access() ?? { status: 'loading', reason: 'DOM observer not installed yet' }); }
  async discover(): Promise<Candidate[]> { return this.page.evaluate(() => window.__arachneDom?.discover() ?? []); }
  async focus(candidate: Candidate): Promise<Candidate> {
    return this.page.evaluate(({ id, canScroll }) => {
      const el = window.__arachneDom?.target(id);
      if (!el?.isConnected) throw new Error('post_removed_from_dom');
      if (canScroll && (el.getBoundingClientRect().top < 65 || el.getBoundingClientRect().bottom > innerHeight)) el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const c = window.__arachneDom?.discover().find(c => c.element_id === id);
      if (!c) throw new Error('post_left_viewport');
      return c;
    }, { id: candidate.element_id, canScroll: this.focusScroll });
  }
  async extract(id: string): Promise<ExtractedFields> {
    return this.page.evaluate(id => {
      if (!window.__arachneDom) throw new Error('selector_not_found: DOM observer');
      return window.__arachneDom.extract(id);
    }, id);
  }
  url(): string { return this.page.url(); }
  async loadMore(): Promise<boolean> { return this.page.evaluate(() => window.__arachneDom?.loadMore() ?? false); }
  async dismissOptionalLogin(): Promise<boolean> { return this.page.evaluate(() => window.__arachneDom?.dismissOptionalLogin() ?? false); }
  async scroll(): Promise<ScrollObservation | undefined> { return this.page.evaluate(() => window.__arachneDom?.scroll()); }
}
