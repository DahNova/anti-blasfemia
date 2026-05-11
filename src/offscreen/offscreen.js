// =====================================================================
// Anti-Bestemmie · offscreen document (audio pipeline)
//
// Flusso:
//   1. service-worker chiama tabCapture.getMediaStreamId(tabId)
//   2. ci passa lo streamId via messaggio AUDIO_START
//   3. qui facciamo navigator.mediaDevices.getUserMedia con quell'id
//   4. lo stream lo splittiamo:
//        a) -> <audio> playback (l'utente continua a sentire il tab)
//        b) -> SpeechRecognition (trascrive in tempo reale)
//   5. ogni transcript di SpeechRecognition viene passato al detector
//   6. se trova una bestemmia, suoniamo un BIP via Web Audio API
//      sovrapposto. (Per i puristi: in v0.1 il bip è additivo, l'audio
//      originale non viene mutato; v0.2 può fare ducking dinamico.)
//
// Limiti noti:
//   - SpeechRecognition in Chrome è continua ma soggetta a riconnessioni;
//     usiamo retry automatico e modalità interim+final.
//   - Latenza ~300-800ms tra parola pronunciata e bip. È un bip *reattivo*,
//     non predittivo. Per il caso d'uso (avvisare l'utente) è accettabile.
// =====================================================================

const D = globalThis.__SANTINO_DETECTOR;

let _stream = null;
let _audioEl = null;
let _recognition = null;
let _audioCtx = null;
let _running = false;
let _lastBeepAt = 0;
const BEEP_COOLDOWN_MS = 400;

// ---------- Beep generator (Web Audio API) ----------

function ensureAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

async function getVolume() {
  return new Promise((resolve) => {
    chrome.storage.local.get('beepVolume', (v) => resolve(typeof v.beepVolume === 'number' ? v.beepVolume : 0.6));
  });
}

async function playBeep(durationMs = 220) {
  const now = Date.now();
  if (now - _lastBeepAt < BEEP_COOLDOWN_MS) return;
  _lastBeepAt = now;

  const ctx = ensureAudioCtx();
  if (ctx.state === 'suspended') await ctx.resume();

  const volume = await getVolume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = 1000;
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);

  const t = ctx.currentTime;
  const dur = durationMs / 1000;
  // Envelope attack/decay rapidi per evitare click
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.setValueAtTime(volume, t + dur - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + dur);

  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// ---------- Capture pipeline ----------

async function startCapture(streamId) {
  if (_running) return { ok: true, alreadyRunning: true };

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    });
  } catch (e) {
    return { ok: false, error: 'getUserMedia fallito: ' + e.message };
  }

  // Riproduci lo stream così l'utente continua a sentire il tab
  _audioEl = new Audio();
  _audioEl.srcObject = _stream;
  _audioEl.autoplay = true;
  // Importante: senza play() esplicito a volte Chrome blocca
  try { await _audioEl.play(); } catch { /* ignore */ }

  startRecognition();
  _running = true;
  return { ok: true };
}

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    console.warn('[Anti-Bestemmie] SpeechRecognition non supportato');
    return;
  }
  _recognition = new SR();
  _recognition.lang = 'it-IT';
  _recognition.continuous = true;
  _recognition.interimResults = true;
  _recognition.maxAlternatives = 1;

  _recognition.onresult = onTranscript;
  _recognition.onerror = (e) => {
    // 'no-speech', 'aborted', 'network' sono comuni — tentiamo restart
    console.warn('[Anti-Bestemmie] SR error:', e.error);
  };
  _recognition.onend = () => {
    if (_running) {
      // auto-restart, SpeechRecognition tende a chiudersi da solo
      try { _recognition.start(); } catch { /* ignore */ }
    }
  };
  try { _recognition.start(); } catch (e) {
    console.warn('[Anti-Bestemmie] SR start fallito:', e);
  }
}

// Evita di rianalizzare lo stesso pezzo di interim più volte
let _lastAnalyzed = '';

async function onTranscript(event) {
  // Prendi l'ultimo risultato (anche interim) per minimizzare latenza
  let text = '';
  for (let i = event.resultIndex; i < event.results.length; i++) {
    text += event.results[i][0].transcript;
  }
  text = text.trim().toLowerCase();
  if (!text || text === _lastAnalyzed) return;
  _lastAnalyzed = text;

  // Tier 1 sincrono
  const { matches, suspicious } = D.detectSync(text);
  if (matches.length > 0) {
    playBeep();
    chrome.runtime.sendMessage({ type: 'AUDIO_CENSORED', count: matches.length });
    return;
  }

  // Tier 2 asincrono — Nano valuta solo i sospetti
  if (suspicious.length > 0) {
    const extra = await D.detectWithNano(text, suspicious);
    if (extra.length > 0) {
      playBeep();
      chrome.runtime.sendMessage({ type: 'AUDIO_CENSORED', count: extra.length });
    }
  }
}

function stopCapture() {
  _running = false;
  if (_recognition) {
    try { _recognition.stop(); } catch { /* ignore */ }
    _recognition = null;
  }
  if (_stream) {
    for (const t of _stream.getTracks()) t.stop();
    _stream = null;
  }
  if (_audioEl) {
    _audioEl.pause();
    _audioEl.srcObject = null;
    _audioEl = null;
  }
  return { ok: true };
}

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'AUDIO_START') {
    startCapture(msg.streamId).then(sendResponse);
    return true;
  }
  if (msg.type === 'AUDIO_STOP') {
    sendResponse(stopCapture());
    return;
  }
});
