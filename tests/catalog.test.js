// Catalogue protégé, catalogue du jeu et apprentissage de la lecture des infobulles (migration 018).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, addUser, rpc, as } from "./harness.js";

const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
let db, owner, admin, m1;
const idOf = async n => (await db.query(`select id from resources where lower(name) = lower($1)`, [n])).rows[0]?.id;

before(async () => {
  db = await freshDb();
  owner = await addUser(db, "Owner", "admin");
  await db.query(`update profiles set is_owner = true where id = $1`, [owner]);
  admin = await addUser(db, "Admin", "admin");
  m1 = await addUser(db, "Matsu89");
  // Une ressource créée avant le remplissage (comme « Hadanite » en production) : complétée, pas dupliquée.
  await rpc(db, m1, "create_resource", [JSON.stringify({ name: "Hadanite" }), "manuel", ""]);
  // Une sortie de blueprint fictive pour vérifier l'ajout des armes et composants.
  await db.query(`insert into sc_game_versions (code) values ('t') on conflict do nothing`).catch(() => {});
});

test("Remplissage du catalogue : matières FR/EN, gemmes, protégées ; relançable sans doublon", async () => {
  const before = (await db.query(`select count(*)::int n from resources`)).rows[0].n;
  await rejects(rpc(db, m1, "seed_game_catalog", []), /administrateurs/);
  const added = await rpc(db, admin, "seed_game_catalog", []);
  assert.ok(added >= 60, `ressources ajoutées : ${added}`);
  const fer = (await db.query(`select name_en, category, unit, locked from resources where name = 'Fer'`)).rows[0];
  assert.deepEqual(fer, { name_en: "Iron", category: "Minerai raffiné", unit: "SCU", locked: true });
  const brut = (await db.query(`select name_en, category from resources where name = 'Cuivre (brut)'`)).rows[0];
  assert.deepEqual(brut, { name_en: "Copper (Ore)", category: "Minerai brut" });
  const had = (await db.query(`select count(*)::int n, bool_and(locked) l, max(category) c from resources where lower(name) = 'hadanite'`)).rows[0];
  assert.deepEqual(had, { n: 1, l: true, c: "Gemme" }, "ressource existante complétée et protégée");
  assert.equal(await rpc(db, admin, "seed_game_catalog", []), 0, "relancer n'ajoute rien");
  assert.equal((await db.query(`select count(*)::int n from resources`)).rows[0].n, before + added);
});

test("Ressource protégée : ni suppression, ni fusion dans une autre, ni retrait de la protection", async () => {
  const fer = await idOf("Fer"), cuivre = await idOf("Cuivre");
  await rejects(rpc(db, owner, "delete_resource", [fer]), /protégée/);
  await rejects(rpc(db, owner, "merge_resources", [fer, cuivre]), /protégée/);
  await rejects(db.query(`update resources set locked = false where id = $1`, [fer]), /protégée/);
  await rejects(db.query(`delete from resources where id = $1`, [fer]), /protégée/);
  assert.ok(await idOf("Fer"));
  // Une ressource créée à la main (doublon « Sadsryx ») reste fusionnable dans le catalogue.
  const sads = await rpc(db, m1, "create_resource", [JSON.stringify({ name: "Sadsryx" }), "manuel", ""]);
  await rpc(db, owner, "merge_resources", [sads, await idOf("Sadaryx")]);
  assert.equal(await idOf("Sadsryx"), undefined);
});

test("Réinitialisation du registre : stocks et historique vidés, catalogue protégé conservé", async () => {
  const libre = await rpc(db, m1, "create_resource", [JSON.stringify({ name: "Ressource libre" }), "manuel", ""]);
  const locked = (await db.query(`select count(*)::int n from resources where locked`)).rows[0].n;
  await rpc(db, owner, "reset_registre", ["REINITIALISER"]);
  assert.equal((await db.query(`select count(*)::int n from resources where locked`)).rows[0].n, locked);
  assert.equal((await db.query(`select count(*)::int n from resources where id = $1`, [libre])).rows[0].n, 0);
  assert.equal((await db.query(`select coalesce(sum(qty), 0)::int n from resources`)).rows[0].n, 0);
});

test("Apprentissage : noms et chiffres enregistrés par les membres, lus par l'organisation, oubliés par un admin", async () => {
  const sad = await idOf("Sadaryx");
  const sample = { aspect: 0.8, grid: Array(96).fill(0.5) };
  const n = await rpc(db, m1, "learn_ocr", [JSON.stringify([
    { kind: "name", seen: "sadsryx", resource_id: sad, was_right: false },
    { kind: "name", seen: "sadsryx", resource_id: sad },
    { kind: "glyph", value: "6", sample, was_right: true },
    { kind: "glyph", value: "66", sample },             // pas un chiffre : ignoré
    { kind: "name", seen: "", resource_id: sad },        // vide : ignoré
  ])]);
  assert.equal(n, 3);
  const rows = (await as(db, m1, `select kind, seen, value, hits from ocr_learning order by id`)).rows;
  assert.deepEqual(rows.map(r => [r.kind, r.seen, r.value, r.hits]), [["name", "sadsryx", "Sadaryx", 2], ["glyph", "", "6", 1]]);
  // Écriture directe refusée (seulement par la fonction), compte en attente refusé.
  await rejects(as(db, m1, `insert into ocr_learning (kind, value) values ('glyph', '1')`), /row-level security|permission/);
  const pending = await addUser(db, "Attente", "pending");
  await rejects(rpc(db, pending, "learn_ocr", [JSON.stringify([{ kind: "glyph", value: "1", sample }])]), /non validé/);
  // Au plus 40 exemples par chiffre.
  await rpc(db, m1, "learn_ocr", [JSON.stringify(Array.from({ length: 45 }, () => ({ kind: "glyph", value: "7", sample })))]);
  assert.equal((await db.query(`select count(*)::int n from ocr_learning where kind = 'glyph' and value = '7'`)).rows[0].n, 40);
  const id = rows.length && (await db.query(`select id from ocr_learning where kind = 'name'`)).rows[0].id;
  await rejects(rpc(db, m1, "forget_ocr", [id]), /administrateurs/);
  await rpc(db, admin, "forget_ocr", [id]);
  assert.equal((await db.query(`select count(*)::int n from ocr_learning where kind = 'name'`)).rows[0].n, 0);
});
