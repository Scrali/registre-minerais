// Lecture d'une infobulle de caisse de minerai (texte reconnu par OCR dans le navigateur, sans IA).
// Infobulle du jeu, ligne utile : « Cuivre (M)   855   0.503 SCU » (nom, qualité, contenu).
// Les lignes « Volume : 1000000 µSCU » et « Capacité : 1.00 SCU » sont la TAILLE de la caisse : jamais lues comme contenu.
(function (root) {
  const UNIT = { scu: 1, cscu: 0.01, mscu: 1e-6, "µscu": 1e-6, uscu: 1e-6 };
  // Corrections OCR courantes dans les nombres (O -> 0, l/I -> 1, S -> 5 entre deux chiffres).
  const digits = s => s.replace(/(?<=\d)[oO](?=[\d.,]|$)|(?<=^|\s)[oO](?=[.,]\d)/g, "0").replace(/(?<=\d)[lI|](?=\d)/g, "1").replace(/(?<=\s\d{1,3})[sS](?=\s)/g, "5");
  const clean = s => String(s || "").replace(/[|¦]/g, " ").replace(/[‐-―]/g, "-").replace(/\s+/g, " ").trim();

  function parseTooltip(text) {
    const lines = String(text || "").split(/\r?\n/).map(clean).filter(Boolean);
    for (const raw of lines) {
      if (/volume|capacit|capacity/i.test(raw)) continue;
      // Point décimal perdu sur une petite image : « 0 001 SCU » = 0.001 SCU (un contenu ne commence jamais par 0 sinon).
      const l = digits(raw).replace(/(?<=\s)0 (\d{1,6})(?=\s*(?:µ\s?|[cmu]?\s?)SCU\b)/i, "0.$1");
      // nom (lettres, espaces, apostrophes), suffixe facultatif (M) / [M] / (Ore), qualité 0-1000, quantité, unité
      const m = l.match(/([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ' -]{1,40}?)\s*(?:[(\[]\s*(?:M|Ore|Raw|R)\s*[)\]])?\s+(\d{1,4})\s+(\d+(?:[.,]\d+)?)\s*(µ\s?SCU|[cmu]?\s?SCU)\b/i);
      if (!m) continue;
      const quality = +m[2];
      if (quality > 1000) continue;
      const unitKey = m[4].replace(/\s/g, "").toLowerCase();
      const factor = UNIT[unitKey];
      const qty = parseFloat(m[3].replace(",", "."));
      if (!factor || !isFinite(qty) || qty <= 0) continue;
      const name = m[1].replace(/\s*[-']\s*$/, "").trim();
      if (name.length < 2) continue;
      return { name, quality, qty: Math.round(qty * factor * 1e6) / 1e6, unit: "SCU", line: raw };
    }
    return null;
  }

  // Même caisse capturée deux fois de suite (même nom, qualité, contenu, à moins de quelques secondes) : doublon probable.
  const sameRead = (a, b, maxMs = 4000) => !!a && !!b && a.name.toLowerCase() === b.name.toLowerCase()
    && a.quality === b.quality && a.qty === b.qty && Math.abs((a.at || 0) - (b.at || 0)) <= maxMs;

  root.OcrLogic = { parseTooltip, sameRead };
})(typeof globalThis !== "undefined" ? globalThis : window);
