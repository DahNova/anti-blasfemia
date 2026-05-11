// =====================================================================
// Anti-Bestemmie · offscreen document (audio pipeline v3 — Whisper)
//
// Strategia:
//   1. service-worker chiama tabCapture.getMediaStreamId(tabId) (dal popup)
//   2. ci passa lo streamId via messaggio AUDIO_START
//   3. qui facciamo navigator.mediaDevices.getUserMedia con quell'id
//   4. lo stream:
//        a) -> <audio> playback (l'utente continua a sentire il tab)
//        b) -> MediaRecorder webm/opus, chunk da 4s
//   5. ogni chunk audio:
//        - decodificato via Web Audio API
//        - resamplato a 16kHz mono Float32
//        - passato a whisper-tiny via Transformers.js (on-device, WebGPU/WASM)
//   6. la trascrizione viene passata al detector Tier 1+2 esistente
//   7. se è bestemmia -> bip
//
// Modello: onnx-community/whisper-tiny (~75MB scaricato al primo uso da
// huggingface.co, poi cached in IndexedDB del browser).
// =====================================================================

import {
  pipeline,
  env,
} from '../../vendor/transformers/transformers.min.mjs';

// Configurazione Transformers.js
// Note: wasmPaths viene risolto automaticamente dal bundle pre-processato
// (sostituito da new URL("./",import.meta.url).href quindi punta al folder
// del modulo, dove abbiamo messo ort-wasm-simd-threaded.jsep.wasm).
env.allowLocalModels = false;
env.allowRemoteModels = true;
// La cache modelli usa IndexedDB del browser
env.useBrowserCache = true;

const D = globalThis.__SANTINO_DETECTOR;

const CHUNK_MS = 4000; // 4s chunks (whisper-tiny necessita di contesto)
const BEEP_COOLDOWN_MS = 600;
const TARGET_SR = 16000; // Whisper richiede 16kHz mono

let _stream = null;
let _audioEl = null;
let _recorder = null;
let _audioCtx = null; // per beep
let _decodeCtx = null; // per decodifica chunk
let _transcriber = null;
let _running = false;
let _lastBeepAt = 0;
let _inFlight = false; // evita di accodare troppe inferenze
let _pendingBlob = null;

// ---------- Beep ----------

function ensureAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function ensureDecodeCtx() {
  if (!_decodeCtx) _decodeCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: TARGET_SR });
  return _decodeCtx;
}

async function getVolume() {
  return new Promise((resolve) =>
    chrome.storage.local.get('beepVolume', (v) =>
      resolve(typeof v.beepVolume === 'number' ? v.beepVolume : 0.6)
    )
  );
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
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.setValueAtTime(volume, t + dur - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + dur);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  console.log('[Anti-Bestemmie audio] BEEP');
}

// ---------- Whisper init ----------

async function initWhisper(progressCb) {
  if (_transcriber) return _transcriber;
  console.log('[Anti-Bestemmie audio] init Whisper…');
  _transcriber = await pipeline(
    'automatic-speech-recognition',
    'onnx-community/whisper-tiny',
    {
      device: 'webgpu', // fallback automatico a wasm se non c'è
      dtype: 'fp32',
      progress_callback: (p) => {
        if (progressCb) progressCb(p);
        console.log('[Anti-Bestemmie audio] whisper load:', p?.status, p?.file || '', p?.progress ? p.progress.toFixed(1) + '%' : '');
      },
    }
  );
  console.log('[Anti-Bestemmie audio] Whisper pronto');
  return _transcriber;
}

// ---------- Audio chunk decode + resample ----------

async function blobToMono16k(blob) {
  const ctx = ensureDecodeCtx();
  const arr = await blob.arrayBuffer();
  // decodeAudioData fa il resampling al sampleRate del context (16000)
  const audioBuffer = await ctx.decodeAudioData(arr);
  if (audioBuffer.numberOfChannels === 1) {
    return audioBuffer.getChannelData(0).slice();
  }
  // Mix down a mono
  const len = audioBuffer.length;
  const out = new Float32Array(len);
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i++) out[i] += data[i];
  }
  const k = 1 / audioBuffer.numberOfChannels;
  for (let i = 0; i < len; i++) out[i] *= k;
  return out;
}

// ---------- Transcribe + detect ----------

async function processChunk(blob) {
  if (!_transcriber || !blob || blob.size === 0) return;
  try {
    const samples = await blobToMono16k(blob);
    // Whisper-tiny ha un context di ~30s. Se mandiamo audio troppo corto
    // ottiene comunque qualcosa, ma sotto 1s è inaffidabile.
    if (samples.length < TARGET_SR * 0.6) {
      console.log('[Anti-Bestemmie audio] chunk troppo corto, skip');
      return;
    }
    const result = await _transcriber(samples, {
      language: 'italian',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 0,
      return_timestamps: false,
    });
    const text = (result?.text || '').trim();
    if (!text) return;
    console.log('[Anti-Bestemmie audio] transcript:', text);

    // Pipe la trascrizione al detector
    const { matches, suspicious } = D.detectSync(text);
    if (matches.length > 0) {
      await playBeep();
      try { chrome.runtime.sendMessage({ type: 'AUDIO_CENSORED', count: matches.length }); } catch { /* */ }
      return;
    }
    if (suspicious.length > 0) {
      const extra = await D.detectWithNano(text, suspicious);
      if (extra.length > 0) {
        await playBeep();
        try { chrome.runtime.sendMessage({ type: 'AUDIO_CENSORED', count: extra.length }); } catch { /* */ }
      }
    }
  } catch (e) {
    console.warn('[Anti-Bestemmie audio] processChunk error:', e);
  }
}

async function enqueueChunk(blob) {
  // Strategia: se c'è già un'inferenza in volo, sostituisci il pending
  // con l'ultimo chunk (drop quelli intermedi). Whisper è più lento del
  // chunk rate, quindi accodare creerebbe lag crescente.
  if (_inFlight) {
    _pendingBlob = blob;
    return;
  }
  _inFlight = true;
  try {
    await processChunk(blob);
    while (_pendingBlob) {
      const next = _pendingBlob;
      _pendingBlob = null;
      await processChunk(next);
    }
  } finally {
    _inFlight = false;
  }
}

// ---------- Capture pipeline ----------

async function startCapture(streamId) {
  if (_running) return { ok: true, alreadyRunning: true };

  // STEP 1 (sincrono critico): acquisisci IMMEDIATAMENTE lo stream prima
  // che lo streamId scada (TTL di chrome.tabCapture ~10s).
  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
      video: false,
    });
    console.log('[Anti-Bestemmie audio] stream acquisito');
  } catch (e) {
    return { ok: false, error: 'getUserMedia: ' + e.message };
  }

  // STEP 2: riproduci subito lo stream (l'utente continua a sentire il tab,
  // e mantiene attivo il MediaStream)
  _audioEl = new Audio();
  _audioEl.srcObject = _stream;
  _audioEl.autoplay = true;
  try { await _audioEl.play(); } catch { /* autoplay quirk */ }

  // STEP 3+ (asincrono in background): carica Whisper e poi avvia recorder.
  // NON awaitiamo qui: il popup ottiene "ok" subito (stream è al sicuro),
  // il caricamento del modello procede e notifica progress via runtime msg.
  // Se il popup si chiude durante il download, l'offscreen continua.
  finishCaptureAsync().catch((e) => {
    console.error('[Anti-Bestemmie audio] finishCaptureAsync err:', e);
    try {
      chrome.runtime.sendMessage({
        type: 'AUDIO_ERROR',
        error: e.message || String(e),
      });
    } catch { /* */ }
    stopCapture();
  });

  return { ok: true, message: 'stream acquired, loading model…' };
}

async function finishCaptureAsync() {
  // STEP 3: init Whisper (può scaricare ~75MB la prima volta)
  await initWhisper((p) => {
    if (p?.status === 'progress' || p?.status === 'downloading') {
      try {
        chrome.runtime.sendMessage({
          type: 'WHISPER_PROGRESS',
          file: p.file,
          progress: p.progress,
          loaded: p.loaded,
          total: p.total,
        });
      } catch { /* popup chiuso, fine */ }
    }
  });
  try { chrome.runtime.sendMessage({ type: 'WHISPER_READY' }); } catch { /* */ }

  // Verifica che lo stream sia ancora vivo (l'utente potrebbe aver chiuso
  // il tab durante il download)
  if (!_stream || _stream.getTracks().every((t) => t.readyState === 'ended')) {
    throw new Error('Stream chiuso prima del completamento del caricamento modello');
  }

  // STEP 4: avvia MediaRecorder
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus'
    : 'audio/webm';
  _recorder = new MediaRecorder(_stream, { mimeType: mime });
  _recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    enqueueChunk(event.data);
  };
  _recorder.onerror = (e) => console.warn('[Anti-Bestemmie audio] recorder err:', e);
  _recorder.start(CHUNK_MS);
  _running = true;
  console.log('[Anti-Bestemmie audio] capture started');
  try { chrome.runtime.sendMessage({ type: 'AUDIO_STARTED' }); } catch { /* */ }
}

function stopCapture() {
  _running = false;
  if (_recorder) {
    try { _recorder.stop(); } catch { /* ignore */ }
    _recorder = null;
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
  console.log('[Anti-Bestemmie audio] capture stopped');
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
