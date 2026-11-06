// Tests des mouvements sécurisés (migration 014) : idempotence, retraits exacts, transferts atomiques,
// annulations compensatoires, cohérence avec les captures et réconciliation. Lancer : npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, addUser, rpc, as } from "./harness.js";

let db, admin, alice, bob, eve, other, quanta, agri;
const J = o => JSON.stringify(o);
const op = () => randomUUID();
const adjust = (u, p) => rpc(db, u, "adjust_stock", [J(p)]);
const transfer = (u, p) => rpc(db, u, "transfer_stock", [J(p)]);
const reverse = (u, p) => rpc(db, u, "reverse_movement", [J(p)]);
const scan = (u, location, items, extra = {}) =>
  rpc(db, u, "apply_scan", [J({ idempotency_key: randomUUID(), location, terminal_type: "inventaire", coverage: "partial", items, ...extra }), false]);
const previewScan = (u, location, items, extra = {}) =>
  rpc(db, u, "apply_scan", [J({ location, coverage: "partial", items, ...extra }), true]);
const line = (resource_id, quality_key, quantity, unit = "") => ({ resource_id, quality_key, quantity, unit });
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
async function stock(u, place, res, q, unit = "") {
  const r = await db.query(`select s.quantity::float q from user_stocks s join locations l on l.id = s.location_id
    where s.user_id = $1 and l.slug = place_slug($2) and s.resource_id = $3 and s.quality_key = $4 and s.unit = $5`, [u, place, res, q, unit]);
  return r.rows.length ? r.rows[0].q : 0;
}
const total = async res => (await db.query(`select coalesce(sum(quantity), 0)::float t from user_stocks where resource_id = $1`, [res])).rows[0].t;
const nMoves = async () => (await db.query(`select count(*)::int n from movements`)).rows[0].n;
const wd = (o = {}) => ({ operation_id: op(), location: "Lorville", resource_id: quanta, quality_key: "500", unit: "SCU", mode: "remove", quantity: 7, kind: "sale", ...o });

before(async () => {
  db = await freshDb();
  admin = await addUser(db, "Admin", "admin");
  alice = await addUser(db, "Alice");
  bob = await addUser(db, "Bob");
  eve = await addUser(db, "Eve", "member", { org: "Autre org" });
  other = await addUser(db, "AdminAutre", "admin", { org: "Autre org" });
  quanta = await rpc(db, admin, "create_resource", [J({ name: "Quantainium" }), "manuel", ""]);
  agri = await rpc(db, admin, "create_resource", [J({ name: "Agricium" }), "manuel", ""]);
  await adjust(alice, { operation_id: op(), location: "Lorville", resource_id: quanta, quality_key: "500", unit: "SCU", mode: "add", quantity: 25, kind: "production" });
});

test("Retrait de 7 sur 25 = 18 ; la répétition technique ne change rien ; un nouveau retrait volontaire reste possible", async () => {
  const p = wd();
  const r1 = await adjust(alice, p);
  assert.equal(r1.before, 25); assert.equal(r1.after, 18); assert.equal(r1.replayed, false);
  const n = await nMoves();
  const r2 = await adjust(alice, p);                       // même requête renvoyée (réseau)
  assert.equal(r2.replayed, true); assert.equal(r2.after, 18);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 18, "jamais 11");
  assert.equal(await nMoves(), n, "aucun mouvement en plus");
  await adjust(alice, wd());                               // nouveau retrait, nouvel identifiant
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 11);
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", quantity: 14 });   // retour à 25 pour la suite
});

test("Double clic : deux envois simultanés de la même opération = un seul retrait", async () => {
  const p = wd({ quantity: 5 });
  const rs = await Promise.all([adjust(alice, p), adjust(alice, p)]);
  assert.deepEqual(rs.map(r => r.replayed).sort(), [false, true]);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 20);
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", quantity: 5 });
});

test("Identifiant obligatoire, et jamais réutilisé pour une autre opération", async () => {
  await rejects(adjust(alice, { ...wd(), operation_id: undefined }), /Identifiant d'opération manquant/);
  await rejects(adjust(alice, { ...wd(), operation_id: "pas-un-uuid" }), /Identifiant d'opération invalide/);
  const p = wd({ quantity: 1 });
  await adjust(alice, p);
  await rejects(adjust(alice, { ...p, quantity: 2 }), /déjà servi/);
  await rejects(adjust(bob, { ...p, owner_id: alice }), /propre inventaire/);
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", quantity: 1 });
});

test("Quantités : nulle, négative, trop de décimales ou supérieure au stock = refus, sans rien écrire", async () => {
  const n = await nMoves();
  await rejects(adjust(alice, wd({ quantity: 0 })), /supérieure à zéro/);
  await rejects(adjust(alice, wd({ quantity: -3 })), /supérieure à zéro/);
  await rejects(adjust(alice, wd({ quantity: 1.0004 })), /trois décimales/);
  await rejects(adjust(alice, wd({ quantity: 26 })), /Stock insuffisant : 25/);
  assert.equal(await nMoves(), n);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 25);
});

test("Mauvaise qualité : jamais prélevée sur une autre qualité", async () => {
  await rejects(adjust(alice, wd({ quality_key: "300" })), /Aucun stock de Quantainium \(Q300, SCU\)/);
  await rejects(adjust(alice, wd({ quality_key: "" })), /qualité inconnue/);
  await rejects(adjust(alice, wd({ unit: "cSCU" })), /Aucun stock/);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 25);
});

test("Unités : « scu » = « SCU », mais SCU, cSCU et objets restent des stocks distincts", async () => {
  await adjust(alice, { ...wd(), unit: "scu", quantity: 2 });
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 23);
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", unit: "cscu", quantity: 150 });
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", unit: "x", quantity: 3 });
  assert.equal(await stock(alice, "Lorville", quanta, "500", "cSCU"), 150);
  assert.equal(await stock(alice, "Lorville", quanta, "500", ""), 3);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 23, "jamais converti ni additionné");
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", quantity: 2 });
});

test("Aperçu avant confirmation : avant / retrait / après, sans rien écrire ; quantité changée entre-temps = refus", async () => {
  const n = await nMoves();
  const pv = await adjust(alice, { ...wd(), operation_id: undefined, dry_run: true });
  assert.deepEqual([pv.before, pv.delta, pv.after, pv.dry_run], [25, -7, 18, true]);
  assert.equal(await nMoves(), n);
  await rejects(adjust(alice, wd({ expected_before: 24 })), /STATE_CHANGED/);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 25);
});

test("Retrait puis capture complète à 18 : variation 0 ; capture prise AVANT le retrait = vérification demandée", async () => {
  const shotBefore = new Date(Date.now() - 60_000).toISOString();
  await adjust(alice, wd());
  const r = await scan(alice, "Lorville", [line(quanta, 500, 18, "SCU")]);
  assert.equal(r.changes.length, 0); assert.equal(r.unchanged, 1);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 18);
  await rejects(scan(alice, "Lorville", [line(quanta, 500, 25, "SCU")], { observed_at: shotBefore }), /STALE/);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 18, "l'ancienne capture n'a pas réécrit 25");
});

test("Baisse constatée par capture puis retrait manuel de la même quantité : alerte de doublon potentiel", async () => {
  await scan(alice, "Lorville", [line(quanta, 500, 11, "SCU")]);            // -7 « à classer »
  const pv = await adjust(alice, { ...wd(), operation_id: undefined, dry_run: true });
  assert.ok(pv.similar.some(m => m.unclassified && m.scan && m.delta === -7), "la baisse déjà constatée est signalée");
  const m = (await db.query(`select id from movements where owner_id = $1 and kind = 'decrease' order by id desc limit 1`, [alice])).rows[0];
  await rpc(db, alice, "classify_movement", [m.id, "sale"]);              // classer au lieu de redéclarer
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 11);
  await adjust(alice, { ...wd(), mode: "add", kind: "deposit", quantity: 14 });
});

test("Transfert vers une autre ville : débit, crédit, même identifiant, stock global inchangé", async () => {
  const before = await total(quanta);
  const p = { operation_id: op(), from_location: "Lorville", to_location: "Area18", resource_id: quanta, quality_key: "500", unit: "SCU", quantity: 5 };
  const pv = await transfer(alice, { ...p, operation_id: undefined, dry_run: true });
  assert.deepEqual([pv.from.before, pv.from.after, pv.to.before, pv.to.after], [25, 20, 0, 5]);
  const r = await transfer(alice, p);
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), 20);
  assert.equal(await stock(alice, "Area18", quanta, "500", "SCU"), 5);
  assert.equal(await total(quanta), before, "aucun minerai créé ni perdu");
  const legs = (await db.query(`select kind, delta::float d, quality_key, unit from movements where transfer_id = $1 order by id`, [r.transfer_id])).rows;
  assert.deepEqual(legs.map(l => [l.kind, l.d, l.quality_key, l.unit]), [["transfer_out", -5, "500", "SCU"], ["transfer_in", 5, "500", "SCU"]]);
  const again = await transfer(alice, p);
  assert.equal(again.replayed, true);
  assert.equal(await stock(alice, "Area18", quanta, "500", "SCU"), 5, "rejeu sans effet");
  await rejects(transfer(alice, { ...p, operation_id: op(), quantity: 21 }), /Stock insuffisant/);
  await rejects(transfer(alice, { ...p, operation_id: op(), to_location: "lorville" }), /identiques/);
  await rejects(transfer(alice, { ...p, operation_id: op(), quality_key: "300" }), /Aucun stock/);
});

test("Transfert entre membres : même organisation seulement, et jamais depuis le stock d'un autre sans droit", async () => {
  const p = { operation_id: op(), from_location: "Area18", to_location: "Area18", to_owner: bob, resource_id: quanta, quality_key: "500", unit: "SCU", quantity: 2 };
  await transfer(alice, p);
  assert.equal(await stock(bob, "Area18", quanta, "500", "SCU"), 2);
  await rejects(transfer(alice, { ...p, operation_id: op(), to_owner: eve }), /même organisation/);
  await rejects(transfer(bob, { ...p, operation_id: op(), from_owner: alice, to_owner: bob }), /propre inventaire/);
  await rejects(transfer(other, { ...p, operation_id: op(), from_owner: alice, to_owner: other }), /ton organisation/);
  await rejects(adjust(eve, wd({ owner_id: alice })), /propre inventaire/);
});

test("Transfert interrompu en cours d'opération : rien n'est débité", async () => {
  await db.exec(`create function pg_temp.boom() returns trigger language plpgsql as $$ begin
      if new.kind = 'transfer_in' then raise exception 'panne simulée'; end if; return new; end $$;
    create trigger boom before insert on public.movements for each row execute function pg_temp.boom();`);
  const n = await nMoves(), before = await stock(alice, "Lorville", quanta, "500", "SCU");
  try {
    await rejects(transfer(alice, { operation_id: op(), from_location: "Lorville", to_location: "Orison", resource_id: quanta, quality_key: "500", unit: "SCU", quantity: 4 }), /panne simulée/);
  } finally { await db.exec(`drop trigger boom on public.movements`); }
  assert.equal(await stock(alice, "Lorville", quanta, "500", "SCU"), before);
  assert.equal(await stock(alice, "Orison", quanta, "500", "SCU"), 0);
  assert.equal(await nMoves(), n);
});

test("Deux retraits concurrents : jamais de stock négatif ni de double écriture", async () => {
  await adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "700", unit: "SCU", mode: "add", quantity: 25, kind: "production" });
  const w = () => adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "700", unit: "SCU", mode: "remove", quantity: 15, kind: "sale" });
  const rs = await Promise.allSettled([w(), w()]);
  assert.equal(rs.filter(r => r.status === "fulfilled").length, 1);
  assert.match(rs.find(r => r.status === "rejected").reason.message, /Stock insuffisant/);
  assert.equal(await stock(alice, "Levski", agri, "700", "SCU"), 10);
});

test("Annulation d'un mouvement ancien : mouvement compensatoire, l'original reste, les plus récents sont conservés", async () => {
  const dep = await adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "700", unit: "SCU", mode: "add", quantity: 10, kind: "production" });
  await adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "700", unit: "SCU", mode: "remove", quantity: 3, kind: "sale" });
  assert.equal(await stock(alice, "Levski", agri, "700", "SCU"), 17);
  await rejects(reverse(alice, { operation_id: op(), movement_id: dep.movement_id }), /motif/);
  const p = { operation_id: op(), movement_id: dep.movement_id, note: "Saisie en double" };
  const r = await reverse(alice, p);
  assert.equal(await stock(alice, "Levski", agri, "700", "SCU"), 7, "17 - 10 : la vente plus récente est conservée");
  assert.equal((await reverse(alice, p)).replayed, true);
  assert.equal(await stock(alice, "Levski", agri, "700", "SCU"), 7);
  await rejects(reverse(alice, { ...p, operation_id: op() }), /déjà été annulé/);
  await rejects(reverse(alice, { operation_id: op(), movement_id: r.reversals[0].movement_id, note: "x" }), /ne s'annule pas/);
  const orig = (await db.query(`select undone_at is not null as u, reversed_by_id, delta::float d from movements where id = $1`, [dep.movement_id])).rows[0];
  assert.deepEqual([orig.u, orig.d, orig.reversed_by_id], [true, 10, r.reversals[0].movement_id]);
  const prod = (await db.query(`select sum(delta)::float s from movements where owner_id = $1 and resource_id = $2 and kind = 'production' and location_id = (select id from locations where slug = 'levski')`, [alice, agri])).rows[0].s;
  assert.equal(prod, 25, "la production annulée sort des statistiques (25 + 10 - 10)");
  await rejects(rpc(db, alice, "classify_movement", [r.reversals[0].movement_id, "deposit"]), /annulation ou à un transfert/);
});

test("Annulation impossible si le stock a déjà été utilisé ; relevé par capture : correction plutôt qu'annulation", async () => {
  const dep = await adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "800", unit: "SCU", mode: "add", quantity: 4, kind: "purchase" });
  await adjust(alice, { operation_id: op(), location: "Levski", resource_id: agri, quality_key: "800", unit: "SCU", mode: "remove", quantity: 3, kind: "consumption" });
  await rejects(reverse(alice, { operation_id: op(), movement_id: dep.movement_id, note: "x" }), /il ne reste que 1/);
  const s = await scan(alice, "Orison", [line(agri, 900, 9, "SCU")]);
  const mid = (await db.query(`select id from movements where scan_id = $1`, [s.scan_id])).rows[0].id;
  await rejects(reverse(alice, { operation_id: op(), movement_id: mid, note: "x" }), /corrige plutôt/);
  await rejects(reverse(bob, { operation_id: op(), movement_id: dep.movement_id, note: "x" }), /propre inventaire/);
});

test("Annulation d'un transfert : les deux mouvements sont compensés ensemble", async () => {
  const t = await transfer(alice, { operation_id: op(), from_location: "Lorville", to_location: "Orison", resource_id: quanta, quality_key: "500", unit: "SCU", quantity: 3 });
  const before = await total(quanta);
  const leg = (await db.query(`select id from movements where transfer_id = $1 and kind = 'transfer_in'`, [t.transfer_id])).rows[0].id;
  const r = await reverse(alice, { operation_id: op(), movement_id: leg, note: "Mauvaise destination" });
  assert.equal(r.reversals.length, 2);
  assert.equal(await stock(alice, "Orison", quanta, "500", "SCU"), 0);
  assert.equal(await total(quanta), before);
});

test("Captures : même clé avec un autre contenu refusée ; même capture ajoutée deux fois = confirmation explicite", async () => {
  const k = randomUUID();
  await scan(bob, "Levski", [line(agri, 400, 6, "SCU")], { idempotency_key: k, mode: "add", fingerprints: ["fp-1"] });
  await rejects(scan(bob, "Levski", [line(agri, 400, 9, "SCU")], { idempotency_key: k, mode: "add" }), /déjà utilisée/);
  const same = await scan(bob, "Levski", [line(agri, 400, 6, "SCU")], { idempotency_key: k, mode: "add", fingerprints: ["fp-1"] });
  assert.equal(same.replayed, true);
  assert.equal(await stock(bob, "Levski", agri, "400", "SCU"), 6);
  const pv = await previewScan(bob, "Levski", [line(agri, 400, 6, "SCU")], { mode: "add", fingerprints: ["fp-1"] });
  assert.equal(pv.duplicate_images, true);
  assert.equal(pv.similar.length, 1, "le même lot ajouté récemment est signalé");
  await rejects(scan(bob, "Levski", [line(agri, 400, 6, "SCU")], { mode: "add", fingerprints: ["fp-1"] }), /DUPLICATE/);
  assert.equal(await stock(bob, "Levski", agri, "400", "SCU"), 6);
  await scan(bob, "Levski", [line(agri, 400, 6, "SCU")], { mode: "add", fingerprints: ["fp-1"], allow_duplicate: true });
  assert.equal(await stock(bob, "Levski", agri, "400", "SCU"), 12, "un vrai nouveau lot reste possible");
  await scan(bob, "Levski", [line(agri, 400, 1, "SCU")], { mode: "add", fingerprints: ["fp-2"] });
  assert.equal(await stock(bob, "Levski", agri, "400", "SCU"), 13, "lot distinct : aucun blocage");
});

test("Captures identiques en mode Mettre à jour : aucun doublon ; unités lues normalisées", async () => {
  await scan(bob, "Orison", [line(quanta, 610, 30, "scu")]);
  const r = await scan(bob, "Orison", [line(quanta, 610, 30, "SCU")]);
  assert.equal(r.changes.length, 0);
  assert.equal(await stock(bob, "Orison", quanta, "610", "SCU"), 30);
});

test("Ajout manuel puis mise à jour par capture : l'ajout n'est pas compté deux fois", async () => {
  await scan(bob, "Lorville", [line(quanta, 300, 10, "SCU")]);
  await rpc(db, bob, "adjust_stock", [J({ operation_id: op(), location: "Lorville", resource_id: quanta, quality_key: "300", unit: "SCU", mode: "add", quantity: 5, kind: "deposit" })]);
  const r = await scan(bob, "Lorville", [line(quanta, 300, 15, "SCU")]);
  assert.equal(r.changes.length, 0);
  assert.equal(await stock(bob, "Lorville", quanta, "300", "SCU"), 15);
});

test("Statistiques : un retrait est une sortie, jamais une production négative", async () => {
  const rows = (await db.query(`select kind, sign(delta)::int s from movements where owner_id is not null and kind in ('sale', 'consumption', 'delivery', 'withdrawal') group by 1, 2`)).rows;
  assert.ok(rows.length > 0 && rows.every(r => r.s === -1));
  const neg = (await db.query(`select count(*)::int n from movements where kind = 'production' and delta < 0 and reverses_id is null`)).rows[0].n;
  assert.equal(neg, 0);
  await adjust(alice, wd({ quantity: 1, kind: "delivery" }));
});

test("Réconciliation : chaque stock = somme de ses mouvements ; l'inventaire global = somme des inventaires personnels", async () => {
  const r = await rpc(db, admin, "stock_reconciliation", []);
  assert.deepEqual(r.mismatches, []);
  const g = (await db.query(`select (select sum(quantity) from user_stocks)::float a,
    (select sum(t) from (select user_id, sum(quantity) t from user_stocks group by 1) x)::float b`)).rows[0];
  assert.equal(g.a, g.b);
  await db.query(`update user_stocks set quantity = quantity + 1 where id = (select min(id) from user_stocks where user_id = $1)`, [alice]);
  const r2 = await rpc(db, admin, "stock_reconciliation", []);
  assert.equal(r2.mismatches.length, 1);
  assert.equal(r2.mismatches[0].gap, 1);
  await db.query(`update user_stocks set quantity = quantity - 1 where id = (select min(id) from user_stocks where user_id = $1)`, [alice]);
  const r3 = await rpc(db, other, "stock_reconciliation", []);
  assert.deepEqual(r3.mismatches, [], "une autre organisation ne voit pas ces stocks");
  await rejects(rpc(db, alice, "stock_reconciliation", []), /administrateurs/);
});

test("Aucune écriture directe : stock_operations et movements restent protégés", async () => {
  await rejects(as(db, alice, `insert into stock_operations (id, kind, request_hash, result) values ($1, 'adjust', 'x', '{}')`, [op()]), /row-level security/);
  const seen = await as(db, alice, `select count(*)::int n from stock_operations`);
  assert.equal(seen.rows[0].n, 0);
  await rejects(as(db, alice, `select public._op_save('{}'::jsonb, 'adjust', 'x', '{}'::jsonb)`), /permission denied/);
});
