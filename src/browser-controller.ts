import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { readFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CrawlConfig, CrawlEvent } from './types.js';
import { RunStorage } from './storage.js';
import { FacebookAdapter } from './adapter.js';
import { positionWindow, type WindowBounds } from './windows.js';

export class BrowserController {
  browser?: Browser;
  context?: BrowserContext;
  page?: Page;
  adapter?: FacebookAdapter;
  intentionalClose = false;
  private recordingStarted = false;
  private recordedContext?: BrowserContext;
  private recordedPage?: Page;
  private recordingContainsAuth = false;
  private screenshots: string[] = [];
  private bundle = '';
  private closed = false;
  constructor(readonly config: CrawlConfig, readonly storage: RunStorage, readonly onClosed: () => void, readonly windowBounds?: WindowBounds) {}
  private async setup(context: BrowserContext): Promise<Page> {
    await context.exposeBinding('__arachneNoticeAuthentication', ({ page, frame }) => {
      if (page === this.recordedPage && frame === page.mainFrame()) this.recordingContainsAuth = true;
    });
    await context.addInitScript({ content: `window.__ARACHNE_MODE__ = ${JSON.stringify(this.config.mode)};window.__ARACHNE_TARGET__ = ${JSON.stringify(this.config.collectionTarget ?? 'posts')};\n${this.bundle}` });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('close', () => { if (page === this.page && !this.intentionalClose) this.onClosed(); });
    return page;
  }
  async open(): Promise<void> {
    this.bundle = await readFile(path.resolve('dist/overlay.js'), 'utf8');
    // Initial authentication context never records video, screenshots, or storageState to disk.
    this.browser = await chromium.launch({ headless: false, args: this.windowBounds ? [`--window-position=${this.windowBounds.left},${this.windowBounds.top}`, `--window-size=${this.windowBounds.width},${this.windowBounds.height}`] : [] });
    this.browser.on('disconnected', () => { if (!this.intentionalClose) this.onClosed(); });
    this.context = await this.browser.newContext({ viewport: null });
    this.page = await this.setup(this.context);
    if (this.windowBounds) {
      try { await this.storage.updateManifest({ source_window: await positionWindow(this.page, this.windowBounds) }); }
      catch { await this.storage.updateManifest({ window_positioning: 'unavailable; source browser remains visible' }); }
    }
    this.adapter = new FacebookAdapter(this.page, this.config.mode, !this.config.visibleOnly);
    await this.page.goto(this.config.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.page.waitForFunction(() => !!window.__arachneDom, { timeout: 8000 });
    if (this.config.mode === 'facebook') {
      // Public comments often render after the header's login fields. Give the
      // actual source a bounded loading opportunity before deciding it is gated.
      await this.page.waitForFunction(() => !!window.__arachneDom?.discover().length || /\/login|\/checkpoint|\/two_step_verification/.test(location.pathname), { timeout: 10000 }).catch(() => {});
    }
  }
  async startRecording(): Promise<boolean> {
    if (!this.config.recordVideo || this.config.publicOnly || this.config.keepBrowserOpen || this.recordingStarted) return false;
    this.recordingStarted = true;
    if (!this.browser || !this.context || !this.page) return false;
    const oldContext = this.context;
    const oldPage = this.page;
    try {
      // Keep the authenticated state only in process memory; never serialize it into run evidence.
      const state = await oldContext.storageState();
      const dir = path.join(this.storage.dir, '.video');
      await mkdir(dir, { recursive: true });
      const context = await this.browser.newContext({ viewport: null, storageState: state, recordVideo: { dir, size: { width: 1280, height: 900 } } });
      this.recordedContext = context;
      const page = await this.setup(context);
      this.recordedPage = page;
      await page.goto(oldPage.url(), { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForFunction(() => !!window.__arachneDom, { timeout: 8000 });
      const adapter = new FacebookAdapter(page, this.config.mode);
      const access = await adapter.access();
      if (access.status !== 'accessible') {
        await context.close(); await page.video()?.delete();
        this.recordedPage = undefined; this.recordedContext = undefined;
        await oldPage.bringToFront();
        await this.storage.updateManifest({ recording: { status: 'unavailable', reason: 'Authenticated content did not carry into the recording context; original browser remains usable.' } });
        return false;
      }
      this.page = page; this.context = context; this.adapter = adapter;
      await oldContext.close();
      await this.storage.updateManifest({ recording: { status: 'in_progress', reason: 'Recording started after initial access check; credentials are not exported.' } });
      return true;
    } catch (error) {
      await this.recordedContext?.close().catch(() => {});
      await this.recordedPage?.video()?.delete().catch(() => {});
      this.recordedPage = undefined; this.recordedContext = undefined;
      await this.storage.updateManifest({ recording: { status: 'unavailable', reason: String(error) } });
      return false;
    }
  }
  async suspendRecording(): Promise<void> {
    if (!this.recordedPage || !this.browser || !this.context || !this.page) return;
    // Discard the recording if a new authentication gate appears. Manual login happens in an unrecorded context.
    const state = await this.context.storageState();
    const currentURL = this.page.url();
    const recorded = this.recordedPage;
    this.page = undefined; // The deliberate context switch must not look like an unexpected browser close.
    await this.context.close(); await recorded.video()?.delete();
    this.recordedPage = undefined; this.recordedContext = undefined;
    this.context = await this.browser.newContext({ viewport: null, storageState: state });
    this.page = await this.setup(this.context);
    this.adapter = new FacebookAdapter(this.page, this.config.mode);
    await this.page.goto(currentURL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await this.storage.updateManifest({ recording: { status: 'discarded', reason: 'An authentication gate reappeared; video discarded to avoid retaining login interactions.' } });
  }
  async overlay(event: CrawlEvent): Promise<void> {
    if (!this.page || this.page.isClosed()) return;
    await this.page.evaluate(event => window.__arachneOverlay?.event(event), event).catch(() => {});
  }
  async screenshot(elementId: string, recordId: string): Promise<void> {
    if (!this.config.screenshots || this.screenshots.length >= 3 || !this.page) return;
    if ((await this.adapter?.access())?.status !== 'accessible') return;
    const rect = await this.page.evaluate(id => {
      const el = window.__arachneDom?.target(id); if (!el?.isConnected) return null;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, r.x), y = Math.max(0, r.y);
      return { x, y, width: Math.min(r.right, innerWidth) - x, height: Math.min(r.bottom, innerHeight) - y };
    }, elementId);
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const file = `screenshots/${recordId}.png`;
    const overlayVisibility = await this.page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-arachne-overlay]');
      if (!host) return null;
      const previous = host.style.visibility; host.style.visibility = 'hidden'; return previous;
    });
    try { await this.page.screenshot({ path: path.join(this.storage.dir, file), clip: rect }); }
    finally {
      await this.page.evaluate(previous => { const host = document.querySelector<HTMLElement>('[data-arachne-overlay]'); if (host && previous !== null) host.style.visibility = previous; }, overlayVisibility).catch(() => {});
    }
    this.screenshots.push(file);
    await this.storage.updateManifest({ screenshots: this.screenshots });
  }
  async close(keepOpen = false): Promise<void> {
    if (this.closed) return;
    this.intentionalClose = true;
    await this.page?.evaluate(() => { window.__arachneOverlay?.destroy(); window.__arachneDom?.clear(); }).catch(() => {});
    if (keepOpen && this.browser?.isConnected() && !this.recordedPage) {
      await this.storage.updateManifest({ browser_viewer: 'left_open_for_viewing', automation: 'stopped', session_profile: 'temporary_isolated_context' });
      return;
    }
    this.closed = true;
    await this.context?.close().catch(() => {});
    if (this.recordedPage?.video()) {
      try {
        if (this.recordingContainsAuth) {
          await this.recordedPage.video()!.delete();
          await this.storage.updateManifest({ recording: { status: 'discarded', reason: 'A visible authentication field or login route was observed during recording; no video exported.' } });
        } else {
          await this.recordedPage.video()!.saveAs(path.join(this.storage.dir, 'session.webm'));
          await this.storage.updateManifest({ recording: { status: 'saved', file: 'session.webm', reason: 'Initial login was excluded. Review visible personal content before sharing.' } });
        }
      } catch (error) { await this.storage.updateManifest({ recording: { status: 'unavailable', reason: String(error) } }); }
    }
    await this.browser?.close().catch(() => {});
    const videoDir = path.resolve(this.storage.dir, '.video');
    // This exact task-owned temporary directory is always inside this run directory.
    if (path.dirname(videoDir) === path.resolve(this.storage.dir)) await rm(videoDir, { recursive: true, force: true });
  }
}
