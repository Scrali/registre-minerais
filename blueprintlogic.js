// Comparaison d'une recette de blueprint avec les stocks : logique pure, partagée par le site et les tests.
// Ne modifie rien : calcule seulement ce qui est disponible et ce qui manque.
(function (root) {
  // Quantités en millionièmes d'unité (entiers) : 0,1 + 0,2 SCU = 0,3 SCU exactement.
  const M = 1e6;
  const toMicro = v => Math.round(Number(v) * M);
  const fromMicro = v => v / M;
  // Conversion vers l'unité de la recette. 1 SCU = 100 cSCU = 1 000 000 µSCU. Objets : jamais convertis en SCU.
  const SCU_FACTOR = { SCU: 1, cSCU: 0.01, "µSCU": 1e-6 };
  function inUnit(qty, stockUnit, wantUnit) {
    if (wantUnit === "SCU") return stockUnit in SCU_FACTOR ? toMicro(qty * SCU_FACTOR[stockUnit]) : null;
    return (stockUnit || "") === (wantUnit || "") ? toMicro(qty) : null;
  }
  const qOf = k => (k === "-" || k == null || k === "") ? null : Number(k);

  // Emplacements d'un palier : options regroupées, quantités multipliées par le nombre de fabrications.
  function slotsOf(ingredients, tier = 0, crafts = 1) {
    const by = new Map();
    for (const i of ingredients.filter(x => (x.tier_index || 0) === tier).sort((a, b) => a.slot_position - b.slot_position || a.option_index - b.option_index)) {
      if (!by.has(i.slot_position)) by.set(i.slot_position, { slot_key: i.slot_key, slot_name: i.slot_name, slot_position: i.slot_position,
        required_count: i.required_count == null ? null : i.required_count, option_count: i.option_count || 1, options: [] });
      by.get(i.slot_position).options.push({ ...i, need: i.quantity == null ? null : toMicro(i.quantity) * crafts });
    }
    for (const s of by.values()) {
      // Sans nombre requis : toutes les options sont nécessaires (aucune hypothèse de choix).
      s.pick = s.required_count == null ? s.options.length : Math.min(s.required_count, s.options.length);
      s.choice = s.pick < s.options.length;
    }
    return [...by.values()];
  }

  // Lots utilisables pour une ressource, triés du moins bon au meilleur.
  function lotsFor(stocks, resourceId, unit) {
    const out = [];
    for (const s of stocks) {
      if (s.resource_id !== resourceId) continue;
      const q = inUnit(Number(s.quantity) || 0, s.unit || "", unit);
      if (q == null || q <= 0) continue;
      out.push({ q: qOf(s.quality_key), left: q });
    }
    return out.sort((a, b) => (a.q ?? -1) - (b.q ?? -1));
  }

  // Une demande accepte un lot si sa qualité est connue et suffisante. Qualité inconnue : seulement sans minimum (0).
  // Qualité minimale non fournie par l'API : tous les lots comptent, et le résultat le signale.
  const accepts = (minQ, lotQ) => minQ == null ? true : lotQ == null ? minQ <= 0 : lotQ >= minQ;

  // Répartit les lots entre les demandes : qualité minimale la plus exigeante d'abord, en prenant le lot suffisant le plus faible.
  function allocate(demands, stocks) {
    const groups = new Map();
    for (const d of demands) {
      const k = d.resource_id + "|" + d.unit;
      if (!groups.has(k)) groups.set(k, { lots: lotsFor(stocks, d.resource_id, d.unit), list: [] });
      groups.get(k).list.push(d);
    }
    for (const g of groups.values()) {
      g.list.sort((a, b) => (b.min_quality ?? -1) - (a.min_quality ?? -1));
      for (const d of g.list) {
        let need = d.need, got = 0;
        for (const l of g.lots) {
          if (need <= 0) break;
          if (l.left <= 0 || !accepts(d.min_quality, l.q)) continue;
          const t = Math.min(need, l.left); l.left -= t; need -= t; got += t;
        }
        d.got = got;
      }
    }
  }

  // Disponible (toutes qualités confondues, dans l'unité de la recette) et part sous la qualité minimale.
  function overview(stocks, resourceId, unit, minQ) {
    let total = 0, ok = 0, unknown = 0;
    for (const l of lotsFor(stocks, resourceId, unit)) {
      total += l.left;
      if (l.q == null) unknown += l.left;
      if (accepts(minQ, l.q)) ok += l.left;
    }
    return { total, ok, unknown };
  }

  // map : { api_uuid -> resource_id } (correspondances confirmées seulement).
  function compare(ingredients, stocks, map, { tier = 0, crafts = 1 } = {}) {
    crafts = Math.max(1, Math.floor(Number(crafts) || 1));
    const slots = slotsOf(ingredients || [], tier, crafts);
    const prep = o => ({ ...o, resource_id: (o.api_uuid && map[o.api_uuid]) || null });
    for (const s of slots) s.options = s.options.map(prep);
    // Choix dans un emplacement alternatif : les options les mieux couvertes par le stock (évaluées seules).
    for (const s of slots) {
      if (!s.choice) { s.chosen = s.options.map((_, i) => i); continue; }
      const score = o => {
        if (!o.resource_id || o.need == null) return -1;
        const v = overview(stocks, o.resource_id, o.unit, o.min_quality).ok;
        return o.need === 0 ? 1 : Math.min(1, v / o.need);
      };
      s.chosen = s.options.map((o, i) => [i, score(o)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, s.pick).map(x => x[0]);
    }
    const demands = [];
    for (const s of slots) for (const i of s.chosen) {
      const o = s.options[i];
      if (o.resource_id && o.need != null) demands.push(o);
    }
    allocate(demands, stocks);
    let blocked = false, unknownData = false;
    const missing = new Map();
    for (const s of slots) {
      s.options.forEach((o, i) => {
        const used = s.chosen.includes(i);
        const ov = o.resource_id ? overview(stocks, o.resource_id, o.unit, o.min_quality) : { total: 0, ok: 0, unknown: 0 };
        o.available = fromMicro(ov.total);
        o.available_ok = fromMicro(ov.ok);
        o.unknown_quality = fromMicro(ov.unknown);
        o.need_value = o.need == null ? null : fromMicro(o.need);
        if (!o.resource_id) o.status = "unmapped";
        else if (o.need == null) o.status = "no_quantity";
        else if (!used) o.status = "alternative";
        else o.status = o.got >= o.need ? "ok" : "short";
        o.allocated = used && o.got != null ? fromMicro(o.got) : 0;
        o.missing = used && o.need != null ? fromMicro(Math.max(0, o.need - (o.resource_id ? (o.got || 0) : 0))) : null;
        if (!used) return;
        if (o.status === "unmapped" || o.status === "no_quantity") unknownData = true;
        if (o.min_quality == null) unknownData = true;
        if (o.status === "short" || o.status === "unmapped") {
          if (o.status === "short") blocked = true;
          if (o.missing > 0) {
            const k = (o.resource_id || o.api_uuid || o.name) + "|" + o.unit + "|" + (o.min_quality ?? "");
            const m = missing.get(k) || { resource_id: o.resource_id, api_uuid: o.api_uuid, name: o.name, unit: o.unit, min_quality: o.min_quality, missing: 0, mapped: !!o.resource_id };
            m.missing = fromMicro(toMicro(m.missing) + toMicro(o.missing));
            missing.set(k, m);
          }
        }
      });
    }
    // Réalisable : oui / non / indéterminé (matière sans correspondance ou donnée absente de l'API).
    const craftable = blocked ? false : unknownData ? null : true;
    return { slots, missing: [...missing.values()], craftable, crafts, tier };
  }

  // Nombre de fabrications possibles avec le stock (recherche jusqu'à 999). null si indéterminé.
  function maxCrafts(ingredients, stocks, map, { tier = 0 } = {}) {
    if (compare(ingredients, stocks, map, { tier, crafts: 1 }).craftable !== true) return compare(ingredients, stocks, map, { tier, crafts: 1 }).craftable === false ? 0 : null;
    let lo = 1, hi = 999;
    if (compare(ingredients, stocks, map, { tier, crafts: hi }).craftable === true) return hi;
    while (lo + 1 < hi) { const mid = (lo + hi) >> 1; if (compare(ingredients, stocks, map, { tier, crafts: mid }).craftable === true) lo = mid; else hi = mid; }
    return lo;
  }

  // Effet de la qualité sur une propriété, d'après l'API (modifiers d'un emplacement).
  //  - linear : interpolation entre at_min_quality et at_max_quality sur quality_range (bornes tenues au-delà) ;
  //  - value_segments : interpolation dans le segment qui contient la qualité ;
  //  - autre type, ou valeurs absentes : effet inconnu (null), jamais inventé.
  // Renvoie le multiplicateur (1 = aucun effet).
  function modifierAt(mod, q) {
    if (!mod || q == null || !isFinite(q)) return null;
    const lerp = (a, b, x0, x1, x) => x1 === x0 ? b : a + (b - a) * (Math.min(x1, Math.max(x0, x)) - x0) / (x1 - x0);
    if (mod.value_range_type !== "linear") return null;
    const seg = Array.isArray(mod.value_segments) ? mod.value_segments.filter(s => s && isFinite(s.modifier_at_start) && isFinite(s.modifier_at_end)) : [];
    if (seg.length) {
      const sorted = seg.slice().sort((a, b) => a.quality_min - b.quality_min);
      const s = sorted.find(x => q >= x.quality_min && q <= x.quality_max)
        || (q < sorted[0].quality_min ? sorted[0] : sorted[sorted.length - 1]);
      return lerp(s.modifier_at_start, s.modifier_at_end, s.quality_min, s.quality_max, q);
    }
    const r = mod.quality_range || {}, m = mod.modifier_range || {};
    if (![r.min, r.max, m.at_min_quality, m.at_max_quality].every(v => v != null && isFinite(v))) return null;
    return lerp(m.at_min_quality, m.at_max_quality, r.min, r.max, q);
  }
  // Effets par emplacement à partir des requirement_groups bruts de l'API : { slot_key: [modifiers] }.
  function modifiersBySlot(raw) {
    const out = {};
    for (const g of (raw && Array.isArray(raw.requirement_groups) ? raw.requirement_groups : [])) {
      const k = g.key || g.name; if (!k) continue;
      out[k] = (g.modifiers || []).filter(m => m && m.label);
    }
    return out;
  }

  root.BlueprintLogic = { modifierAt, modifiersBySlot, compare, maxCrafts, slotsOf, inUnit: (q, u, w) => { const v = inUnit(q, u, w); return v == null ? null : fromMicro(v); } };
})(typeof globalThis !== "undefined" ? globalThis : window);
