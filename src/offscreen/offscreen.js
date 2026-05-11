// =====================================================================
// Anti-Bestemmie · offscreen document (audio pipeline v2)
//
// IMPORTANTE — perché non usiamo più SpeechRecognition:
// la Web Speech API in Chrome NON può consumare uno stream MediaStream
// arbitrario, usa SEMPRE il microfono di sistema. Quindi non poteva
// "sentire" l'audio del tab.
//
// Architettura v2 — Gemini Nano multimodale:
//   1. service-worker chiama tabCapture.getMediaStreamId(tabId) (dal popup)
//   2. ci passa lo streamId via messaggio AUDIO_START
//   3. qui facciamo navigator.mediaDevices.getUserMedia con quell'id
//   4. lo stream lo splittiamo:
//        a) -> <audio> playback (l'utente continua a sentire il tab)
//        b) -> MediaRecorder che produce chunk audio (Blob webm/opus)
//   5. ogni chunk viene mandato a Nano con prompt multimodale audio:
//        "Does this audio contain an Italian blasphemy? Reply JSON."
//   6. se Nano dice sì -> bip
//
// Latenza: ~2.5-4 secondi tra bestemmia pronunciata e bip
// (chunk window + Nano inference). È reattivo, non predittivo.
//
// Fallback: se il modello Nano non supporta input audio nel build di
// Chrome corrente, l'utente riceve un messaggio chiaro nello status.
// =====================================================================

let _stream = null;
let _audioEl = null;
let _recorder = null;
let _audioCtx = null;
let _nanoSession = null;
let _running = false;
let _lastBeepAt = 0;
const BEEP_COOLDOWN_MS = 500;
const CHUNK_MS = 2500;

const NANO_AUDIO_OPTS = {
  expectedInputs: [
    { type: 'audio' },
    { type: 'text', languages: ['en'] },
  ],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
};

const SYSTEM_PROMPT =
  'You analyze short audio clips for Italian blasphemies ("bestemmie"). ' +
  'An Italian blasphemy is the combination of a sacred word (Dio, Madonna, ' +
  'Cristo, Gesù) with a profane term (cane, porco, merda, troia, etc). ' +
  'Examples of blasphemies: "dio cane", "porco dio", "madonna troia", ' +
  '"porco madonna", "dio porco", "diocan". ' +
  'NOT blasphemies: "porco zio", "dio mio", "madonna mia", religious ' +
  'songs/prayers, language discussions. ' +
  'Reply with valid JSON only, no extra text.';

// ---------- Beep generator ----------

function ensureAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

async function getVolume() {
  return new Promise((resolve) => {
    chrome.storage.local.get('beepVolume', (v) =>
      resolve(typeof v.beepVolume === 'number' ? v.beepVolume : 0.6)
    );
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
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.01);
  gain.gain.setValueAtTime(volume, t + dur - 0.02);
  gain.gain.linearRampToValueAtTime(0, t + dur);

  osc.start(t);
  osc.stop(t + dur + 0.02);
  console.log('[Anti-Bestemmie audio] BEEP');
}

// ---------- Nano init (con audio input) ----------

async function initNanoForAudio() {
  if (_nanoSession) return _nanoSession;
  if (!globalThis.LanguageModel) {
    throw new Error('LanguageModel API non disponibile (serve Chrome 138+ con Gemini Nano).');
  }
  const avail = await LanguageModel.availability(NANO_AUDIO_OPTS);
  console.log('[Anti-Bestemmie audio] Nano availability (audio):', avail);
  if (avail === 'unavailable') {
    throw new Error(
      'Gemini Nano non supporta input audio su questo build di Chrome. ' +
      "L'audio bip richiede multimodalità che non è ancora disponibile."
    );
  }
  if (avail === 'downloadable' || avail === 'downloading') {
    throw new Error(
      "Il modello Nano con capacità audio dev'essere scaricato. " +
      'Apri il popup, premi "Forza download Gemini Nano", attendi il completamento, poi riprova.'
    );
  }
  _nanoSession = await LanguageModel.create({
    ...NANO_AUDIO_OPTS,
    initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
    temperature: 0.1,
    topK: 1,
  });
  return _nanoSession;
}

const SCHEMA = {
  type: 'object',
  properties: {
    has_blasphemy: { type: 'boolean' },
  },
  required: ['has_blasphemy'],
};

async function classifyChunk(blob) {
  if (!_nanoSession) return false;
  try {
    const result = await _nanoSession.prompt(
      [
        {
          role: 'user',
          content: [
            { type: 'text', value: 'Does this audio clip contain an Italian blasphemy? Respond with JSON.' },
            { type: 'audio', value: blob },
          ],
        },
      ],
      { responseConstraint: SCHEMA }
    );
    const parsed = JSON.parse(result);
    console.log('[Anti-Bestemmie audio] chunk verdict:', parsed);
    return !!parsed.has_blasphemy;
  } catch (e) {
    console.warn('[Anti-Bestemmie audio] classify error:', e);
    return false;
  }
}

// ---------- Capture pipeline ----------

async function startCapture(streamId) {
  if (_running) return { ok: true, alreadyRunning: true };

  // STEP 1: prepara la sessione Nano con audio (potrebbe fallire qui)
  try {
    await initNanoForAudio();
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // STEP 2: ottieni lo stream
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

  // STEP 3: riproduci lo stream (così l'utente continua a sentire il tab)
  _audioEl = new Audio();
  _audioEl.srcObject = _stream;
  _audioEl.autoplay = true;
  try {
    await _audioEl.play();
  } catch {
    /* autoplay restrictions, ignore */
  }

  // STEP 4: avvia MediaRecorder per produrre chunk audio
  try {
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';
    _recorder = new MediaRecorder(_stream, { mimeType: mime });
  } catch (e) {
    stopCapture();
    return { ok: false, error: 'MediaRecorder fallito: ' + e.message };
  }

  _recorder.ondataavailable = async (event) => {
    if (!event.data || event.data.size === 0) return;
    const isBlasphemy = await classifyChunk(event.data);
    if (isBlasphemy) {
      await playBeep();
      try {
        chrome.runtime.sendMessage({ type: 'AUDIO_CENSORED', count: 1 });
      } catch {
        /* ignore */
      }
    }
  };
  _recorder.onerror = (e) => {
    console.warn('[Anti-Bestemmie audio] recorder error:', e);
  };

  _recorder.start(CHUNK_MS);
  _running = true;
  console.log('[Anti-Bestemmie audio] capture started, chunk size:', CHUNK_MS, 'ms');
  return { ok: true };
}

function stopCapture() {
  _running = false;
  if (_recorder) {
    try {
      _recorder.stop();
    } catch {
      /* ignore */
    }
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
  if (_nanoSession) {
    try {
      _nanoSession.destroy();
    } catch {
      /* ignore */
    }
    _nanoSession = null;
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
