document.getElementById('connect').addEventListener('click', async () => {
  const status = document.getElementById('status'); status.textContent = 'Connecting…';
  try {
    const response = await chrome.runtime.sendMessage({ kind: 'connect', server: document.getElementById('server').value, token: document.getElementById('token').value.trim() });
    if (response.error) throw new Error(response.error); status.textContent = 'Connected. Keep this tab visible while it crawls.';
  } catch (error) { status.textContent = String(error); }
});
