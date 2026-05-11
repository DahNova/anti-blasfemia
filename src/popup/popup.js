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

// Chrome Prompt API supporta solo [en, es, ja]. Dichiariamo 'en' formalmente
// per evitare l'errore "language options are not supported"; il modello sotto
// è multilingue e i prompt/dati italiani li gestisce comunque.
const NANO_LANG_OPTS = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

async function checkNanoStatus() {
  try {
    if (!globalThis.LanguageModel) {
      $nano.textContent = 'Gemini Nano: API non esposta. Abilita chrome://flags/#prompt-api-for-gemini-nano. Testo funzionerà solo con blocklist (Tier 1).';
      return;
    }
    const a = await LanguageModel.availability(NANO_LANG_OPTS);
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
      ...NANO_LANG_OPTS,
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

const $audioStatus = document.getElementById('audio-status');

function showAudioStatus(msg, isError) {
  $audioStatus.style.display = 'block';
  $audioStatus.textContent = msg;
  $audioStatus.style.color = isError ? '#fca5a5' : 'var(--muted)';
  console.log('[Anti-Bestemmie audio]', msg);
}

// Ascolta progress download Whisper inoltrato dal service worker
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'WHISPER_PROGRESS') {
    const pct = msg.progress ? msg.progress.toFixed(0) : '?';
    const file = msg.file ? msg.file.split('/').pop() : '';
    showAudioStatus(`Whisper: scaricando ${file} ${pct}%…`);
  } else if (msg?.type === 'WHISPER_READY') {
    showAudioStatus('Whisper pronto, cattura audio attiva ✓');
  }
});

$audio.addEventListener('change', async () => {
  if ($audio.checked) {
    showAudioStatus('Avvio… (primo uso: download ~75MB del modello Whisper)');

    // STEP 1: query tab attivo
    let tab;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('[Anti-Bestemmie audio] tab query:', tab);
    } catch (e) {
      showAudioStatus('Errore query tab: ' + e.message, true);
      $audio.checked = false;
      return;
    }
    if (!tab?.id) {
      showAudioStatus('Nessun tab attivo trovato', true);
      $audio.checked = false;
      return;
    }
    if (/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '')) {
      showAudioStatus(
        `Pagina di sistema non catturabile: ${tab.url || '(url nascosto)'}. Apri una pagina normale e riprova.`,
        true
      );
      $audio.checked = false;
      return;
    }

    // STEP 2: chiede streamId DENTRO l'handler (user gesture attivo)
    let streamId;
    try {
      if (!chrome.tabCapture || !chrome.tabCapture.getMediaStreamId) {
        throw new Error('chrome.tabCapture non esposto');
      }
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      console.log('[Anti-Bestemmie audio] streamId:', streamId);
    } catch (e) {
      showAudioStatus('getMediaStreamId fallito: ' + e.message, true);
      $audio.checked = false;
      return;
    }
    if (!streamId) {
      showAudioStatus('streamId vuoto (Chrome non ha autorizzato la cattura)', true);
      $audio.checked = false;
      return;
    }

    // STEP 3: passa al service worker per creare offscreen + avviare cattura
    await chrome.storage.local.set({ audioEnabled: true });
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'AUDIO_START_REQUEST',
        streamId,
        tabId: tab.id,
      });
      console.log('[Anti-Bestemmie audio] SW resp:', resp);
    } catch (e) {
      showAudioStatus('Messaggio al SW fallito: ' + e.message, true);
      $audio.checked = false;
      await chrome.storage.local.set({ audioEnabled: false });
      return;
    }
    if (!resp || !resp.ok) {
      showAudioStatus('Avvio fallito: ' + (resp?.error || 'risposta vuota'), true);
      $audio.checked = false;
      await chrome.storage.local.set({ audioEnabled: false });
      return;
    }
    showAudioStatus('Cattura audio attiva ✓');
  } else {
    showAudioStatus('Disattivazione…');
    await chrome.storage.local.set({ audioEnabled: false });
    try {
      await chrome.runtime.sendMessage({ type: 'AUDIO_STOP_REQUEST' });
    } catch (e) {
      console.warn('[Anti-Bestemmie audio] stop msg err:', e);
    }
    $audioStatus.style.display = 'none';
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
