// Read-only diagnosis of the app's own anonymous Chromium document.
import { BrowserController } from '../src/browser-controller.js';
import { RunStorage } from '../src/storage.js';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaults, DEFAULT_SOURCE } from '../src/server.js';
const config = { ...defaults, mode: 'facebook' as const, browserMode: 'fresh' as const, collectionTarget: 'comments' as const, url: DEFAULT_SOURCE };
const storage = new RunStorage(await mkdtemp(path.join(os.tmpdir(), 'arachne-public-inspect-')), 'diagnostic', config);
await storage.init();
const controller = new BrowserController(config, storage, () => {});
try {
  await controller.open();
  for (let i = 0; i < 2 && (await controller.adapter!.access()).status === 'login_required'; i++) {
    if (!await controller.adapter!.dismissOptionalLogin()) break;
    await controller.page!.waitForTimeout(1500);
  }
  const candidates = await controller.adapter!.discover();
  const report = await controller.page!.evaluate(ids => ids.map(id => {
    const el = window.__arachneDom!.target(id)!;
    return { element_id: id, label: el.getAttribute('aria-label'), role: el.getAttribute('role'),
      blocks: [...el.querySelectorAll('[dir="auto"]')].filter(b => b.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })).map(b => ({ text: b.textContent?.slice(0, 200), tag: b.tagName, control: b.closest('a, [role="link"], button, [role="button"], [role="heading"]')?.outerHTML.slice(0, 350), parent_tag: b.parentElement?.tagName, parent_role: b.parentElement?.getAttribute('role'), parent_lang: b.parentElement?.getAttribute('lang'), own_lang: b.getAttribute('lang') })) };
  }), candidates.slice(0, 4).map(c => c.element_id));
  await mkdir('output/playwright', { recursive: true });
  await writeFile('output/playwright/public-dom-diagnostic.json', JSON.stringify({ source_url: config.url, access: await controller.adapter!.access(), candidates: report }, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await controller.close(); await storage.close(); }
