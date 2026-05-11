# Anti-Bestemmie

Estensione Chrome che censura bestemmie italiane su pagine e audio in tempo reale.

- **Testo (leggi):** bestemmie nei contenuti delle pagine vengono coperte con asterischi (`d*o c*ne`).
- **Audio (senti):** un bip viene riprodotto in sovrapposizione quando Whisper rileva una bestemmia nell'audio del tab.
- **AI on-device (prevede):** Gemini Nano (built-in in Chrome) cattura le bestemmie camuffate / creative che la blocklist letterale non vede.

Tutto on-device. Niente API esterne, niente token, niente network al runtime (solo download iniziale dei modelli).

---

## Requisiti

- **Chrome 138+** (stable, desktop)
- **OS:** Windows 10/11, macOS 13+, Linux, ChromeOS Plus
- **Disco:** ~22 GB liberi (per il modello Gemini Nano scaricato la prima volta)
- Niente GPU obbligatoria, ma una accelera Nano

Senza Gemini Nano l'estensione funziona comunque, con la sola blocklist (Tier 1).

---

## Installazione (modalità sviluppatore)

1. Apri Chrome → `chrome://extensions`
2. Attiva **"Modalità sviluppatore"** in alto a destra
3. Click **"Carica estensione non pacchettizzata"**
4. Seleziona la cartella `anti-bestemmie/` (questa)
5. L'icona apparirà nella barra (puzzle piece grigia finché non si aggiungono le icone PNG — vedi sezione *Icone*)

### Abilitare Gemini Nano (se non già attivo)

1. Vai a `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
2. Riavvia Chrome
3. Vai a `chrome://components` → trova **"Optimization Guide On Device Model"** → click **"Verifica aggiornamenti"**
4. Aspetta il download (~2-4 GB, può richiedere minuti)
5. Verifica nello status pill del popup dell'estensione: deve dire *"Gemini Nano: attivo ✓"*

---

## Architettura

```
anti-bestemmie/
├── manifest.json
├── src/
│   ├── core/                 Logica condivisa (no DOM, no chrome.*)
│   │   ├── wordlist.js       Pattern blocklist + token sospetti
│   │   └── detector.js       Engine Tier 1+2+3
│   ├── content/content.js    DOM walker + MutationObserver (per-pagina)
│   ├── offscreen/            Audio pipeline (tabCapture + SR + bip)
│   │   ├── offscreen.html
│   │   └── offscreen.js
│   ├── background/
│   │   └── service-worker.js Orchestrazione audio + stats + badge
│   ├── popup/                UI rapida (toggle, stats)
│   └── options/              Whitelist domini, parole custom, stats dettagliate
└── assets/                   Icone (vuoto in v0.1)
```

### Detection ibrida

- **Tier 1** (regex blocklist): `src/core/wordlist.js`. Pattern certi tipo `porc* dio`, `dio cane`, `madonna troia`. Sync, gratis, <1ms.
- **Tier 2** (Gemini Nano): se un token "sospetto" (radici sacre standalone come `dio`, `madonna`, `porco`) appare in un contesto non innocuo, chiediamo a Nano un giudizio strutturato JSON `{is_blasphemy, phrase}`. Async, ~50-500ms.
- **Tier 3** (fallback): se Nano non c'è (Chrome vecchio, niente disco), si rimane al Tier 1.

### Edge case gestiti

- ✅ MutationObserver per contenuti che arrivano via JS (commenti, infinite scroll)
- ✅ Shadow DOM (YouTube comments)
- ✅ iframes (`all_frames: true`)
- ✅ Non tocca `<input>`, `<textarea>`, `contenteditable` (per non rompere quello che l'utente scrive)
- ✅ Whitelist eufemismi (`porco zio`, `dio mio`, `madonna mia` ecc.)
- ✅ Skip `<script>`, `<style>`, `<code>`, `<pre>`

### Cosa è fuori scope (per scelta)

- ❌ Bestemmie pronunciate dall'utente al microfono
- ❌ Censura di quello che l'utente sta scrivendo (input fields)
- ❌ Lingue diverse dall'italiano

---

## Icone

In `v0.1.0` non ci sono icone PNG. Chrome mostrerà l'icona placeholder a forma di puzzle piece, ma l'estensione funziona comunque.

Per aggiungere icone, crea `assets/icon16.png`, `assets/icon48.png`, `assets/icon128.png` e nel `manifest.json` aggiungi:

```json
"icons": {
  "16": "assets/icon16.png",
  "48": "assets/icon48.png",
  "128": "assets/icon128.png"
},
"action": {
  "default_popup": "src/popup/popup.html",
  "default_icon": {
    "16": "assets/icon16.png",
    "48": "assets/icon48.png"
  }
}
```

---

## Uso

1. Click sull'icona dell'estensione → si apre il popup.
2. **"Estensione attiva"**: ON/OFF globale. Default ON.
3. **"Bip su audio del tab"**: opt-in. Quando attivato, l'estensione chiede a Chrome la cattura dell'audio del tab corrente, lo riproduce a te e lo passa contemporaneamente a SpeechRecognition. Bippa quando rileva.
4. **"Ricensura pagina ora"**: forza un ripasso completo del DOM corrente. Utile dopo un cambio di configurazione.
5. Click **"Opzioni avanzate"** per whitelist domini, pattern custom, e statistiche.

---

## Privacy

- **Zero rete.** Nessuna chiamata HTTP esce dall'estensione.
- Gemini Nano gira **localmente** nel browser. Il modello è scaricato una volta da Chrome stesso, dopo gira offline.
- SpeechRecognition: in Chrome la trascrizione passa storicamente attraverso server Google. Da Chrome 138+ con motore on-device disponibile, può girare offline — ma non è garantito. Se questo è un problema, lascia disattivato il bip audio.
- Le statistiche sono salvate **solo** in `chrome.storage.local`.

---

## Audio detection (Whisper)

L'audio rilevamento usa **Whisper-tiny** via Transformers.js, on-device:

- Al primo uso del toggle "Bip su audio del tab" l'estensione scarica il modello (~75MB) da `huggingface.co`. Una sola volta. Poi cached in IndexedDB del browser.
- Library Transformers.js (~22MB di codice + WASM ONNX Runtime) è **bundle locale** in `vendor/transformers/`. Niente CDN al runtime.
- Inferenza: WebGPU se disponibile, altrimenti fallback WASM.
- Latenza: chunk audio da 4s -> trascrizione ~0.5-2s -> bip se trovata bestemmia. Totale 4.5-6s di ritardo.

L'architettura precedente (Web Speech API) non funzionava: SR usa il microfono di sistema, non l'audio del tab.

L'architettura intermedia (Gemini Nano multimodale audio) richiede una capability che Chrome non espone stabilmente al momento.

## Limiti noti

- Il bip audio è **reattivo**, non predittivo: ~4-6s di ritardo. È un avviso, non censura preventiva.
- Bestemmie che attraversano più text node (es. "porco" in un `<b>` e "dio" nel testo successivo) potrebbero non essere catturate dal Tier 1. Il MutationObserver le riprenderà se il DOM cambia.
- L'estensione non funziona su pagine `chrome://`, `chrome-extension://`, `about:*` (limitazione Chrome, non aggirabile).
- Su mobile Chrome **non gira** (Gemini Nano non è disponibile su Android/iOS; Transformers.js richiede WebGPU/WASM threading).

---

## Sviluppo

Niente build step. È vanilla JS. Modifica i file, ricarica l'estensione da `chrome://extensions` con il bottone refresh.

Per debuggare:
- Content script: DevTools della pagina (F12) → Console.
- Service worker: `chrome://extensions` → "Service worker" link sotto la card dell'estensione.
- Offscreen: stesso punto, link "offscreen.html".
- Popup: tasto destro sull'icona → "Ispeziona popup".

---

## Roadmap

- [ ] v0.2: audio ducking (abbassa il volume sotto al bip)
- [ ] v0.2: aggiungere icone PNG
- [ ] v0.3: detection in canvas/video con captions (live captions YouTube)
- [ ] v0.4: supporto dialetti regionali (toscano, veneto)
- [ ] v0.5: dashboard statistiche con grafici
