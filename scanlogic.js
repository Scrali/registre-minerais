// Logique pure de la capture, partagée par le site (script classique) et les tests (import Node).
(function (root) {
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
  const qk = q => (q === "" || q == null || q === "-" || !isFinite(parseFloat(q))) ? "-" : String(Math.min(1000, Math.max(0, Math.round(+q))));
  const sig = it => `${norm(it.name)}|${qk(it.quality)}|${+it.qty || 0}|${norm(it.unit)}`;

  // Ordre de lecture d'une page : par rangée (même hauteur à 3 % près), puis de gauche à droite.
  function readingOrder(items) {
    const withBox = items.filter(i => Array.isArray(i.box) && i.box.length === 4);
    if (withBox.length !== items.length) return items.slice();
    const sorted = withBox.slice().sort((a, b) => a.box[1] - b.box[1]);
    const rows = [];
    for (const it of sorted) {
      const row = rows.find(r => Math.abs(r.y - it.box[1]) <= 30);
      if (row) row.items.push(it); else rows.push({ y: it.box[1], items: [it] });
    }
    return rows.sort((a, b) => a.y - b.y).flatMap(r => r.items.sort((a, b) => a.box[0] - b.box[0]));
  }

  // Cases probablement répétées entre deux pages consécutives qui se chevauchent : la fin de la page N
  // et le début de la page N+1 montrent la même suite d'au moins 2 cases (minerai, qualité, quantité).
  // Une seule case identique ne suffit pas : deux lots identiques peuvent exister.
  // Renvoie les cases de la page N+1 à ne pas compter deux fois.
  function flagOverlaps(items, minRun = 2) {
    const pages = [...new Set(items.map(i => i.page))].sort((a, b) => a - b);
    const out = [];
    for (let p = 0; p + 1 < pages.length; p++) {
      const A = readingOrder(items.filter(i => i.page === pages[p]));
      const B = readingOrder(items.filter(i => i.page === pages[p + 1]));
      for (let k = Math.min(A.length, B.length); k >= minRun; k--) {
        const tail = A.slice(A.length - k).map(sig), head = B.slice(0, k).map(sig);
        if (tail.every((s, i) => s === head[i])) { out.push(...B.slice(0, k)); break; }
      }
    }
    return out;
  }

  // Clé d'une ligne de stock : ressource + qualité + unité (même clé que la base).
  const stockKey = (resourceId, quality, unit) => `${resourceId}|${qk(quality)}|${String(unit || "").trim()}`;

  root.ScanLogic = { norm, qk, sig, readingOrder, flagOverlaps, stockKey };
})(typeof globalThis !== "undefined" ? globalThis : window);
