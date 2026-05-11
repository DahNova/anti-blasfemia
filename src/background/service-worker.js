// =====================================================================
// Anti-Bestemmie · service worker
//
// Responsabilità:
//  - Gestione lifecycle offscreen document (creato on-demand quando
//    parte la cattura audio di un tab).
//  - Tracking statistiche (contatore censure aggregato per giorno).
//  - Badge sull'icona dell'estensione.
//  - Routing messaggi: content -> sw, popup -> sw, offscreen <-> sw.
// =====================================================================

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';

// ---------- Lifecycle ----------

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      enabled: true,
      censorChar: '*',
      audioEnabled: false, // audio bip è opt-in: richiede tabCapture
      beepVolume: 0.6,
      domainWhitelist: [],
      customPatterns: [],
      stats: { totalCensored: 0, byDay: {} },
    });
  }
  // Refresh badge
  updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

async function updateBadge() {
  const { enabled } = await chrome.storage.local.get('enabled');
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#16a34a' : '#9ca3af' });
  chrome.action.setBadgeText({ text: enabled ? 'ON' : 'OFF' });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateBadge();
});

// ---------- Stats ----------

async function incrementStat(n) {
  const { stats } = await chrome.storage.local.get('stats');
  const s = stats || { totalCensored: 0, byDay: {} };
  s.totalCensored = (s.totalCensored || 0) + n;
  const today = new Date().toISOString().slice(0, 10);
  s.byDay[today] = (s.byDay[today] || 0) + n;
  // Mantieni solo ultimi 30 giorni
  const days = Object.keys(s.byDay).sort();
  while (days.length > 30) {
    delete s.byDay[days.shift()];
  }
  await chrome.storage.local.set({ stats: s });
}

// ---------- Offscreen audio orchestration ----------

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification: 'Cattura audio del tab attivo per rilevare bestemmie e sovrapporre un bip.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    await chrome.offscreen.closeDocument();
  }
}

async function startAudioCaptureForActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return { ok: false, error: 'Nessun tab attivo' };

  // tabCapture richiede di ottenere lo streamId nel contesto utente attivo.
  // In MV3 lo prendiamo dal service worker via getMediaStreamId, poi lo
  // passiamo all'offscreen doc che fa la getUserMedia.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    return { ok: false, error: 'tabCapture non disponibile: ' + e.message };
  }

  await ensureOffscreen();
  // Piccola attesa per essere certi che l'offscreen sia in ascolto
  await new Promise((r) => setTimeout(r, 100));

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'AUDIO_START', streamId, tabId: tab.id },
      (resp) => resolve(resp || { ok: true })
    );
  });
}

async function stopAudioCapture() {
  if (!(await hasOffscreen())) return { ok: true };
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'AUDIO_STOP' }, () => resolve());
  });
  await closeOffscreen();
  return { ok: true };
}

// ---------- Message routing ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case 'STAT_INCREMENT':
      incrementStat(msg.count || 1);
      return;

    case 'AUDIO_START_REQUEST':
      startAudioCaptureForActiveTab().then(sendResponse);
      return true;

    case 'AUDIO_STOP_REQUEST':
      stopAudioCapture().then(sendResponse);
      return true;

    case 'AUDIO_CENSORED':
      // Notifica dall'offscreen che ha bippato qualcosa
      incrementStat(msg.count || 1);
      return;

    case 'PING':
      sendResponse({ ok: true });
      return;

    default:
      return;
  }
});
