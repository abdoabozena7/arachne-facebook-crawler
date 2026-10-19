(() => {
  let stopped = false;
  window.__arachneBridgeStop = () => { stopped = true; window.__arachneOverlay?.destroy(); };
  const request = async (route, data) => { const response = await chrome.runtime.sendMessage({ kind: 'request', route, data }); if (response?.error) throw new Error(response.error); return response; };
  async function execute(command) {
    if (command.action === 'close') { stopped = true; window.__arachneOverlay?.destroy(); window.__arachneDom?.clear(); return null; }
    if (command.action === 'overlay') { window.__arachneOverlay?.event(command.payload); return null; }
    if (document.visibilityState !== 'visible') throw new Error('source_tab_not_visible: keep the paired Chrome tab visible');
    const dom = window.__arachneDom; if (!dom) throw new Error('DOM observer unavailable');
    if (command.action === 'access') return dom.access();
    if (command.action === 'discover') return dom.discover();
    if (command.action === 'extract') return dom.extract(command.payload);
    if (command.action === 'scroll') return dom.scroll();
    if (command.action === 'load_more') return dom.loadMore();
    if (command.action === 'dismiss_optional_login') return dom.dismissOptionalLogin();
    if (command.action === 'focus') {
      const element = dom.target(command.payload); if (!element?.isConnected) throw new Error('post_removed_from_dom');
      const r = element.getBoundingClientRect(); if (r.top < 65 || r.bottom > innerHeight) element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const candidate = dom.discover().find(c => c.element_id === command.payload); if (!candidate) throw new Error('post_left_viewport'); return candidate;
    }
    throw new Error('Unsupported browser command');
  }
  (async () => {
    while (!stopped) {
      const { command } = await request('/bridge/poll', { url: location.href }); if (!command) continue;
      try { const value = await execute(command); await request('/bridge/result', { id: command.id, value }); }
      catch (error) { await request('/bridge/result', { id: command.id, error: String(error) }); }
    }
  })().catch(error => { stopped = true; window.__arachneOverlay?.destroy(); console.info('Arachne companion stopped:', String(error)); });
})();
