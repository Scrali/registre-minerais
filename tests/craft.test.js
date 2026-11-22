// Fabrication d'un blueprint (migration 020) : tous les lots retirés d'un coup, ou rien.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, addUser, rpc } from "./harness.js";

let db, alice, bob, cu, cor, bpId, loc;
const J = o => JSON.stringify(o);
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
const qty = async (u, res, q) => (await db.query(`select coalesce(sum(quantity), 0)::float t from user_stocks where user_id = $1 and resource_id = $2 and quality_key = $3`, [u, res, q])).rows[0].t;
const nMoves = async () => (await db.query(`select count(*)::int n from movements`)).rows[0].n;
const add = (u, res, q, n) => rpc(db, u, "adjust_stock", [J({ operation_id: randomUUID(), location: "Levski", resource_id: res, quality_key: q, unit: "SCU", mode: "add", quantity: n, kind: "deposit" })]);
const craft = (u, p) => rpc(db, u, "craft_blueprint", [J(p)]);
const lines = (a, b) => [{ location_id: loc, resource_id: cu, quality_key: "855", unit: "SCU", quantity: a, expected_before: 0.39 },
                         { location_id: loc, resource_id: cor, quality_key: "504", unit: "SCU", quantity: b }];

before(async () => {
  db = await freshDb();
  await addUser(db, "Admin", "admin");
  alice = await addUser(db, "Alice"); bob = await addUser(db, "Bob");
  cu = await rpc(db, alice, "create_resource", [J({ name: "Cuivre" }), "manuel", ""]);
  cor = await rpc(db, alice, "create_resource", [J({ name: "Corindon" }), "manuel", ""]);
  await add(alice, cu, "855", 0.39); await add(alice, cor, "504", 0.13); await add(bob, cu, "855", 5);
  loc = (await db.query(`select id from locations limit 1`)).rows[0].id;
  bpId = (await db.query(`insert into sc_blueprints (uuid, key, output_name) values ($1, 'bp_test', 'Fusil d''essai') returning id`, [randomUUID()])).rows[0].id;
});

test("Aperçu : avant / après pour chaque lot, sans rien écrire", async () => {
  const n = await nMoves();
  const r = await craft(alice, { dry_run: true, blueprint_id: bpId, crafts: 2, lines: lines(0.04, 0.08) });
  assert.equal(r.blueprint, "Fusil d'essai");
  assert.deepEqual(r.lines.map(l => [Number(l.before), Number(l.after)]), [[0.39, 0.35], [0.13, 0.05]]);
  assert.equal(await nMoves(), n);
  assert.equal(await qty(alice, cu, "855"), 0.39);
});

test("Un lot insuffisant : rien n'est retiré, même les lots suffisants", async () => {
  const n = await nMoves();
  await rejects(craft(alice, { operation_id: randomUUID(), blueprint_id: bpId, crafts: 9, lines: lines(0.04, 0.5) }), /Stock insuffisant de Corindon/);
  assert.equal(await qty(alice, cu, "855"), 0.39);
  assert.equal(await nMoves(), n);
});

test("Fabrication : tous les lots retirés d'un coup, nature « Consommation », nom du blueprint dans la note", async () => {
  const id = randomUUID(), n = await nMoves();
  const r = await craft(alice, { operation_id: id, blueprint_id: bpId, crafts: 2, lines: lines(0.04, 0.08) });
  assert.equal(r.replayed, false);
  assert.equal(await qty(alice, cu, "855"), 0.35);
  assert.equal(await qty(alice, cor, "504"), 0.05);
  assert.equal(await qty(bob, cu, "855"), 5, "le stock d'un autre membre n'est jamais touché");
  const m = (await db.query(`select kind, note, delta::float d from movements where operation_id = $1 order by id`, [id])).rows;
  assert.deepEqual(m, [{ kind: "consumption", note: "Fabrication ×2 : Fusil d'essai", d: -0.04 }, { kind: "consumption", note: "Fabrication ×2 : Fusil d'essai", d: -0.08 }]);
  // Double clic : même opération, un seul retrait.
  const again = await craft(alice, { operation_id: id, blueprint_id: bpId, crafts: 2, lines: lines(0.04, 0.08) });
  assert.equal(again.replayed, true);
  assert.equal(await nMoves(), n + 2);
  assert.equal(await qty(alice, cu, "855"), 0.35);
});

test("Stock changé depuis l'aperçu, lot en double, blueprint inconnu, compte en attente : refusés", async () => {
  await rejects(craft(alice, { operation_id: randomUUID(), blueprint_id: bpId, crafts: 1, lines: lines(0.01, 0.01) }), /STATE_CHANGED/);
  const one = { location_id: loc, resource_id: cu, quality_key: "855", unit: "SCU", quantity: 0.01 };
  await rejects(craft(alice, { operation_id: randomUUID(), blueprint_id: bpId, crafts: 1, lines: [one, one] }), /deux fois/);
  await rejects(craft(alice, { operation_id: randomUUID(), blueprint_id: 999999, crafts: 1, lines: [one] }), /Blueprint introuvable/);
  await rejects(craft(alice, { blueprint_id: bpId, crafts: 1, lines: [one] }), /Identifiant d'opération manquant/);
  const pending = await addUser(db, "Attente", "pending");
  await rejects(craft(pending, { operation_id: randomUUID(), blueprint_id: bpId, crafts: 1, lines: [one] }), /non validé/);
  assert.equal(await qty(alice, cu, "855"), 0.35);
});

test("Annulation : chaque retrait de la fabrication s'annule comme un mouvement ordinaire", async () => {
  const id = (await db.query(`select id from movements where kind = 'consumption' and delta = -0.04 order by id desc limit 1`)).rows[0].id;
  await rpc(db, alice, "reverse_movement", [J({ operation_id: randomUUID(), movement_id: id, note: "Fabrication annulée" })]);
  assert.equal(await qty(alice, cu, "855"), 0.39);
});
