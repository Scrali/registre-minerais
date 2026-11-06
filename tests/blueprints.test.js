// Tests de l'intégration Star Citizen Wiki (migration 015 + fonction sync-blueprints) avec de vraies réponses de l'API
// (tests/fixtures/blueprints-api.json) servies par un faux serveur. Aucun appel réseau. Lancer : npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { freshDb, addUser, rpc, as } from "./harness.js";
import { runSync, makeClient } from "../supabase/functions/sync-blueprints/index.ts";

const FX = JSON.parse(readFileSync(new URL("./fixtures/blueprints-api.json", import.meta.url), "utf8"));
const clone = o => JSON.parse(JSON.stringify(o));
const J = o => JSON.stringify(o);
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });
const OMNI = "280f47b7-8434-410c-b854-380768fdccec", QUIK = "31b2edb4-1b3d-4073-81a4-c0d1572a9a42",
      META = "c9c67e69-063a-4d28-a156-d5809776ee22", KILL = "e3097998-28ef-48ad-a220-2ddaa1a85ce3";

let db, admin, alice, bob, eve, otherAdmin, res = {};

// Rôle service_role (fonction Edge), dans une transaction comme PostgREST.
const svc = (fn, args) => db.transaction(async tx => {
  await tx.query(`set local role service_role`);
  const keys = Object.keys(args);
  const r = await tx.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`,
    keys.map(k => (args[k] !== null && typeof args[k] === "object") ? J(args[k]) : args[k]));
  return r.rows[0].r;
});

// Faux serveur de l'API : mêmes formats que la vraie (liste paginée, détail, versions), avec pannes programmables.
function fakeApi(state) {
  const calls = [];
  const resp = (status, body, headers = {}) => new Response(typeof body === "string" ? body : J(body),
    { status, headers: { "content-type": "application/json", ...headers } });
  const fetchFn = async url => {
    const u = new URL(url); calls.push(u.pathname + u.search);
    const fault = state.faults && state.faults.shift && state.faults.length && state.faults[0].match(u.pathname) ? state.faults.shift() : null;
    if (fault) { if (fault.throw) throw new Error(fault.throw); return resp(fault.status, { message: "x" }, fault.headers); }
    if (u.pathname === "/api/game-versions") return resp(200, { data: state.versions, meta: { total: state.versions.length } });
    if (u.pathname === "/api/blueprints") {
      const size = state.pageSize || 200, page = Number(u.searchParams.get("page[number]") || 1), last = Math.max(1, Math.ceil(state.list.length / size));
      return resp(200, { data: state.list.slice((page - 1) * size, page * size),
        links: { next: page < last ? "next" : null }, meta: { current_page: page, last_page: last, total: state.list.length, per_page: size } });
    }
    const m = u.pathname.match(/^\/api\/blueprints\/([0-9a-f-]+)$/);
    if (m) return state.details[m[1]] ? resp(200, { data: state.details[m[1]] }) : resp(404, { message: "Not found" });
    return resp(404, { message: "?" });
  };
  return { fetchFn, calls };
}
const baseState = () => ({ versions: clone(FX.versions), list: clone(FX.list), details: clone(FX.details), faults: [] });
const sync = (state, o = {}) => runSync({ rpc: svc, fetchFn: fakeApi(state).fetchFn, trigger: "manual", gapMs: 0, sleepFn: async () => {}, ...o });
const allowManual = () => db.query(`update sc_sync_runs set started_at = started_at - interval '1 hour', finished_at = finished_at - interval '1 hour'`);
const inventorySnapshot = async () => (await db.query(`select
  (select md5(coalesce(string_agg(t::text, ',' order by id), '')) from user_stocks t) s,
  (select md5(coalesce(string_agg(t::text, ',' order by id), '')) from movements t) m,
  (select count(*) from inventory_scans) c`)).rows[0];

before(async () => {
  db = await freshDb();
  admin = await addUser(db, "Admin", "admin");
  alice = await addUser(db, "Alice");
  bob = await addUser(db, "Bob");
  eve = await addUser(db, "Eve", "member", { org: "Autre org" });
  otherAdmin = await addUser(db, "AdminAutre", "admin", { org: "Autre org" });
  for (const n of ["Agricium", "Hadanite", "Fer", "Titanium", "Riccite", "Hephaestanite", "Pressurized Ice"])
    res[n] = await rpc(db, admin, "create_resource", [J({ name: n }), "manuel", ""]);
  await rpc(db, alice, "adjust_stock", [J({ operation_id: randomUUID(), location: "Lorville", resource_id: res.Agricium, quality_key: "500", unit: "SCU", mode: "add", quantity: 3, kind: "production" })]);
});

test("Première synchronisation : 4 blueprints, une recette chacun, quantités, unités et qualités de l'API", async () => {
  const snap = await inventorySnapshot();
  const out = await sync(baseState());
  assert.equal(out.status, "success", J(out));
  const bp = (await db.query(`select uuid, key, game_version, output_name from sc_blueprints order by key`)).rows;
  assert.equal(bp.length, 4);
  assert.ok(bp.every(b => b.game_version === "4.10.2-LIVE.12881860"));
  const ing = (await db.query(`select b.uuid, i.slot_key, i.kind, i.name, i.quantity::float q, i.unit, i.min_quality
    from sc_ingredients i join sc_recipes r on r.id = i.recipe_id join sc_blueprints b on b.id = r.blueprint_id
    where r.is_current order by b.uuid, i.slot_position`)).rows;
  const of = u => ing.filter(i => i.uuid === u).map(i => [i.slot_key, i.kind, i.name, i.q, i.unit, i.min_quality]);
  assert.deepEqual(of(OMNI), [["FRAME", "resource", "Agricium", 0.36, "SCU", 1], ["EMITTER", "item", "Hadanite", 7, "", 1], ["APERTURE IRIS", "item", "Dolivine", 7, "", 1]]);
  // La liste additionne le fer (0,26) ; le détail garde deux emplacements distincts.
  assert.deepEqual(of(QUIK), [["SHELL", "resource", "Iron", 0.16, "SCU", 1], ["COOLANT", "resource", "Pressurized Ice", 0.16, "SCU", 1], ["PUMP IMPELLER", "resource", "Iron", 0.1, "SCU", 1]]);
  assert.deepEqual(of(META).map(x => [x[2], x[5]]), [["Titanium", 900], ["Riccite", 800], ["Yormandi Eye", 0]]);
  const rec = (await db.query(`select complete, issues from sc_recipes`)).rows;
  assert.ok(rec.every(r => r.complete && r.issues.length === 0));
  assert.deepEqual(await inventorySnapshot(), snap, "les inventaires ne sont jamais modifiés");
  const v = (await db.query(`select code from sc_game_versions where is_default`)).rows;
  assert.deepEqual(v.map(x => x.code), ["4.10.2-LIVE.12881860"]);
});

test("Synchronisation répétée : aucun doublon, aucune relecture inutile", async () => {
  await allowManual();
  const st = baseState(), api = fakeApi(st);
  const out = await runSync({ rpc: svc, fetchFn: api.fetchFn, trigger: "manual", gapMs: 0, sleepFn: async () => {} });
  assert.equal(out.status, "success");
  assert.ok(!api.calls.some(c => /\/api\/blueprints\/[0-9a-f-]+/.test(c)), "aucun détail relu : rien n'a changé");
  const n = (await db.query(`select (select count(*) from sc_blueprints)::int b, (select count(*) from sc_recipes)::int r, (select count(*) from sc_ingredients)::int i`)).rows[0];
  assert.deepEqual(n, { b: 4, r: 4, i: 12 });
  assert.equal((await sync(baseState(), { trigger: "cron" })).status, "up_to_date", "la tâche quotidienne ne refait rien le même jour");
});

test("Recette modifiée par une nouvelle version : nouvelle ligne, l'ancienne reste traçable", async () => {
  await allowManual();
  await rpc(db, alice, "set_member_blueprint", [Number((await db.query(`select id from sc_blueprints where uuid = $1`, [OMNI])).rows[0].id), true, "", null]);
  const st = baseState();
  st.versions = [{ code: "4.11.0-LIVE.1", channel: "live", released_at: "2026-11-01T00:00:00+00:00", is_default: true }, ...st.versions.map(v => ({ ...v, is_default: false }))];
  for (const b of st.list) b.game_version = "4.11.0-LIVE.1";
  for (const d of Object.values(st.details)) d.game_version = "4.11.0-LIVE.1";
  st.details[OMNI].requirement_groups[0].children[0].quantity_scu = 0.5;
  st.details[OMNI].tiers[0].requirements.children[0].children[0].quantity_scu = 0.5;
  const out = await sync(st);
  assert.equal(out.status, "success");
  assert.equal(out.stats.changed_recipes, 1); assert.equal(out.stats.unchanged_recipes, 3);
  const rs = (await db.query(`select r.id, r.is_current, r.game_version, r.last_seen_version, r.superseded_by, b.current_recipe_id
    from sc_recipes r join sc_blueprints b on b.id = r.blueprint_id where b.uuid = $1 order by r.id`, [OMNI])).rows;
  assert.equal(rs.length, 2);
  assert.deepEqual([rs[0].is_current, rs[0].game_version, rs[0].superseded_by], [false, "4.10.2-LIVE.12881860", rs[1].id]);
  assert.deepEqual([rs[1].is_current, rs[1].game_version, rs[1].current_recipe_id], [true, "4.11.0-LIVE.1", rs[1].id]);
  const old = (await db.query(`select quantity::float q from sc_ingredients where recipe_id = $1 and slot_key = 'FRAME'`, [rs[0].id])).rows[0].q;
  assert.equal(old, 0.36, "l'ancienne recette garde ses quantités");
  const others = (await db.query(`select last_seen_version from sc_recipes r join sc_blueprints b on b.id = r.blueprint_id where b.uuid <> $1`, [OMNI])).rows;
  assert.ok(others.every(r => r.last_seen_version === "4.11.0-LIVE.1"), "recette identique : seulement la version vue est mise à jour");
  assert.equal((await db.query(`select count(*)::int n from member_blueprints where removed_at is null`)).rows[0].n, 1, "la possession est conservée");
});

test("UUID changé pour une même clé, blueprint retiré de l'API : jamais de doublon ni de suppression", async () => {
  await allowManual();
  const st = baseState(), fresh = "11111111-2222-4333-8444-555555555555";
  const k = st.list.find(b => b.uuid === KILL); k.uuid = fresh;
  st.details[fresh] = { ...st.details[KILL], uuid: fresh };
  st.list = st.list.filter(b => b.uuid !== META);
  const out = await sync(st);
  assert.equal(out.status, "partial", "le changement d'UUID est signalé dans le journal");
  const b = (await db.query(`select uuid, former_uuids from sc_blueprints where key = $1`, [k.key])).rows;
  assert.equal(b.length, 1); assert.equal(b[0].uuid, fresh); assert.deepEqual(b[0].former_uuids, [KILL]);
  const gone = (await db.query(`select missing_since is not null m from sc_blueprints where uuid = $1`, [META])).rows[0];
  assert.equal(gone.m, true);
  assert.equal((await db.query(`select count(*)::int n from sc_blueprints`)).rows[0].n, 4);
  await allowManual();
  assert.equal((await sync(baseState())).status, "partial", "UUID d'origine revenu : journalisé, toujours sans doublon");
  assert.equal((await db.query(`select count(*)::int n from sc_blueprints`)).rows[0].n, 4);
  assert.equal((await db.query(`select missing_since from sc_blueprints where uuid = $1`, [META])).rows[0].missing_since, null);
});

test("Limites et erreurs : 429 (Retry-After), panne passagère, détail introuvable, liste en panne", async () => {
  const waits = [], st = { faults: [{ match: p => p === "/x", status: 429, headers: { "retry-after": "7" } }] };
  st.faults = [{ match: () => true, status: 429, headers: { "retry-after": "7" } }, { match: () => true, status: 503 }];
  const c = makeClient(fakeApi({ ...baseState(), ...st }).fetchFn, { gapMs: 0, sleepFn: async ms => { waits.push(ms); } });
  const r = await c.getJson("/api/game-versions");
  assert.ok(Array.isArray(r.data)); assert.equal(waits[0], 7000); assert.equal(c.requests, 3);
  // Détail disparu (404) : journalisé, le reste est enregistré, résultat « partiel ».
  await allowManual();
  const s2 = baseState(); s2.list[0] = { ...s2.list[0], craft_time_seconds: 999 }; delete s2.details[s2.list[0].uuid];
  const o2 = await sync(s2);
  assert.equal(o2.status, "partial");
  const err = (await db.query(`select context, message from sc_sync_errors where run_id = $1`, [o2.run_id])).rows;
  assert.ok(err.some(e => e.context === "API" && /Introuvable/.test(e.message)));
  // Panne réseau sur la liste : la synchronisation échoue proprement, le catalogue reste intact.
  await allowManual();
  const before = (await db.query(`select count(*)::int n from sc_recipes`)).rows[0].n;
  const s3 = baseState(); s3.faults = Array.from({ length: 4 }, () => ({ match: p => p === "/api/blueprints", throw: "connexion coupée" }));
  const o3 = await sync(s3);
  assert.equal(o3.status, "error"); assert.match(o3.error, /injoignable/);
  assert.equal((await db.query(`select status from sc_sync_runs where id = $1`, [o3.run_id])).rows[0].status, "error");
  assert.equal((await db.query(`select count(*)::int n from sc_recipes`)).rows[0].n, before);
});

test("Pagination et reprise : une invocation limitée en temps rend la main, la suivante termine", async () => {
  await allowManual();
  const st = baseState(); st.pageSize = 3;
  st.list = st.list.map(b => ({ ...b, craft_time_seconds: (b.craft_time_seconds || 0) + 1 }));   // tout relire
  const api = fakeApi(st);
  const o1 = await runSync({ rpc: svc, fetchFn: api.fetchFn, trigger: "manual", gapMs: 0, sleepFn: async () => {}, budgetMs: 0 });
  assert.equal(o1.status, "continue"); assert.equal(o1.pending, 4);
  assert.ok(api.calls.some(c => c.includes("page%5Bnumber%5D=2")), "deuxième page lue");
  const o2 = await runSync({ rpc: svc, fetchFn: api.fetchFn, trigger: "manual", gapMs: 0, sleepFn: async () => {} });
  assert.equal(o2.status, "success"); assert.equal(o2.run_id, o1.run_id, "même synchronisation reprise");
  // Deux invocations simultanées : la seconde voit la première au travail.
  await allowManual();
  const begun = await svc("sc_sync_begin", { p_trigger: "manual", p_user: null, p_force: false });
  assert.equal((await sync(baseState())).status, "busy");
  await svc("sc_sync_finish", { p_run: begun.run_id, p_error: null });
});

test("Recettes alternatives, paliers, groupes imbriqués et données manquantes : rien n'est inventé", async () => {
  const d = { tiers: [
    { tier_index: 0, requirements: { kind: "root", children: [
      { key: "CORE", kind: "group", name: "Core", required_count: 1, children: [
        { kind: "resource", name: "Iron", uuid: "f386a33c-ac9a-400a-a7b8-fe1fc7c8d270", min_quality: 300, quantity_scu: 1 },
        { kind: "resource", name: "Copper", uuid: "a789f57a-e12b-4bcd-8132-e0c03d84fc89", min_quality: 300, quantity_scu: 2 }] },
      { key: "SHELL", kind: "group", name: "Shell", required_count: 1, children: [
        { key: "INNER", kind: "group", name: "Inner", required_count: 1, children: [{ kind: "item", name: "Hadanite", uuid: "125dd723-95ad-488d-830f-62c954445ca1" }] }] },
      { key: "ODD", kind: "group", name: "Odd", children: [{ kind: "blob", name: "?" }] }] } },
    { tier_index: 1, requirements: { kind: "root", children: [
      { key: "CORE", kind: "group", name: "Core", required_count: 1, children: [{ kind: "resource", name: "Iron", uuid: "f386a33c-ac9a-400a-a7b8-fe1fc7c8d270", min_quality: 600, quantity_scu: 3 }] }] } }] };
  const p = (await db.query(`select public._sc_parse_recipe($1::jsonb) p`, [J(d)])).rows[0].p;
  const rows = p.rows.map(r => [r.tier_index, r.slot_key, r.option_index, r.option_count, r.required_count, r.name, r.quantity, r.min_quality]);
  assert.deepEqual(rows, [
    [0, "CORE", 0, 2, 1, "Iron", 1, 300], [0, "CORE", 1, 2, 1, "Copper", 2, 300],
    [0, "SHELL/INNER", 0, 1, 1, "Hadanite", null, null],
    [1, "CORE", 0, 1, 1, "Iron", 3, 600]]);
  assert.equal(p.tiers, 2);
  assert.ok(p.issues.some(i => /Quantité non fournie : Hadanite/.test(i)));
  assert.ok(p.issues.some(i => /Qualité minimale non fournie : Hadanite/.test(i)));
  assert.ok(p.issues.some(i => /type inconnu « blob »/.test(i)));
  const none = (await db.query(`select public._sc_parse_recipe('{}'::jsonb) p`)).rows[0].p;
  assert.deepEqual(none.rows, []); assert.ok(none.issues.length === 1);
});

test("Correspondances : suggestions à valider par un administrateur, jamais confirmées automatiquement", async () => {
  const map = async () => Object.fromEntries((await db.query(`select m.name, mm.status, mm.resource_id, mm.confidence::float c
    from sc_materials m join sc_material_map mm using (api_uuid)`)).rows.map(r => [r.name, r]));
  let m = await map();
  assert.equal(m.Agricium.status, "suggested"); assert.equal(m.Agricium.resource_id, res.Agricium); assert.equal(m.Agricium.c, 0.9);
  assert.equal(m.Iron.status, "suggested"); assert.equal(m.Iron.resource_id, res.Fer); assert.equal(m.Iron.c, 0.7, "nom français : confiance plus faible");
  assert.equal(m.Dolivine.status, "unmatched");
  assert.equal(m["Agricium (Ore)"].resource_id, null, "le minerai brut n'est pas confondu avec la ressource raffinée");
  assert.equal((await db.query(`select count(*)::int n from sc_material_map where status = 'confirmed'`)).rows[0].n, 0);
  const agri = (await db.query(`select api_uuid from sc_materials where name = 'Agricium'`)).rows[0].api_uuid;
  const iron = (await db.query(`select api_uuid from sc_materials where name = 'Iron'`)).rows[0].api_uuid;
  await rejects(rpc(db, alice, "sc_set_material_map", [agri, "confirm", res.Agricium]), /administrateurs/);
  await rpc(db, admin, "sc_set_material_map", [agri, "confirm", res.Agricium]);
  await rejects(rpc(db, admin, "sc_set_material_map", [iron, "confirm", res.Agricium]), /déjà à une autre matière/);
  await rpc(db, admin, "sc_set_material_map", [iron, "reject", null]);
  await allowManual();
  await sync(baseState(), { force: true });
  m = await map();
  assert.equal(m.Agricium.status, "confirmed", "une synchronisation ne remet jamais en cause une décision");
  assert.equal(m.Iron.status, "rejected");
  await rpc(db, admin, "sc_set_material_map", [iron, "reset", null]);
  assert.equal((await map()).Iron.status, "suggested");
});

test("Sécurité : fonctions de synchronisation réservées, catalogue en lecture seule, organisations isolées", async () => {
  await rejects(rpc(db, admin, "sc_sync_begin", ["manual", null, false]), /permission denied/);
  await rejects(rpc(db, alice, "sc_sync_finish", [1, null]), /permission denied/);
  await rejects(as(db, admin, `insert into sc_blueprints (uuid, key) values (gen_random_uuid(), 'x')`), /row-level security/);
  await rejects(as(db, admin, `update sc_material_map set status = 'confirmed'`).then(r => { if (r.affectedRows === 0) throw new Error("row-level security (aucune ligne)"); }), /row-level security/);
  assert.equal(await rpc(db, alice, "sc_can_sync", []), false);
  assert.equal(await rpc(db, admin, "sc_can_sync", []), true);
  assert.ok((await as(db, alice, `select count(*)::int n from sc_blueprints`)).rows[0].n > 0, "catalogue lisible par les membres");
  assert.equal((await as(db, alice, `select count(*)::int n from sc_sync_errors`)).rows[0].n, 0, "erreurs détaillées : administrateurs");
  assert.ok((await as(db, admin, `select count(*)::int n from sc_sync_errors`)).rows[0].n > 0);
  const pending = await addUser(db, "EnAttente", "pending");
  assert.equal((await as(db, pending, `select count(*)::int n from sc_blueprints`)).rows[0].n, 0);
});

test("Blueprints possédés : déclarés par chaque membre, visibles dans son organisation seulement, historique conservé", async () => {
  const id = Number((await db.query(`select id from sc_blueprints where uuid = $1`, [QUIK])).rows[0].id);
  await rpc(db, bob, "set_member_blueprint", [id, true, "obtenu en mission", null]);
  await rpc(db, bob, "set_member_blueprint", [id, true, "obtenu en mission", null]);         // répété : une seule ligne
  assert.equal((await db.query(`select count(*)::int n from member_blueprints where user_id = $1`, [bob])).rows[0].n, 1);
  assert.equal((await as(db, alice, `select count(*)::int n from member_blueprints where user_id = $1`, [bob])).rows[0].n, 1);
  assert.equal((await as(db, eve, `select count(*)::int n from member_blueprints`)).rows[0].n, 0, "autre organisation : invisible");
  await rejects(rpc(db, alice, "set_member_blueprint", [id, true, "", bob]), /propre inventaire/);
  await rejects(rpc(db, otherAdmin, "set_member_blueprint", [id, true, "", bob]), /ton organisation/);
  await rpc(db, bob, "set_member_blueprint", [id, false, "", null]);
  const r = (await db.query(`select removed_at is not null r from member_blueprints where user_id = $1`, [bob])).rows[0];
  assert.equal(r.r, true, "retiré mais conservé");
  await rpc(db, admin, "set_member_blueprint", [id, true, "", bob]);
  assert.equal((await db.query(`select removed_at from member_blueprints where user_id = $1`, [bob])).rows[0].removed_at, null);
});
