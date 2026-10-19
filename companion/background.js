async function request(config, route, data) {
  const res = await fetch(config.server + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arachne-Token': config.token }, body: JSON.stringify(data) });
  const result = await res.json(); if (!res.ok) throw new Error(result.error || 'Local bridge request failed'); return result;
}
export async function connectSource(message) {
      const server = new URL(message.server); if (server.protocol !== 'http:' || server.hostname !== '127.0.0.1' || server.username || server.password) throw new Error('Use a loopback http://127.0.0.1 server URL');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); if (!tab?.id || !tab.url) throw new Error('No visible source tab');
      const config = { server: server.origin, token: message.token, tab_id: tab.id };
      const connected = await request(config, '/bridge/connect', { url: tab.url });
      const pair = { ...config, session_id: connected.session_id };
      await chrome.storage.session.set({ pair });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (mode, target) => { window.__arachneBridgeStop?.(); window.__arachneOverlay?.destroy(); window.__ARACHNE_MODE__ = mode; window.__ARACHNE_TARGET__ = target; }, args: [connected.config.mode, connected.config.collectionTarget] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['overlay.js', 'client.js'] });
      return { ok: true };
}
// The same entry point is exercised by the isolated, headed extension fixture test.
globalThis.arachneCompanion = { connect: connectSource };
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.kind === 'connect') return connectSource(message);
    if (message.kind === 'request') {
      const { pair } = await chrome.storage.session.get('pair'); if (!pair || pair.tab_id !== sender.tab?.id) throw new Error('This tab is not paired');
      if (!['/bridge/poll', '/bridge/result'].includes(message.route)) throw new Error('Unsupported bridge route');
      return await request(pair, message.route, { ...message.data, session_id: pair.session_id });
    }
    throw new Error('Unsupported companion message');
  })().then(sendResponse).catch(error => sendResponse({ error: String(error) }));
  return true;
});
