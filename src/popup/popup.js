// Popup UI logic

const $enabled = document.getElementById('enabled');
const $audio = document.getElementById('audio');
const $pill = document.getElementById('enabled-pill');
const $today = document.getElementById('stat-today');
const $total = document.getElementById('stat-total');
const $nano = document.getElementById('nano-status');
const $recensor = document.getElementById('recensor');
const $options = document.getElementById('options-link');

function syncEnabledPill(v) {
  $pill.textContent = v ? 'ON' : 'OFF';
  $pill.classList.toggle('on', v);
}

async function load() {
  const data = await chrome.storage.local.get(['enabled', 'audioEnabled', 'stats']);
  $enabled.checked = data.enabled !== false;
  $audio.checked = !!data.audioEnabled;
  syncEnabledPill($enabled.checked);
  const s = data.stats || { totalCensored: 0, byDay: {} };
  const today = new Date().toISOString().slice(0, 10);
  $today.textContent = String(s.byDay?.[today] || 0);
  $total.textContent = String(s.totalCensored || 0);
}

async function checkNanoStatus() {
  // Verifica nel contesto del popup
  try {
    if (!globalThis.LanguageModel) {
      $nano.textContent = 'Gemini Nano: non disponibile (Chrome 138+ richiesto, ~22GB disco)';
      return;
    }
    const a = await LanguageModel.availability();
    if (a === 'available') {
      $nano.textContent = 'Gemini Nano: attivo ✓';
      $nano.classList.add('ok');
    } else if (a === 'downloadable' || a === 'downloading') {
      $nano.textContent = 'Gemini Nano: in download…';
    } else {
      $nano.textContent = 'Gemini Nano: non disponibile su questo dispositivo';
    }
  } catch (e) {
    $nano.textContent = 'Gemini Nano: errore (' + e.message + ')';
  }
}

$enabled.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: $enabled.checked });
  syncEnabledPill($enabled.checked);
});

$audio.addEventListener('change', async () => {
  await chrome.storage.local.set({ audioEnabled: $audio.checked });
  if ($audio.checked) {
    const resp = await chrome.runtime.sendMessage({ type: 'AUDIO_START_REQUEST' });
    if (resp && !resp.ok) {
      alert('Audio non avviato: ' + (resp.error || 'errore sconosciuto'));
      $audio.checked = false;
      await chrome.storage.local.set({ audioEnabled: false });
    }
  } else {
    await chrome.runtime.sendMessage({ type: 'AUDIO_STOP_REQUEST' });
  }
});

$recensor.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'RECENSOR_ALL' });
  } catch {
    // Tab senza content script (chrome://, etc.)
  }
});

$options.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
checkNanoStatus();
