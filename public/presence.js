(() => {
  const STORAGE_KEY = 'lan-presence-id';
  const HEARTBEAT_MS = 15000;
  let clientId;

  try { clientId = localStorage.getItem(STORAGE_KEY); }
  catch { clientId = ''; }
  if (!/^[\da-f]{32}$/.test(clientId || '')) {
    clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem(STORAGE_KEY, clientId); }
    catch { /* A tab-scoped ID still reports presence without persistent storage. */ }
  }

  async function heartbeat() {
    if (document.visibilityState !== 'visible') { return; }
    try {
      const response = await fetch('/api/presence', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }), signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) { return; }
      const { online } = await response.json();
      for (const count of document.querySelectorAll('[data-online-count]')) { count.textContent = online; }
    } catch { /* The count recovers on the next heartbeat. */ }
  }

  void heartbeat();
  window.setInterval(heartbeat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void heartbeat(); } });
})();
