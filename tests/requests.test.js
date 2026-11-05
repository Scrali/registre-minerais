// Tests des demandes des membres (migration 009).
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { freshDb, addUser, rpc, as } from "./harness.js";

const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
const J = o => JSON.stringify(o);
let db, admin, a, b, autre, pending, res;
const row = async id => (await db.query(`select * from requests where id = $1`, [id])).rows[0];
const ask = (who, extra = {}) => rpc(db, who, "create_request", [J({ resource_id: res, quantity: 200, unit: "SCU", min_quality: 700, location: "Levski", ...extra })]);

before(async () => {
  db = await freshDb();
  admin = await addUser(db, "Chef", "admin", { org: "S.A.R.D" });
  a = await addUser(db, "Matsu89", "member", { org: "S.A.R.D" });
  b = await addUser(db, "Mineur", "member", { org: "S.A.R.D" });
  autre = await addUser(db, "Etranger", "member", { org: "Autre Corp" });
  pending = await addUser(db, "Nouveau", "pending");
  res = await rpc(db, admin, "create_resource", [J({ name: "Quantanium" }), "manuel", ""]);
});

test("Création : l'organisation et l'auteur viennent du compte connecté, jamais du JSON envoyé", async () => {
  const id = await ask(a, { requester_id: b, org_id: "00000000-0000-0000-0000-000000000000", status: "done" });
  const r = await row(id);
  assert.equal(r.requester_id, a);
  assert.equal(r.status, "open");
  assert.equal(r.resource_name, "Quantanium");
  assert.equal(r.min_quality, 700);
  const sard = (await db.query(`select org_id from profiles where id = $1`, [a])).rows[0].org_id;
  assert.equal(r.org_id, sard);
});

test("Ressource hors catalogue acceptée par son nom ; champs invalides refusés", async () => {
  const id = await rpc(db, a, "create_request", [J({ resource_name: "  Pierre de Hadanite ", quantity: 5 })]);
  assert.equal((await row(id)).resource_name, "Pierre de Hadanite");
  await rejects(rpc(db, a, "create_request", [J({ quantity: 5 })]), /ressource/);
  await rejects(rpc(db, a, "create_request", [J({ resource_id: res, quantity: 0 })]), /quantité/);
  await rejects(rpc(db, a, "create_request", [J({ resource_id: res, quantity: 1, min_quality: 1200 })]), /0 à 1000/);
  await rejects(rpc(db, pending, "create_request", [J({ resource_id: res, quantity: 1 })]), /non validé/);
});

test("Une autre organisation ne voit pas les demandes ; écriture directe impossible", async () => {
  const id = await ask(a);
  const seenBy = async u => (await as(db, u, `select id from requests`)).rows.map(r => r.id);
  assert.ok((await seenBy(b)).includes(id));
  assert.deepEqual(await seenBy(autre), []);
  assert.deepEqual(await seenBy(pending), []);
  await rejects(rpc(db, autre, "set_request_status", [id, "in_progress"]), /introuvable/);
  await rejects(as(db, a, `insert into requests (org_id, requester_id, resource_name, quantity) select org_id, id, 'x', 1 from profiles where id = $1`, [a]), /row-level security/);
  const up = await as(db, a, `update requests set status = 'done' where id = $1`, [id]);
  assert.equal(up.affectedRows, 0);
  await rejects(as(db, a, `select public._request_fields('{}'::jsonb)`), /permission denied/);
});

test("Cycle : un membre la prend, la rend, la reprend, puis la livre", async () => {
  const id = await ask(a);
  await rpc(db, b, "set_request_status", [id, "in_progress"]);
  assert.deepEqual([(await row(id)).status, (await row(id)).taken_by], ["in_progress", b]);
  await rejects(rpc(db, admin, "set_request_status", [id, "in_progress"]), /plus ouverte/);
  await rpc(db, b, "set_request_status", [id, "open"]);
  assert.equal((await row(id)).taken_by, null);
  await rpc(db, b, "set_request_status", [id, "in_progress"]);
  await rpc(db, b, "set_request_status", [id, "done"]);
  const r = await row(id);
  assert.equal(r.status, "done");
  assert.ok(r.closed_at);
  await rejects(rpc(db, b, "set_request_status", [id, "cancelled"]), /close/);
});

test("Droits : seul l'auteur (ou un admin) annule, modifie ou rouvre", async () => {
  const id = await ask(a);
  await rejects(rpc(db, b, "set_request_status", [id, "cancelled"]), /auteur/);
  await rejects(rpc(db, b, "set_request_status", [id, "done"]), /auteur/);
  await rejects(rpc(db, b, "update_request", [id, J({ resource_id: res, quantity: 1 })]), /auteur/);
  await rpc(db, a, "update_request", [id, J({ resource_id: res, quantity: 50, priority: "urgent", note: "pour la raffinerie" })]);
  const r = await row(id);
  assert.deepEqual([Number(r.quantity), r.priority, r.note, r.min_quality], [50, "urgent", "pour la raffinerie", null]);
  await rpc(db, admin, "set_request_status", [id, "cancelled"]);
  await rejects(rpc(db, b, "set_request_status", [id, "open"]), /auteur/);
  await rpc(db, a, "set_request_status", [id, "open"]);
  assert.equal((await row(id)).status, "open");
  await rejects(rpc(db, admin, "update_request", [id, J({ resource_id: res, quantity: 1 })]), /auteur/);
});

test("La demande reste lisible si la ressource est supprimée du catalogue", async () => {
  const tmp = await rpc(db, admin, "create_resource", [J({ name: "Minerai éphémère" }), "manuel", ""]);
  const id = await ask(a, { resource_id: tmp });
  await rpc(db, admin, "delete_resource", [tmp]);
  const r = await row(id);
  assert.deepEqual([r.resource_id, r.resource_name], [null, "Minerai éphémère"]);
});
