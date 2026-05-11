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

const $nanoProgressWrap = document.getElementById('nano-progress-wrap');
const $nanoProgressBar = document.getElementById('nano-progress-bar');
const $nanoProgressText = document.getElementById('nano-progress-text');
const $nanoForce = document.getElementById('nano-force');
const $openInternals = document.getElementById('open-internals');

function showProgress(pct) {
  $nanoProgressWrap.style.display = 'block';
  const v = Math.max(0, Math.min(100, pct));
  $nanoProgressBar.style.width = v.toFixed(1) + '%';
  $nanoProgressText.textContent = v.toFixed(1) + '%';
}

async function checkNanoStatus() {
  try {
    if (!globalThis.LanguageModel) {
      $nano.textContent = 'Gemini Nano: API non esposta. Abilita chrome://flags/#prompt-api-for-gemini-nano';
      return;
    }
    const a = await LanguageModel.availability();
    if (a === 'available') {
      $nano.textContent = 'Gemini Nano: attivo ✓';
      $nano.classList.add('ok');
      $nanoForce.style.display = 'none';
      $nanoProgressWrap.style.display = 'none';
    } else if (a === 'downloadable') {
      $nano.textContent = 'Gemini Nano: pronto al download (click sotto per avviare)';
      $nanoForce.style.display = 'block';
    } else if (a === 'downloading') {
      $nano.textContent = 'Gemini Nano: download in corso… (apri chrome://on-device-internals per dettagli)';
      $nanoForce.style.display = 'block';
      $nanoForce.textContent = 'Aggancia monitor di progresso';
    } else if (a === 'unavailable') {
      $nano.textContent = 'Gemini Nano: NON disponibile su questo dispositivo (controlla disco libero ≥22GB, OS supportato)';
    } else {
      $nano.textContent = 'Gemini Nano: stato sconosciuto "' + a + '"';
    }
  } catch (e) {
    $nano.textContent = 'Gemini Nano: errore (' + e.message + ')';
  }
}

async function triggerNanoDownload() {
  if (!globalThis.LanguageModel) return;
  $nano.textContent = 'Gemini Nano: avvio download…';
  showProgress(0);
  try {
    const session = await LanguageModel.create({
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          // e.loaded è 0..1 secondo la spec attuale
          const pct = (e.loaded || 0) * 100;
          showProgress(pct);
          if (pct >= 100) {
            $nano.textContent = 'Gemini Nano: download completato, inizializzazione…';
          } else {
            $nano.textContent = 'Gemini Nano: scaricato ' + pct.toFixed(1) + '%';
          }
        });
      },
    });
    $nano.textContent = 'Gemini Nano: attivo ✓';
    $nano.classList.add('ok');
    $nanoForce.style.display = 'none';
    $nanoProgressWrap.style.display = 'none';
    // Test rapido
    try { session.destroy(); } catch { /* ignore */ }
  } catch (e) {
    $nano.textContent = 'Gemini Nano: download fallito (' + e.message + ')';
  }
}

$nanoForce.addEventListener('click', triggerNanoDownload);
$openInternals.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://on-device-internals' });
});

$enabled.addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: $enabled.checked });
  syncEnabledPill($enabled.checked);
});

$audio.addEventListener('change', async () => {
  if ($audio.checked) {
    // IMPORTANTE: chrome.tabCapture.getMediaStreamId DEVE essere chiamato qui,
    // nel popup, dentro l'handler del click — il service worker perde lo
    // user gesture appena gli inoltriamo il messaggio.
    let streamId, tabId;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('Nessun tab attivo');
      // Tab chrome:// e simili non sono catturabili
      if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
        throw new Error('Pagine di sistema (chrome://, ecc.) non sono catturabili');
      }
      tabId = tab.id;
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      alert('Audio non avviato: ' + e.message);
      $audio.checked = false;
      return;
    }

    await chrome.storage.local.set({ audioEnabled: true });
    const resp = await chrome.runtime.sendMessage({
      type: 'AUDIO_START_REQUEST',
      streamId,
      tabId,
    });
    if (resp && !resp.ok) {
      alert('Audio non avviato: ' + (resp.error || 'errore sconosciuto'));
      $audio.checked = false;
      await chrome.storage.local.set({ audioEnabled: false });
    }
  } else {
    await chrome.storage.local.set({ audioEnabled: false });
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
