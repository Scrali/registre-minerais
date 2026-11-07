// Tests du calcul « disponible / manquant » d'un blueprint (blueprintlogic.js). Aucun stock n'est modifié.
import { test } from "node:test";
import assert from "node:assert/strict";
import "../blueprintlogic.js";
const { compare, maxCrafts, inUnit } = globalThis.BlueprintLogic;

const IRON = "iron-uuid", ICE = "ice-uuid", HAD = "had-uuid", CU = "cu-uuid";
const ing = (slot_position, api_uuid, name, quantity, unit, min_quality, o = {}) =>
  ({ tier_index: 0, slot_key: "S" + slot_position, slot_name: "S" + slot_position, slot_position, required_count: 1, option_count: 1,
     option_index: 0, kind: unit === "SCU" ? "resource" : "item", api_uuid, name, quantity, unit, min_quality, ...o });
const st = (resource_id, quality_key, quantity, unit = "SCU") => ({ resource_id, quality_key, quantity, unit });
const map = { [IRON]: "R-iron", [ICE]: "R-ice", [HAD]: "R-had", [CU]: "R-cu" };
// QuikCool réel : fer 0,16 (Q1+), glace 0,16 (Q1+), fer 0,1 (Q1+).
const quik = [ing(0, IRON, "Iron", 0.16, "SCU", 1), ing(1, ICE, "Pressurized Ice", 0.16, "SCU", 1), ing(2, IRON, "Iron", 0.1, "SCU", 1)];

test("Réalisable : quantités exactes (0,16 + 0,1 = 0,26 SCU de fer, sans erreur d'arrondi)", () => {
  const r = compare(quik, [st("R-iron", "300", 0.26), st("R-ice", "50", 1)], map);
  assert.equal(r.craftable, true); assert.deepEqual(r.missing, []);
  const r2 = compare(quik, [st("R-iron", "300", 0.25), st("R-ice", "50", 1)], map);
  assert.equal(r2.craftable, false);
  assert.deepEqual(r2.missing.map(m => [m.name, m.missing]), [["Iron", 0.01]]);
});

test("cSCU convertis pour la comparaison (100 cSCU = 1 SCU) ; objets jamais confondus avec des SCU", () => {
  assert.equal(inUnit(26, "cSCU", "SCU"), 0.26);
  assert.equal(inUnit(5, "", "SCU"), null);
  assert.equal(compare(quik, [st("R-iron", "300", 26, "cSCU"), st("R-ice", "50", 16, "cSCU")], map).craftable, true);
  const items = [ing(0, HAD, "Hadanite", 7, "", 1)];
  assert.equal(compare(items, [st("R-had", "500", 7, "SCU")], map).craftable, false, "7 SCU ne sont pas 7 objets");
  assert.equal(compare(items, [st("R-had", "500", 7, "")], map).craftable, true);
});

test("Qualité minimale : lots insuffisants exclus, qualité inconnue jamais comptée pour un minimum", () => {
  const meta = [ing(0, IRON, "Iron", 2, "SCU", 900)];
  const r = compare(meta, [st("R-iron", "850", 5), st("R-iron", "-", 5), st("R-iron", "950", 1)], map);
  assert.equal(r.craftable, false);
  const o = r.slots[0].options[0];
  assert.deepEqual([o.available, o.available_ok, o.unknown_quality, o.missing], [11, 1, 5, 1]);
  const free = [ing(0, IRON, "Iron", 2, "SCU", 0)];
  assert.equal(compare(free, [st("R-iron", "-", 2)], map).craftable, true, "sans minimum, une qualité inconnue convient");
});

test("Même ressource dans deux emplacements de qualités différentes : répartition sans double comptage", () => {
  const two = [ing(0, IRON, "Iron", 1, "SCU", 800), ing(1, IRON, "Iron", 1, "SCU", 100)];
  assert.equal(compare(two, [st("R-iron", "850", 1), st("R-iron", "200", 1)], map).craftable, true);
  assert.equal(compare(two, [st("R-iron", "850", 1)], map).craftable, false, "le même lot ne sert pas deux fois");
  assert.equal(compare(two, [st("R-iron", "850", 2)], map).craftable, true);
});

test("Plusieurs fabrications, nombre maximal réalisable", () => {
  const stocks = [st("R-iron", "300", 1.04), st("R-ice", "50", 0.64)];
  assert.equal(compare(quik, stocks, map, { crafts: 4 }).craftable, true);
  assert.equal(compare(quik, stocks, map, { crafts: 5 }).craftable, false);
  assert.equal(maxCrafts(quik, stocks, map), 4);
  assert.equal(maxCrafts(quik, [], map), 0);
});

test("Correspondance non validée ou quantité absente : jamais « réalisable », rien n'est inventé", () => {
  const r = compare(quik, [st("R-iron", "300", 9)], { [IRON]: "R-iron" });
  assert.equal(r.craftable, null, "glace sans correspondance validée : indéterminé, jamais « réalisable »");
  assert.deepEqual(r.missing.map(m => [m.name, m.mapped, m.missing]), [["Pressurized Ice", false, 0.16]]);
  const u = compare([ing(0, IRON, "Iron", 0.1, "SCU", 1), ing(1, "x-uuid", "Inconnu", 1, "SCU", 1)], [st("R-iron", "300", 9)], map);
  assert.equal(u.craftable, null);
  assert.equal(u.slots[1].options[0].status, "unmapped");
  const nq = compare([ing(0, IRON, "Iron", null, "SCU", 1)], [st("R-iron", "300", 9)], map);
  assert.equal(nq.craftable, null); assert.equal(nq.slots[0].options[0].status, "no_quantity");
  const nmq = compare([ing(0, IRON, "Iron", 1, "SCU", null)], [st("R-iron", "300", 9)], map);
  assert.equal(nmq.craftable, null, "qualité minimale non fournie : indéterminé");
});

test("Emplacement au choix : l'option la mieux couverte est retenue, l'autre reste une alternative", () => {
  const alt = [ing(0, IRON, "Iron", 1, "SCU", 300, { option_count: 2 }), ing(0, CU, "Copper", 2, "SCU", 300, { option_count: 2, option_index: 1 })];
  const r = compare(alt, [st("R-cu", "400", 2)], map);
  assert.equal(r.craftable, true);
  assert.deepEqual(r.slots[0].options.map(o => o.status), ["alternative", "ok"]);
});

test("Le calcul ne modifie pas les stocks passés en entrée", () => {
  const stocks = [st("R-iron", "300", 0.26), st("R-ice", "50", 1)], copy = JSON.stringify(stocks);
  compare(quik, stocks, map, { crafts: 3 }); maxCrafts(quik, stocks, map);
  assert.equal(JSON.stringify(stocks), copy);
});

test("Effet de la qualité : linéaire, par segments, et inconnu quand l'API ne le donne pas", () => {
  const { modifierAt, modifiersBySlot } = globalThis.BlueprintLogic;
  const lin = { value_range_type: "linear", quality_range: { min: 0, max: 1000 }, modifier_range: { at_min_quality: 0.9, at_max_quality: 1.1 } };
  assert.equal(modifierAt(lin, 500), 1); assert.equal(+modifierAt(lin, 1000).toFixed(6), 1.1); assert.equal(+modifierAt(lin, 0).toFixed(6), 0.9);
  const half = { value_range_type: "linear", quality_range: { min: 500, max: 1000 }, modifier_range: { at_min_quality: 1, at_max_quality: 1.2 } };
  assert.equal(modifierAt(half, 200), 1, "sous la plage : borne basse");
  const seg = { value_range_type: "linear", quality_range: { min: 0, max: 500 }, modifier_range: { at_min_quality: 0.8, at_max_quality: 1 },
    value_segments: [{ quality_min: 0, quality_max: 500, modifier_at_start: 0.8, modifier_at_end: 1 }, { quality_min: 501, quality_max: 1000, modifier_at_start: 1, modifier_at_end: 1.2 }] };
  assert.equal(+modifierAt(seg, 250).toFixed(6), 0.9); assert.equal(+modifierAt(seg, 1000).toFixed(6), 1.2);
  assert.equal(modifierAt({ value_range_type: "linear_integer_additive", value_segments: [] }, 500), null);
  assert.equal(modifierAt({ value_range_type: null, quality_range: { min: null, max: null }, modifier_range: {} }, 500), null);
  assert.deepEqual(Object.keys(modifiersBySlot({ requirement_groups: [{ key: "FRAME", modifiers: [lin] }, { name: "Emitter", modifiers: [] }] })), ["FRAME", "Emitter"]);
});
