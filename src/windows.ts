import type { Page } from 'playwright';
export interface WindowBounds { left: number; top: number; width: number; height: number }
export function splitDesktop(desktop: WindowBounds): { panel: WindowBounds; source: WindowBounds } {
  const width = Math.min(420, Math.max(300, Math.round(desktop.width * 0.29)));
  return { panel: { ...desktop, width }, source: { ...desktop, left: desktop.left + width, width: desktop.width - width } };
}
// Only called on pages launched by this application, never a personal browser.
export async function positionWindow(page: Page, bounds: WindowBounds): Promise<WindowBounds> {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds });
    return (await session.send('Browser.getWindowBounds', { windowId })).bounds as WindowBounds;
  } finally { await session.detach(); }
}
