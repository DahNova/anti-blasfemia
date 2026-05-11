// =====================================================================
// Anti-Bestemmie · wordlist
//
// Tier 1 (regex blocklist): pattern certi e storpiature comuni di bestemmie
// italiane. Una bestemmia italiana è quasi sempre la combinazione di una
// radice profanatoria (porco, madonna, dio, cristo, ecc.) con un altro
// termine offensivo. Quindi qui matchiamo *combinazioni*, non singole
// parole (che da sole non sono bestemmie).
//
// Esposto su globalThis come __SANTINO_WORDLIST per essere usato sia da
// content script sia da offscreen senza bundler.
// =====================================================================

(function () {
  'use strict';

  // --- Pattern certi (match -> Tier 1 censura immediata) ---
  // Combinazioni inequivocabilmente blasfeme in italiano.
  const CERTAIN_PATTERNS = [
    // porco/porca + divinità
    /\bp[o0]rc[oa]\s+d(?:[i1!ì]|io)\s*[a-zà-ù]*\b/giu,                   // "porco dio", "porco dioboia"
    /\bp[o0]rc[oa]\s+(?:madonn?a|cristo|ges[uù]|sacramento|giuda|diavolo)\b/giu,
    /\bporcodd?io\b/giu,
    /\bporcamadonna\b/giu,
    /\bporcaddio\b/giu,

    // dio + epiteti
    /\bd[i1!ì]o\s+(?:can[ei]?|p[o0]rc[oa]|boia|maiale|merda|stronzo|bestia|infame|ladr[oa]|schifoso|caro|m[èe]rd[ae]?|cagna|porc[ao]ne|sporco)\b/giu,
    /\bdiocan[ei]?\b/giu,
    /\bdioporc[oa]\b/giu,
    /\bdiomerd[ae]\b/giu,
    /\bdioboia\b/giu,
    /\bdiomaiale\b/giu,
    /\bdiobestia\b/giu,
    /\bdiosch[i1!ì]foso\b/giu,

    // madonna + epiteti
    /\bmadonn?a\s+(?:can[ea]?|troia|puttana|ladra|porca|schifosa|infame|maiala|merda|impestata|bagascia)\b/giu,
    /\bmadonnaputtana\b/giu,
    /\bmadonnatroia\b/giu,
    /\bmadonnacagna?\b/giu,
    /\bmadonnaladra\b/giu,
    /\bmadonnimpestata\b/giu,

    // cristo + epiteti
    /\bcristo\s+(?:di|del|della)\s+(?:un|una)?\s*(?:dio|d[i1!ì]o|madonna|porc[oa]|merda|stronzo|cane)\b/giu,
    /\bcristacc(?:i[oa]|i)\b/giu,
    /\bcristomerd[ae]\b/giu,

    // gesù
    /\bges[uù]\s+(?:cristo\s+)?(?:porc[oa]|merda|cane|bestia)\b/giu,

    // sacramento
    /\bsacrament[oi]\s+(?:di|del)\s+(?:un|una)?\s*(?:dio|d[i1!ì]o|porc[oa]|cristo)\b/giu,
    /\bsantosacramento\b/giu,
  ];

  // --- Token "sacri": parole religiose. Da sole NON sono bestemmie. ---
  const SACRED_TOKENS = [
    /\bd[i1!ì]o\b/giu,
    /\bmadonn?a\b/giu,
    /\bcristo\b/giu,
    /\bges[uù]\b/giu,
    /\bsacrament[oi]\b/giu,
  ];

  // --- Token "profani": termini dispregiativi che, accoppiati a un sacro
  //     a distanza ravvicinata, generano un sospetto da inviare a Nano. ---
  const PROFANE_TOKENS = [
    /\bp[o0]rc[oa]\b/giu,
    /\bcan[ei]?\b/giu,
    /\bmerda\b/giu,
    /\btroia\b/giu,
    /\bputtana\b/giu,
    /\bboia\b/giu,
    /\bmaiale\b/giu,
    /\bbestia\b/giu,
    /\bladr[oa]\b/giu,
    /\bschifos[oa]\b/giu,
    /\bstronz[oa]\b/giu,
    /\bcagna\b/giu,
    /\bbagascia\b/giu,
    /\bimpestata\b/giu,
    /\binfame\b/giu,
  ];

  // Whitelist di frasi innocue contenenti il pairing sacro+profano,
  // per evitare di scomodare Gemini Nano su pattern comuni e ovvi.
  const INNOCENT_PHRASES = [
    /\bporco\s+(zio|cane|due|dodici|mondo|qua|qui|miseria|paletta)\b/giu, // eufemismi
    /\bd[i1!ì]o\s+(mio|santo|onnipotente|padre|figlio|ti\s+ringrazi|sia\s+lodato)\b/giu,
    /\bmadonn?a\s+(mia|santa|del|della|di|dei|degli)\b/giu,
    /\bcristo\s+(re|risorto|si|salvatore|signore)\b/giu,
    /\bges[uù]\s+(cristo|bambino|risorto|salvatore)/giu,
    /\bgrazie\s+(a\s+)?(dio|d[i1!ì]o)\b/giu,
    /\boh\s+(mio\s+)?dio\b/giu,
    /\bperbacco\b/giu,
  ];

  globalThis.__SANTINO_WORDLIST = {
    CERTAIN_PATTERNS,
    SACRED_TOKENS,
    PROFANE_TOKENS,
    INNOCENT_PHRASES,
  };
})();
