// =====================================================================
// Anti-Bestemmie · detector
//
// Engine ibrido:
//  - Tier 1: blocklist regex (sincrono, sempre disponibile)
//  - Tier 2: Gemini Nano via LanguageModel API (asincrono, opzionale)
//  - Tier 3: fallback — se Nano non c'è, ci si ferma al Tier 1
//
// API esposta su globalThis.__SANTINO_DETECTOR:
//   detectSync(text)         -> { matches: Match[], suspicious: Span[] }
//   detectWithNano(spans)    -> Promise<Match[]>   (verifica i sospetti)
//   censorText(text, matches, char='*') -> string
//
// Match: { start: number, end: number, original: string, source: 'tier1'|'tier2' }
// Span:  { start: number, end: number, context: string }
// =====================================================================

(function () {
  'use strict';

  const WL = globalThis.__SANTINO_WORDLIST;
  if (!WL) {
    console.error('[Anti-Bestemmie] wordlist non caricata');
    return;
  }

  // Quanti caratteri di contesto prendere intorno a un token sospetto
  // per passarlo a Nano (più contesto = giudizio migliore ma più costoso)
  const CONTEXT_RADIUS = 40;

  function isInnocent(snippet) {
    return WL.INNOCENT_PHRASES.some((re) => {
      re.lastIndex = 0;
      return re.test(snippet);
    });
  }

  function detectTier1(text) {
    const matches = [];
    for (const re of WL.CERTAIN_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push({
          start: m.index,
          end: m.index + m[0].length,
          original: m[0],
          source: 'tier1',
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    return mergeOverlapping(matches);
  }

  function detectSuspicious(text, alreadyMatched) {
    const spans = [];
    const covered = new Set();
    for (const m of alreadyMatched) {
      for (let i = m.start; i < m.end; i++) covered.add(i);
    }
    for (const re of WL.SUSPICIOUS_TOKENS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        // Skippa se già coperto da Tier 1
        if (covered.has(m.index)) {
          if (m.index === re.lastIndex) re.lastIndex++;
          continue;
        }
        const ctxStart = Math.max(0, m.index - CONTEXT_RADIUS);
        const ctxEnd = Math.min(text.length, m.index + m[0].length + CONTEXT_RADIUS);
        const context = text.slice(ctxStart, ctxEnd);
        // Skippa pattern innocenti noti (eufemismi, esclamazioni)
        if (isInnocent(context)) {
          if (m.index === re.lastIndex) re.lastIndex++;
          continue;
        }
        spans.push({
          start: m.index,
          end: m.index + m[0].length,
          context,
          ctxStart,
        });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
    return spans;
  }

  function detectSync(text) {
    if (!text || text.length < 3) return { matches: [], suspicious: [] };
    const matches = detectTier1(text);
    const suspicious = detectSuspicious(text, matches);
    return { matches, suspicious };
  }

  function mergeOverlapping(matches) {
    if (matches.length <= 1) return matches;
    const sorted = matches.slice().sort((a, b) => a.start - b.start);
    const out = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = out[out.length - 1];
      const cur = sorted[i];
      if (cur.start <= prev.end) {
        prev.end = Math.max(prev.end, cur.end);
        prev.original = (prev.original.length >= cur.original.length) ? prev.original : cur.original;
      } else {
        out.push(cur);
      }
    }
    return out;
  }

  function censorText(text, matches, char) {
    if (!matches || matches.length === 0) return text;
    const c = char || '*';
    const sorted = matches.slice().sort((a, b) => a.start - b.start);
    let result = '';
    let cursor = 0;
    for (const m of sorted) {
      result += text.slice(cursor, m.start);
      // Mantieni la prima lettera, asterisca il resto — leggibilità + censura
      const orig = text.slice(m.start, m.end);
      result += orig[0] + c.repeat(Math.max(0, orig.length - 1));
      cursor = m.end;
    }
    result += text.slice(cursor);
    return result;
  }

  // ---------- Tier 2: Gemini Nano ----------

  let _nanoSession = null;
  let _nanoUnavailable = false;

  async function getNanoSession() {
    if (_nanoUnavailable) return null;
    if (_nanoSession) return _nanoSession;
    try {
      // L'API LanguageModel è globale in Chrome 138+
      const LM = globalThis.LanguageModel;
      if (!LM) {
        _nanoUnavailable = true;
        return null;
      }
      const availability = await LM.availability();
      if (availability === 'unavailable') {
        _nanoUnavailable = true;
        return null;
      }
      _nanoSession = await LM.create({
        // Chrome Prompt API accetta solo [en, es, ja] sia in input sia in
        // output. L'italiano non è dichiarabile. Sotto al cofano Gemini Nano
        // è multilingue e processa l'italiano comunque — dichiariamo 'en'
        // formalmente, il prompt e i dati restano in italiano.
        expectedInputs: [{ type: 'text', languages: ['en'] }],
        expectedOutputs: [{ type: 'text', languages: ['en'] }],
        initialPrompts: [{
          role: 'system',
          content:
            'You are a classifier of Italian blasphemies. ' +
            'An Italian blasphemy ("bestemmia") is the combination of a sacred ' +
            'word (Dio, Madonna, Cristo, Gesù, sacramento, santi) with a ' +
            'profane or derogatory term (cane, porco, merda, troia, puttana, ' +
            'boia, ladro, schifoso, etc). ' +
            'NOT blasphemies: "porco zio", "porco cane", "dio mio", "madonna mia", ' +
            '"grazie a Dio", religious exclamations, cultural references. ' +
            'Always respond with valid JSON only, no extra text.',
        }],
        temperature: 0.1,
        topK: 1,
      });
      return _nanoSession;
    } catch (e) {
      console.warn('[Anti-Bestemmie] Nano init fallito:', e);
      _nanoUnavailable = true;
      return null;
    }
  }

  async function classifyWithNano(snippet) {
    const session = await getNanoSession();
    if (!session) return { is_blasphemy: false };
    try {
      const schema = {
        type: 'object',
        properties: {
          is_blasphemy: { type: 'boolean' },
          phrase: { type: 'string' },
        },
        required: ['is_blasphemy'],
      };
      const result = await session.prompt(
        `Questo snippet contiene una bestemmia italiana? Snippet: "${snippet}"\n` +
          `Se sì, in "phrase" riporta esattamente la bestemmia come appare nello snippet.`,
        { responseConstraint: schema }
      );
      return JSON.parse(result);
    } catch (e) {
      console.warn('[Anti-Bestemmie] Nano classify fallito:', e);
      return { is_blasphemy: false };
    }
  }

  async function detectWithNano(text, suspiciousSpans) {
    if (!suspiciousSpans || suspiciousSpans.length === 0) return [];
    const out = [];
    for (const span of suspiciousSpans) {
      const verdict = await classifyWithNano(span.context);
      if (!verdict.is_blasphemy) continue;
      if (verdict.phrase) {
        // Trova la frase esatta nel testo originale, partendo dall'inizio del contesto
        const where = text.indexOf(verdict.phrase, span.ctxStart);
        if (where !== -1) {
          out.push({
            start: where,
            end: where + verdict.phrase.length,
            original: verdict.phrase,
            source: 'tier2',
          });
          continue;
        }
      }
      // Fallback: censura solo il token sospetto stesso
      out.push({
        start: span.start,
        end: span.end,
        original: text.slice(span.start, span.end),
        source: 'tier2',
      });
    }
    return mergeOverlapping(out);
  }

  async function isNanoAvailable() {
    const s = await getNanoSession();
    return s !== null;
  }

  globalThis.__SANTINO_DETECTOR = {
    detectSync,
    detectWithNano,
    censorText,
    isNanoAvailable,
    mergeOverlapping,
  };
})();
