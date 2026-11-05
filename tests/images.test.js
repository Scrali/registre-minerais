// Tests de la bibliothèque d'images de référence (migration 007).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runRemaining, addUser, rpc, as } from "./harness.js";

const img = c => "data:image/jpeg;base64," + c.repeat(8);
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
let db, admin, m1, m2, res;

before(async () => {
  db = await freshDb();
  admin = await addUser(db, "Admin", "admin");
  m1 = await addUser(db, "Matsu89");
  m2 = await addUser(db, "JoueurB");
  res = await rpc(db, admin, "create_resource", [JSON.stringify({ name: "Glacosite" }), "manuel", ""]);
});

const count = async r => (await db.query(`select count(*)::int as n from reference_images where resource_id = $1`, [r])).rows[0].n;
const primary = async r => (await db.query(`select image from resources where id = $1`, [r])).rows[0].image;

test("Ajout classé par écran ; la première image devient l'image principale", async () => {
  await rpc(db, m1, "add_reference_image", [res, img("A"), "inventaire", "capture", ""]);
  await rpc(db, m1, "add_reference_image", [res, img("B"), "ascenseur_fret", "capture", ""]);
  assert.equal(await count(res), 2);
  assert.equal(await primary(res), img("A"));
  const t = (await db.query(`select terminal_type from reference_images where resource_id = $1 order by id`, [res])).rows.map(r => r.terminal_type);
  assert.deepEqual(t, ["inventaire", "ascenseur_fret"]);
});

test("Une image identique n'est pas dupliquée ; son écran inconnu est précisé", async () => {
  const id = await rpc(db, m2, "add_reference_image", [res, img("C"), "inconnu", "capture", ""]);
  const again = await rpc(db, m2, "add_reference_image", [res, img("C"), "ascenseur_fret", "capture", ""]);
  assert.equal(again, id);
  assert.equal(await count(res), 3);
  assert.equal((await db.query(`select terminal_type from reference_images where id = $1`, [id])).rows[0].terminal_type, "ascenseur_fret");
});

test("Image invalide, compte en attente et écriture directe refusés", async () => {
  await rejects(rpc(db, m1, "add_reference_image", [res, "data:image/png;base64,AAAA", "inventaire", "capture", ""]), /invalide/);
  const pending = await addUser(db, "EnAttente", "pending");
  await rejects(rpc(db, pending, "add_reference_image", [res, img("Z"), "inventaire", "capture", ""]), /non validé/);
  await rejects(as(db, m1, `insert into reference_images (resource_id, image) values ($1, $2)`, [res, img("Y")]), /row-level security/);
  const del = await as(db, m1, `delete from reference_images where resource_id = $1`, [res]);
  assert.equal(del.affectedRows, 0);
});

test("Retrait : seulement par l'auteur ou un admin ; l'image principale est remplacée", async () => {
  const idA = (await db.query(`select id from reference_images where image = $1`, [img("A")])).rows[0].id;
  await rejects(rpc(db, m2, "delete_reference_image", [idA]), /auteur/);
  await rpc(db, m1, "delete_reference_image", [idA]);
  assert.equal(await count(res), 2);
  assert.notEqual(await primary(res), img("A"));
  assert.notEqual(await primary(res), "");
  const idC = (await db.query(`select id from reference_images where image = $1`, [img("C")])).rows[0].id;
  await rpc(db, admin, "delete_reference_image", [idC]);
  assert.equal(await count(res), 1);
});

test("Choix de l'image principale : réservé au droit « catalogue »", async () => {
  const idB = (await db.query(`select id from reference_images where image = $1`, [img("B")])).rows[0].id;
  await rejects(rpc(db, m2, "set_primary_image", [idB]), /catalogue/);
  await db.query(`update profiles set can_catalog = true where id = $1`, [m2]);
  await rpc(db, m2, "set_primary_image", [idB]);
  assert.equal(await primary(res), img("B"));
});

test("Fusion : les images suivent, sans doublon", async () => {
  const dup = await rpc(db, admin, "create_resource", [JSON.stringify({ name: "Glacosite bis" }), "manuel", ""]);
  await rpc(db, m1, "add_reference_image", [dup, img("B"), "ascenseur_fret", "capture", ""]);   // même image que la cible
  await rpc(db, m1, "add_reference_image", [dup, img("D"), "inventaire", "capture", ""]);
  await rpc(db, admin, "merge_resources", [dup, res]);
  assert.equal(await count(res), 2, "B déjà présente, D ajoutée");
});

test("Reprise des images existantes à la migration (relançable)", async () => {
  const d = await freshDb({ upTo: "007" });
  const a = await addUser(d, "Admin", "admin");
  const r = await rpc(d, a, "create_resource", [JSON.stringify({ name: "Aphorite" }), "manuel", ""]);
  await rpc(d, a, "add_resource_ref", [r, img("M")]);   // image principale
  await rpc(d, a, "add_resource_ref", [r, img("N")]);   // vue supplémentaire
  await runRemaining(d, "007");
  await runRemaining(d, "007");
  const rows = (await d.query(`select image, source, terminal_type from reference_images where resource_id = $1 order by image`, [r])).rows;
  assert.deepEqual(rows.map(x => [x.image, x.source, x.terminal_type]), [[img("M"), "reprise", "inconnu"], [img("N"), "reprise", "inconnu"]]);
  assert.equal((await d.query(`select image from resources where id = $1`, [r])).rows[0].image, img("M"), "image principale conservée");
});
