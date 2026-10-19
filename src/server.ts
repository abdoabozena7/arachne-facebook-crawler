import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { Crawler } from './crawler.js';
import { BridgeHub, CompanionBrowser } from './bridge.js';
import { BrowserController } from './browser-controller.js';
import { positionWindow, splitDesktop, type WindowBounds } from './windows.js';
import type { CrawlConfig } from './types.js';

interface AppOptions { port?: number; runsDir?: string; openDashboard?: boolean; defaults?: Partial<CrawlConfig> }
export const DEFAULT_SOURCE = 'https://www.facebook.com/photo/?fbid=1222812841257009';
export const defaults = { url: DEFAULT_SOURCE, collectionTarget: 'comments', browserMode: 'fresh', publicOnly: true, visibleOnly: false, keepBrowserOpen: true, maxPosts: 200, animationSpeed: 0.85, operationDelayMs: 0, idleRoundLimit: 5, recordVideo: false, screenshots: false };
export function validateConfig(input: Record<string, unknown>, baseURL: string, overrides: Partial<CrawlConfig> = {}): CrawlConfig {
  const settings = { ...defaults, ...overrides, ...input };
  const mode = settings.mode === 'fixture' ? 'fixture' : settings.mode === 'facebook' ? 'facebook' : null;
  if (!mode) throw new Error('Choose facebook or fixture mode');
  if (mode === 'facebook' && input.authorized !== true) throw new Error('Confirm authorization to access this page before starting');
  const url = mode === 'fixture' ? new URL('/fixture', baseURL) : new URL(String(settings.url ?? ''));
  if (mode === 'facebook') {
    if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*facebook\.com$/i.test(url.hostname) || url.username || url.password || url.port) throw new Error('Use an HTTPS facebook.com page URL without credentials or a custom port');
    if (/\/login|\/checkpoint/i.test(url.pathname)) throw new Error('Enter the permitted page URL; sign in inside Chromium when prompted');
    // Only source-reference parameters belong in exported provenance.
    for (const key of [...url.searchParams.keys()]) if (!['id', 'story_fbid', 'fbid'].includes(key)) url.searchParams.delete(key);
    url.hash = '';
  }
  const number = (key: string, min: number, max: number, integer = false): number => {
    const value = Number(settings[key as keyof typeof settings]);
    if (!Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${key} must be ${integer ? 'an integer ' : ''}between ${min} and ${max}`);
    return value;
  };
  const collectionTarget = input.collectionTarget ?? (mode === 'fixture' ? 'posts' : settings.collectionTarget);
  if (!['posts', 'comments'].includes(String(collectionTarget))) throw new Error('Choose posts or comments');
  const browserMode = input.browserMode ?? 'fresh';
  if (!['fresh', 'companion'].includes(String(browserMode))) throw new Error('Choose fresh or companion browser mode');
  const publicOnly = mode === 'facebook' ? settings.publicOnly !== false : input.publicOnly === true;
  const visibleOnly = mode === 'facebook' ? settings.visibleOnly === true : input.visibleOnly === true;
  const keepBrowserOpen = mode === 'facebook' ? settings.keepBrowserOpen !== false : input.keepBrowserOpen === true;
  if (publicOnly && browserMode !== 'fresh') throw new Error('Public-only mode uses a fresh isolated Chromium session');
  if (mode === 'fixture' && collectionTarget === 'comments') url.searchParams.set('target', 'comments');
  if (mode === 'fixture' && collectionTarget === 'comments' && input.fixtureScroll === true) url.searchParams.set('scroll', '1');
  return { mode, publicOnly, visibleOnly, keepBrowserOpen, collectionTarget: collectionTarget as 'posts' | 'comments', browserMode: browserMode as 'fresh' | 'companion', url: url.href, maxPosts: number('maxPosts', 1, 1000, true), animationSpeed: number('animationSpeed', 0.25, 3), operationDelayMs: number('operationDelayMs', 0, 30000, true), idleRoundLimit: number('idleRoundLimit', 2, 15, true), recordVideo: !publicOnly && !keepBrowserOpen && settings.recordVideo === true, screenshots: settings.screenshots === true };
}
export async function createApp(options: AppOptions = {}) {
  const bridge = new BridgeHub();
  let sourceBounds: WindowBounds | undefined, panelBounds: WindowBounds | undefined;
  const crawler = new Crawler(path.resolve(options.runsDir ?? 'runs'), bridge, (config, storage, onClosed) => config.browserMode === 'companion' ? new CompanionBrowser(config, storage, bridge) : new BrowserController(config, storage, onClosed, sourceBounds));
  const clients = new Set<http.ServerResponse>();
  let baseURL = '';
  let starting = false;
  let dashboardBrowser: Browser | undefined, dashboardPage: Page | undefined;
  let openingDashboard: Promise<void> | undefined;
  let shuttingDown = false;
  const buildId = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
  async function showDashboard(): Promise<void> {
    if (openingDashboard) return openingDashboard;
    openingDashboard = (async () => {
      if (dashboardPage && !dashboardPage.isClosed()) { await dashboardPage.bringToFront(); return; }
      if (!dashboardBrowser?.isConnected()) dashboardBrowser = await chromium.launch({ headless: false, args: ['--window-size=420,900', '--window-position=0,0'] });
      const context = await dashboardBrowser.newContext({ viewport: null }); dashboardPage = await context.newPage(); await dashboardPage.goto(baseURL);
      const desktop = await dashboardPage.evaluate(() => { const monitor = screen as Screen & { availLeft?: number; availTop?: number }; return { left: monitor.availLeft ?? 0, top: monitor.availTop ?? 0, width: monitor.availWidth, height: monitor.availHeight }; });
      const layout = splitDesktop(desktop); panelBounds = await positionWindow(dashboardPage, layout.panel);
      sourceBounds = { ...layout.source, left: panelBounds.left + panelBounds.width, width: Math.max(500, desktop.left + desktop.width - panelBounds.left - panelBounds.width) };
    })();
    try { await openingDashboard; } finally { openingDashboard = undefined; }
  }
  const json = (res: http.ServerResponse, status: number, value: unknown): void => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const body = async (req: http.IncomingMessage, limit = 12000): Promise<Record<string, unknown>> => {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Use application/json');
    let value = ''; for await (const chunk of req) { value += chunk; if (value.length > limit) throw new Error('Request body too large'); }
    return value ? JSON.parse(value) : {};
  };
  const server = http.createServer(async (req, res) => {
    try {
      // Loopback binding plus Host/Origin checks prevent foreign websites controlling the local browser.
      if (req.headers.host !== new URL(baseURL).host && req.headers.host !== `localhost:${new URL(baseURL).port}`) { json(res, 403, { error: 'Invalid local host' }); return; }
      const bridgeRequest = (req.url ?? '').startsWith('/bridge/');
      if (bridgeRequest && !bridge.authorize(req.headers['x-arachne-token'] as string | undefined)) { json(res, 403, { error: 'Invalid companion pairing token' }); return; }
      if (!bridgeRequest && req.headers.origin && ![baseURL, baseURL.replace('127.0.0.1', 'localhost')].includes(req.headers.origin)) { json(res, 403, { error: 'Foreign origin rejected' }); return; }
      const url = new URL(req.url ?? '/', baseURL);
      if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { application: 'arachne', project_root: path.resolve('.'), pid: process.pid, build_id: buildId, ready: !shuttingDown }); return; }
      if (req.method === 'POST' && url.pathname === '/api/open-panel') { const input = await body(req); await showDashboard(); if (input.refresh === true) await dashboardPage?.reload(); json(res, 200, { ok: true }); return; }
      if (req.method === 'POST' && url.pathname === '/api/shutdown') {
        await body(req);
        if (crawler.machine.active || starting) { json(res, 409, { error: 'The current collection must finish or be stopped before updating the app' }); return; }
        shuttingDown = true; json(res, 200, { ok: true }); setTimeout(() => { void close(); }, 50); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/companion') { json(res, 200, { token: bridge.token, server: baseURL }); return; }
      if (req.method === 'POST' && bridgeRequest) {
        const input = await body(req, 500000);
        if (url.pathname === '/bridge/connect') { json(res, 200, bridge.connect(String(input.url))); return; }
        if (url.pathname === '/bridge/poll') { json(res, 200, { command: await bridge.poll(String(input.session_id), String(input.url)) }); return; }
        if (url.pathname === '/bridge/result') { bridge.result(String(input.session_id), String(input.id), input.value, input.error as string | undefined); json(res, 200, { ok: true }); return; }
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, crawler.snapshot()); return; }
      if (req.method === 'GET' && url.pathname === '/api/config') { json(res, 200, { ...defaults, ...options.defaults }); return; }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`event: snapshot\ndata: ${JSON.stringify(crawler.snapshot())}\n\n`);
        clients.add(res); req.on('close', () => clients.delete(res)); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        if (shuttingDown || starting || crawler.machine.active) { json(res, 409, { error: 'The app is updating or a crawl is already active' }); return; }
        const input = await body(req); const config = validateConfig(input, baseURL, options.defaults);
        if (starting || crawler.machine.active) { json(res, 409, { error: 'A crawl is already active' }); return; }
        starting = true;
        try { const run_id = await crawler.start(config); json(res, 202, { run_id }); } finally { starting = false; }
        return;
      }
      if (req.method === 'POST' && ['/api/pause', '/api/resume', '/api/stop'].includes(url.pathname)) {
        await body(req);
        if (url.pathname === '/api/pause') await crawler.pause();
        if (url.pathname === '/api/resume') await crawler.resume();
        if (url.pathname === '/api/stop') await crawler.stop();
        json(res, 200, crawler.snapshot()); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const root = path.resolve(options.runsDir ?? 'runs');
        const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
        const runs = await Promise.all(dirs.filter(d => d.isDirectory() && /^[\w.-]+$/.test(d.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 50).map(async d => {
          try { return JSON.parse(await readFile(path.join(root, d.name, 'manifest.json'), 'utf8')); } catch { return null; }
        })); json(res, 200, runs.filter(Boolean)); return;
      }
      const runFile = url.pathname.match(/^\/api\/runs\/([\w.-]+)\/(data\.json|manifest\.json|events\.jsonl|summary\.md|session\.webm|screenshots\/[\w-]+\.png)$/);
      if (req.method === 'GET' && (url.pathname === '/api/export' || runFile)) {
        const root = path.resolve(options.runsDir ?? 'runs');
        const id = runFile?.[1] ?? crawler.snapshot().run_id;
        if (!id) { json(res, 404, { error: 'No saved run available' }); return; }
        const relative = runFile?.[2] ?? 'data.json';
        const file = path.resolve(root, id, relative);
        if (!file.startsWith(root + path.sep)) { json(res, 403, { error: 'Invalid evidence path' }); return; }
        // Check existence before sending download headers so missing/failed exports have a useful response.
        const { stat } = await import('node:fs/promises'); const info = await stat(file);
        const mime = relative.endsWith('.webm') ? 'video/webm' : relative.endsWith('.png') ? 'image/png' : relative.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': info.size, 'Cache-Control': 'no-store', ...(relative === 'data.json' ? { 'Content-Disposition': `attachment; filename="arachne-${id}.json"` } : {}) });
        createReadStream(file).on('error', () => res.destroy()).pipe(res); return;
      }
      const staticFiles: Record<string, [string, string]> = { '/': ['index.html', 'text/html'], '/dashboard.js': ['dashboard.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/fixture': ['fixture.html', 'text/html'] };
      if (req.method === 'GET' && staticFiles[url.pathname]) {
        const [standardFile, type] = staticFiles[url.pathname];
        const file = url.pathname === '/fixture' && url.searchParams.get('scroll') === '1' ? 'fixture-scroll.html' : standardFile;
        const content = await readFile(path.resolve('dist/public', file));
        res.setHeader('Content-Security-Policy', url.pathname === '/fixture' ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'" : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const message = error instanceof Error ? error.message : String(error);
      json(res, /ENOENT/.test(message) ? 404 : /ENOSPC|EACCES|EIO/.test(message) ? 500 : 400, { error: message });
    }
  });
  crawler.subscribe(e => { for (const res of clients) res.write(`event: crawl\ndata: ${JSON.stringify(e)}\n\n`); });
  const heartbeat = setInterval(() => { for (const res of clients) res.write(': heartbeat\n\n'); }, 15000); heartbeat.unref();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 4318, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  baseURL = `http://127.0.0.1:${address.port}`;
  async function close(): Promise<void> { clearInterval(heartbeat); await crawler.shutdown(); await dashboardBrowser?.close().catch(() => {}); clients.forEach(res => res.end()); await new Promise<void>(r => server.close(() => r())); }
  if (options.openDashboard !== false) {
    try { await showDashboard(); }
    catch (error) { console.log(`Dashboard browser unavailable: ${String(error)}. Open ${baseURL} manually.`); await dashboardBrowser?.close().catch(() => {}); }
  }
  return { crawler, server, url: baseURL, get dashboardPage() { return dashboardPage; }, get windowLayout() { return sourceBounds && panelBounds ? { panel: panelBounds, source: sourceBounds } : null; }, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options: AppOptions = {};
  try { options = JSON.parse(await readFile(path.resolve('config.json'), 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (process.argv.includes('--no-open')) options.openDashboard = false;
  const portArg = process.argv.find(arg => arg.startsWith('--port=')); if (portArg) options.port = Number(portArg.split('=')[1]);
  const app = await createApp(options); console.log(`ARACHNE dashboard: ${app.url}\nEvidence: ${path.resolve(options.runsDir ?? 'runs')}\nCtrl+C gracefully stops the browser and finalizes evidence.`);
  let closing = false;
  const close = () => { if (closing) return; closing = true; void app.close().finally(() => process.exit(0)); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
