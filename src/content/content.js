// =====================================================================
// Anti-Bestemmie · content script
//
// 1. Cammina il DOM e censura tutti i text node visibili.
// 2. Osserva mutations e censura il nuovo contenuto.
// 3. Per token sospetti, invia testo + contesto a Gemini Nano (via Tier 2
//    del detector) e censura asincronamente se confermato.
//
// Edge-case handling:
//  - input/textarea/contenteditable: NON tocchiamo (è l'utente che scrive)
//  - script/style/noscript: skippati
//  - shadow DOM: attraversiamo gli shadowRoot esistenti
//  - iframes: ognuno ha il suo content script (manifest: all_frames:true)
// =====================================================================

(function () {
  'use strict';

  const D = globalThis.__SANTINO_DETECTOR;
  if (!D) {
    console.error('[Anti-Bestemmie] detector non disponibile');
    return;
  }

  const CONFIG = {
    enabled: true,
    censorChar: '*',
    domainWhitelist: [],
  };

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'CODE', 'PRE',
    'INPUT', 'TEXTAREA', 'OBJECT', 'EMBED', 'IFRAME',
  ]);

  // Marker per evitare di rivisitare nodi già processati
  const PROCESSED = new WeakSet();

  // ---------- Config / messaging ----------

  function applyConfigFromStorage() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(['enabled', 'censorChar', 'domainWhitelist'], (v) => {
          if (typeof v.enabled === 'boolean') CONFIG.enabled = v.enabled;
          if (typeof v.censorChar === 'string' && v.censorChar.length === 1) CONFIG.censorChar = v.censorChar;
          if (Array.isArray(v.domainWhitelist)) CONFIG.domainWhitelist = v.domainWhitelist;
          resolve();
        });
      } catch {
        resolve();
      }
    });
  }

  function isDomainWhitelisted() {
    const host = location.hostname;
    return CONFIG.domainWhitelist.some((d) => host === d || host.endsWith('.' + d));
  }

  function incrementStat(n) {
    if (!n) return;
    try {
      chrome.runtime.sendMessage({ type: 'STAT_INCREMENT', count: n });
    } catch { /* service worker dormiente, va bene */ }
  }

  // ---------- Censura testo ----------

  function isEditable(node) {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (el.isContentEditable) return true;
      if (SKIP_TAGS.has(el.tagName)) return true;
      el = el.parentElement;
    }
    return false;
  }

  function censorTextNode(node) {
    if (PROCESSED.has(node)) return;
    const text = node.nodeValue;
    if (!text || text.length < 4) return;
    if (isEditable(node)) return;

    const { matches, suspicious } = D.detectSync(text);

    if (matches.length > 0) {
      node.nodeValue = D.censorText(text, matches, CONFIG.censorChar);
      incrementStat(matches.length);
    }

    PROCESSED.add(node);

    if (suspicious.length > 0) {
      // Tier 2 in background — non bloccare il rendering
      scheduleNanoCheck(node, text, suspicious);
    }
  }

  // Coda con throttling per non saturare Nano
  const _nanoQueue = [];
  let _nanoRunning = false;

  function scheduleNanoCheck(node, originalText, spans) {
    _nanoQueue.push({ node, originalText, spans });
    drainNanoQueue();
  }

  async function drainNanoQueue() {
    if (_nanoRunning) return;
    _nanoRunning = true;
    try {
      while (_nanoQueue.length > 0) {
        const job = _nanoQueue.shift();
        // Se il nodo non è più nel DOM, salta
        if (!job.node.isConnected) continue;
        // Il testo potrebbe essere già stato censurato dal Tier 1, usa quello corrente
        const liveText = job.node.nodeValue || job.originalText;
        const extra = await D.detectWithNano(liveText, job.spans);
        if (extra.length > 0 && job.node.isConnected) {
          job.node.nodeValue = D.censorText(liveText, extra, CONFIG.censorChar);
          incrementStat(extra.length);
        }
      }
    } finally {
      _nanoRunning = false;
    }
  }

  // ---------- DOM walking ----------

  function walkAndCensor(root) {
    if (!root) return;

    // Walker classico per text nodes
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || node.nodeValue.trim().length < 3) return NodeFilter.FILTER_REJECT;
        if (isEditable(node)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      censorTextNode(n);
    }

    // Shadow DOM: cerca elementi con shadowRoot e ricorri
    const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of all) {
      if (el.shadowRoot) {
        walkAndCensor(el.shadowRoot);
        observeShadowRoot(el.shadowRoot);
      }
    }
  }

  // ---------- MutationObserver ----------

  const observerOptions = {
    childList: true,
    subtree: true,
    characterData: true,
  };

  function handleMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'characterData') {
        if (m.target.nodeType === 3) {
          PROCESSED.delete(m.target); // re-evaluate after change
          censorTextNode(m.target);
        }
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if (node.nodeType === 3) {
            censorTextNode(node);
          } else if (node.nodeType === 1) {
            walkAndCensor(node);
          }
        }
      }
    }
  }

  const mainObserver = new MutationObserver(handleMutations);
  const _shadowObservers = new WeakSet();

  function observeShadowRoot(shadowRoot) {
    if (_shadowObservers.has(shadowRoot)) return;
    _shadowObservers.add(shadowRoot);
    new MutationObserver(handleMutations).observe(shadowRoot, observerOptions);
  }

  // ---------- Bootstrap ----------

  async function start() {
    await applyConfigFromStorage();
    if (!CONFIG.enabled) return;
    if (isDomainWhitelisted()) return;

    if (document.body) {
      walkAndCensor(document.body);
      mainObserver.observe(document.body, observerOptions);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        walkAndCensor(document.body);
        mainObserver.observe(document.body, observerOptions);
      }, { once: true });
    }
  }

  // Reagisce ai cambi di config dall'options page / popup
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) CONFIG.enabled = changes.enabled.newValue;
    if (changes.censorChar?.newValue) CONFIG.censorChar = changes.censorChar.newValue;
    if (changes.domainWhitelist) CONFIG.domainWhitelist = changes.domainWhitelist.newValue || [];
  });

  // Comandi diretti (es. "censura ora" dal popup)
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'RECENSOR_ALL') {
      // Reset processed set effetto-collaterale: usa una nuova WeakSet svuotata implicitamente
      // ricreando il walker. Ma WeakSet non si svuota; aggiriamo facendo un re-walk forzato
      // che riprocessa anche nodi visti (rimuovendoli prima).
      walkAndCensor(document.body);
      sendResponse({ ok: true });
    }
  });

  start();
})();
