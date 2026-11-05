// Tests des organisations (registres séparés) et des droits par membre (migration 008).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, runRemaining, addUser, rpc, as } from "./harness.js";

const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
const J = o => JSON.stringify(o);
let db, owner, sardAdmin, sard1, sard2, autre1, res, sard, autre;

const scan = (who, loc, qty, extra = {}) => rpc(db, who, "apply_scan", [J({
  idempotency_key: "k" + Math.random(), location: loc, coverage: "partial",
  items: [{ resource_id: res, quality_key: "600", quantity: qty, unit: "" }], ...extra }), false]);
const seen = async (who, sql) => (await as(db, who, sql)).rows;

before(async () => {
  db = await freshDb();
  owner = await addUser(db, "Proprio", "admin", { org: "S.A.R.D" });
  sardAdmin = await addUser(db, "ChefSard", "admin", { org: "S.A.R.D" });
  sard1 = await addUser(db, "Matsu89", "member", { org: "S.A.R.D" });
  sard2 = await addUser(db, "Curieux", "member", { org: "S.A.R.D", perms: { can_view_global: false, can_scan: false } });
  autre1 = await addUser(db, "Etranger", "member", { org: "Autre Corp" });
  sard = (await db.query(`select id from organizations where name = 'S.A.R.D'`)).rows[0].id;
  autre = (await db.query(`select id from organizations where name = 'Autre Corp'`)).rows[0].id;
  res = await rpc(db, owner, "create_resource", [J({ name: "Aphorite" }), "manuel", ""]);
  await scan(sard1, "Levski", 10);
  await scan(sard2, "Levski", 4);
  await scan(autre1, "Lorville", 99);
});

test("Le premier compte est propriétaire du site ; les suivants attendent sans organisation", async () => {
  const d = await freshDb();
  const ids = [];
  for (const p of ["Premier", "Second"]) {
    const id = crypto.randomUUID(); ids.push(id);
    await d.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [id, p + "@t.local", J({ pseudo: p })]);
  }
  const rows = (await d.query(`select role, is_owner, org_id from profiles where id = any($1) order by created_at, pseudo desc`, [ids])).rows;
  assert.deepEqual(rows.map(r => [r.role, r.is_owner, r.org_id]), [["admin", true, null], ["pending", false, null]]);
});

test("Registres séparés : une organisation ne voit ni les stocks, ni les mouvements, ni les membres d'une autre", async () => {
  const s = await seen(sard1, `select u.user_id from user_stocks u`);
  assert.ok(s.length >= 2 && s.every(r => r.user_id !== autre1), "S.A.R.D ne voit pas Autre Corp");
  assert.deepEqual((await seen(autre1, `select user_id from user_stocks`)).map(r => r.user_id), [autre1]);
  assert.ok((await seen(sard1, `select owner_id from movements where owner_id is not null`)).every(r => r.owner_id !== autre1));
  assert.equal((await seen(sard1, `select count(*)::int n from inventory_scans where user_id = '${autre1}'`))[0].n, 0);
  assert.equal((await seen(sard1, `select count(*)::int n from scan_items`))[0].n, 2);
  assert.deepEqual((await seen(autre1, `select pseudo from profiles order by pseudo`)).map(r => r.pseudo), ["Etranger"]);
  // Le catalogue et les lieux du jeu restent communs.
  assert.equal((await seen(autre1, `select count(*)::int n from resources`))[0].n, 1);
});

test("Droit « voir l'inventaire global » retiré : seulement son propre stock", async () => {
  assert.deepEqual((await seen(sard2, `select distinct user_id from user_stocks`)).map(r => r.user_id), [sard2]);
});

test("Modifier l'inventaire d'un autre : droit requis, et jamais hors de son organisation", async () => {
  const p = owner => J({ owner_id: owner, location: "Levski", resource_id: res, quality_key: "600", unit: "", mode: "add", quantity: 1, kind: "deposit", note: "test" });
  await rejects(rpc(db, sard2, "adjust_stock", [p(sard1)]), /propre inventaire/);
  await db.query(`update profiles set can_edit_others = true where id = $1`, [sard2]);
  await rpc(db, sard2, "adjust_stock", [p(sard1)]);
  await rejects(rpc(db, sard2, "adjust_stock", [p(autre1)]), /ton organisation/);
  await rejects(rpc(db, sardAdmin, "adjust_stock", [p(autre1)]), /ton organisation/);
  await db.query(`update profiles set can_edit_others = false where id = $1`, [sard2]);
});

test("Droit « catalogue » : modifier ou supprimer une ressource", async () => {
  await rejects(rpc(db, sard1, "apply_lots", [res, "add", "{}", "manuel", "", J({ category: "Minerai" }), ""]), /catalogue/);
  await rejects(rpc(db, sard1, "delete_resource", [res]), /catalogue/);
  await rpc(db, sardAdmin, "apply_lots", [res, "add", "{}", "manuel", "", J({ category: "Minerai" }), ""]);
  // Une capture peut toujours créer une ressource inconnue (sinon impossible d'enregistrer).
  await rpc(db, sard1, "create_resource", [J({ name: "Nouveau minerai" }), "capture", ""]);
});

test("Fusion et réinitialisation : propriétaire du site seulement (elles touchent toutes les organisations)", async () => {
  const dup = await rpc(db, owner, "create_resource", [J({ name: "Aphorite bis" }), "manuel", ""]);
  await rejects(rpc(db, sardAdmin, "merge_resources", [dup, res]), /propriétaire/);
  await rejects(rpc(db, sardAdmin, "reset_registre", ["REINITIALISER"]), /propriétaire/);
  await rpc(db, owner, "merge_resources", [dup, res]);
});

test("Personne ne s'accorde de droits en écrivant directement dans son profil", async () => {
  await rejects(as(db, sard1, `update profiles set role = 'admin' where id = $1`, [sard1]), /administrateur/);
  await rejects(as(db, sard1, `update profiles set can_catalog = true where id = $1`, [sard1]), /administrateur/);
  await rejects(as(db, sard1, `update profiles set org_id = $2 where id = $1`, [sard1, autre]), /administrateur/);
  const other = await as(db, sardAdmin, `update profiles set pseudo = 'Pirate' where id = $1`, [sard1]);
  assert.equal(other.affectedRows, 0, "on ne modifie que son propre pseudo");
  await as(db, sard1, `update profiles set pseudo = 'Matsu' where id = $1`, [sard1]);
  await rejects(as(db, sard1, `select public._impl_reset_registre('REINITIALISER')`), /permission denied/);
});

test("Administrateur d'organisation : gère ses membres, pas ceux des autres", async () => {
  await rejects(rpc(db, sard1, "set_member", [sard2, J({ can_catalog: true })]), /administrateurs/);
  await rpc(db, sardAdmin, "set_member", [sard2, J({ can_catalog: true, can_view_global: true })]);
  assert.deepEqual((await db.query(`select can_catalog, can_view_global from profiles where id = $1`, [sard2])).rows[0], { can_catalog: true, can_view_global: true });
  await rejects(rpc(db, sardAdmin, "set_member", [autre1, J({ role: "pending" })]), /pas dans ton organisation/);
  await rejects(rpc(db, sardAdmin, "set_member", [sard2, J({ org_id: autre })]), /autre organisation/);
  await rejects(rpc(db, sardAdmin, "set_member", [owner, J({ can_scan: false })]), /propriétaire/);
  await rejects(rpc(db, sardAdmin, "set_member", [sardAdmin, J({ role: "member" })]), /propre rôle/);
  await rejects(rpc(db, sardAdmin, "set_member", [sard1, J({ is_owner: true })]), /propriétaire/);
});

test("Nouveau compte : choisit son organisation, puis un de ses administrateurs le valide", async () => {
  const nv = await addUser(db, "Nouveau", "pending");
  assert.equal((await seen(nv, `select count(*)::int n from user_stocks`))[0].n, 0);
  assert.equal((await seen(nv, `select count(*)::int n from organizations`))[0].n, 2, "il voit la liste pour choisir");
  await rpc(db, nv, "request_organization", [sard]);
  assert.ok((await seen(sardAdmin, `select id from profiles`)).some(r => r.id === nv), "l'admin S.A.R.D voit la demande");
  assert.ok(!(await seen(autre1, `select id from profiles`)).some(r => r.id === nv), "Autre Corp ne la voit pas");
  await rpc(db, sardAdmin, "set_member", [nv, J({ role: "member" })]);
  assert.equal((await seen(nv, `select count(*)::int n from user_stocks`))[0].n > 0, true, "validé : il voit l'inventaire de S.A.R.D");
  await rejects(rpc(db, sard1, "request_organization", [autre]), /en attente/);
});

test("Propriétaire : crée une organisation et y déplace un membre", async () => {
  await rejects(rpc(db, sardAdmin, "create_organization", ["Pirates"]), /propriétaire/);
  const o = await rpc(db, owner, "create_organization", ["Nouvelle Org"]);
  await rejects(rpc(db, owner, "create_organization", ["nouvelle org"]), /existe déjà/);
  await rpc(db, owner, "set_member", [autre1, J({ org_id: o })]);
  await rejects(rpc(db, owner, "delete_organization", [o]), /encore des membres/);
  assert.equal((await seen(autre1, `select count(*)::int n from user_stocks where user_id <> '${autre1}'`))[0].n, 0);
});

test("Analyse IA : refusée sans le droit « captures »", async () => {
  await db.query(`update profiles set can_scan = false where id = $1`, [sard1]);
  assert.equal(await rpc(db, sard1, "has_perm", ["scan"]), false);
  assert.equal(await rpc(db, sardAdmin, "has_perm", ["scan"]), true, "un administrateur a tous les droits");
});

test("Migration 008 sur une base existante : tout le monde dans S.A.R.D, l'admin devient propriétaire (relançable)", async () => {
  const d = await freshDb({ upTo: "008" });
  const a = await addUser(d, "Admin", "admin");
  const m = await addUser(d, "Membre");
  const p = await addUser(d, "Attente", "pending");
  await runRemaining(d, "008");
  await runRemaining(d, "008");
  const rows = (await d.query(`select p.id, p.is_owner, o.name from profiles p left join organizations o on o.id = p.org_id`)).rows;
  const by = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.deepEqual([by[a].is_owner, by[a].name], [true, "S.A.R.D"]);
  assert.deepEqual([by[m].is_owner, by[m].name], [false, "S.A.R.D"]);
  assert.equal(by[p].name, null);
  assert.equal((await d.query(`select count(*)::int n from organizations`)).rows[0].n, 1);
  assert.equal((await d.query(`select count(*)::int n from archive.profiles_avant_008`)).rows[0].n, 3);
});
