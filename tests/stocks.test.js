// Tests des stocks personnels (migration 006) sur une vraie base Postgres en mémoire.
// Lancer : npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { freshDb, runRemaining, addUser, rpc, as } from "./harness.js";

let db, admin, matsu, joueurB, quanta, aphorite;

const key = () => randomUUID();
const scan = (user, location, items, extra = {}) =>
  rpc(db, user, "apply_scan", [JSON.stringify({ idempotency_key: key(), location, terminal_type: "inventaire",
    coverage: "partial", items, ...extra }), false]);
const preview = (user, location, items, extra = {}) =>
  rpc(db, user, "apply_scan", [JSON.stringify({ location, coverage: "partial", items, ...extra }), true]);
const adjust = (user, p) => rpc(db, user, "adjust_stock", [JSON.stringify(p)]);
const line = (resource_id, quality_key, quantity, unit = "") => ({ resource_id, quality_key, quantity, unit });
async function stock(user, location, res, q = "258", unit = "") {
  const r = await db.query(
    `select s.quantity from user_stocks s join locations l on l.id = s.location_id
     where s.user_id = $1 and l.slug = place_slug($2) and s.resource_id = $3 and s.quality_key = $4 and s.unit = $5`,
    [user, location, res, q, unit]);
  return r.rows.length ? Number(r.rows[0].quantity) : null;
}
async function moves(user, res) {
  return (await db.query(`select kind, delta::float as delta, before::float as before, after::float as after
    from movements where owner_id = $1 and resource_id = $2 order by id`, [user, res])).rows;
}
const rejects = (p, re) => assert.rejects(p, e => { assert.match(e.message, re); return true; });

before(async () => {
  db = await freshDb();
  admin = await addUser(db, "Admin", "admin");
  matsu = await addUser(db, "Matsu89");
  joueurB = await addUser(db, "JoueurB");
  quanta = await rpc(db, admin, "create_resource", [JSON.stringify({ name: "Quantainium" }), "manuel", ""]);
  aphorite = await rpc(db, admin, "create_resource", [JSON.stringify({ name: "Aphorite" }), "manuel", ""]);
});

test("1. Deux joueurs, même minerai, même ville : stocks indépendants", async () => {
  await scan(matsu, "Area18", [line(aphorite, 300, 10)]);
  await scan(joueurB, "Area18", [line(aphorite, 300, 4)]);
  assert.equal(await stock(matsu, "Area18", aphorite, "300"), 10);
  assert.equal(await stock(joueurB, "Area18", aphorite, "300"), 4);
  const tot = await as(db, matsu, `select sum(s.quantity)::float as t from user_stocks s join locations l on l.id = s.location_id
    where l.slug = 'area18' and s.resource_id = $1`, [aphorite]);
  assert.equal(tot.rows[0].t, 14);
});

test("2. Un joueur, même minerai dans deux villes", async () => {
  await scan(matsu, "Orison", [line(aphorite, 300, 7)]);
  assert.equal(await stock(matsu, "Orison", aphorite, "300"), 7);
  assert.equal(await stock(matsu, "Area18", aphorite, "300"), 10, "Area18 inchangé");
});

test("3. Deux qualités du même minerai ne sont jamais fusionnées ; qualité inconnue = une seule ligne", async () => {
  await scan(matsu, "Orison", [line(aphorite, 300, 7), line(aphorite, 500, 2), line(aphorite, "-", 1)]);
  await scan(matsu, "Orison", [line(aphorite, "", 1)]);
  assert.equal(await stock(matsu, "Orison", aphorite, "500"), 2);
  assert.equal(await stock(matsu, "Orison", aphorite, "-"), 1);
  const n = await db.query(`select count(*)::int as n from user_stocks where user_id = $1 and resource_id = $2 and quality_key = '-'`, [matsu, aphorite]);
  assert.equal(n.rows[0].n, 1);
});

test("4-5. Premier scan = référence initiale, puis variations successives (10, 18, 25, 25, 20)", async () => {
  const r1 = await scan(matsu, "Lorville", [line(quanta, 258, 10)]);
  assert.equal(r1.changes[0].kind, "initial");
  await scan(matsu, "Lorville", [line(quanta, 258, 18)]);
  await scan(matsu, "Lorville", [line(quanta, 258, 25)]);
  const r4 = await scan(matsu, "Lorville", [line(quanta, 258, 25)]);
  assert.equal(r4.changes.length, 0);
  assert.equal(r4.unchanged, 1);
  const p5 = await preview(matsu, "Lorville", [line(quanta, 258, 20)]);
  assert.deepEqual(p5.changes.map(c => [c.delta, c.kind]), [[-5, "decrease"]], "le retrait inconnu est signalé à classer");
  await scan(matsu, "Lorville", [line(quanta, 258, 20)], { reasons: { [`${quanta}|258|`]: "sale" } });
  assert.equal(await stock(matsu, "Lorville", quanta), 20);
  assert.deepEqual((await moves(matsu, quanta)).map(m => [m.kind, m.delta]),
    [["initial", 10], ["increase", 8], ["increase", 7], ["sale", -5]]);
});

test("6. Capture répétée : même clé = rien n'est réappliqué ; même état = aucun mouvement", async () => {
  const k = key();
  const p = { idempotency_key: k, location: "Lorville", coverage: "partial", items: [line(quanta, 258, 30)] };
  const a = await rpc(db, matsu, "apply_scan", [JSON.stringify(p), false]);
  const b = await rpc(db, matsu, "apply_scan", [JSON.stringify(p), false]);
  assert.equal(b.replayed, true);
  assert.equal(b.scan_id, a.scan_id);
  assert.equal(await stock(matsu, "Lorville", quanta), 30);
  const before = (await moves(matsu, quanta)).length;
  await scan(matsu, "Lorville", [line(quanta, 258, 30)]);
  assert.equal((await moves(matsu, quanta)).length, before);
});

test("7. Même stock affiché par deux terminaux : un seul inventaire", async () => {
  await scan(matsu, "New Babbage", [line(quanta, 400, 12)], { terminal_type: "inventaire" });
  const r = await scan(matsu, "new-babbage", [line(quanta, 400, 12)], { terminal_type: "ascenseur_fret" });
  assert.equal(r.changes.length, 0, "vue différente, même stock : aucune variation");
  const n = await db.query(`select count(*)::int as n from user_stocks where user_id = $1 and resource_id = $2 and quality_key = '400'`, [matsu, quanta]);
  assert.equal(n.rows[0].n, 1);
  const locs = await db.query(`select count(*)::int as n from locations where slug = 'newbabbage'`);
  assert.equal(locs.rows[0].n, 1, "« New Babbage » et « new-babbage » sont le même lieu");
});

test("8. Capture partielle : les minerais absents ne passent pas à 0 ; complète validée : oui", async () => {
  await scan(joueurB, "Levski", [line(quanta, 100, 5), line(aphorite, 200, 3)]);
  await scan(joueurB, "Levski", [line(quanta, 100, 6)]);
  assert.equal(await stock(joueurB, "Levski", aphorite, "200"), 3, "partielle : Aphorite conservée");
  const r = await scan(joueurB, "Levski", [line(quanta, 100, 6)], { coverage: "complete", absent_reason: "transfer_out" });
  assert.equal(await stock(joueurB, "Levski", aphorite, "200"), 0);
  const absent = r.changes.find(c => c.absent);
  assert.equal(absent.kind, "transfer_out");
  assert.equal(absent.delta, -3);
});

test("9. Plusieurs cases du même lot dans un scan sont additionnées ; cases répétées entre pages repérées", async () => {
  const r = await scan(joueurB, "Grim HEX", [line(quanta, 700, 2), line(quanta, 700, 3)]);
  assert.equal(await stock(joueurB, "Grim HEX", quanta, "700"), 5);
  assert.equal(r.changes.length, 1);
  await import("../scanlogic.js");
  const { flagOverlaps } = globalThis.ScanLogic;
  const t = (page, name, q, qty, y, x) => ({ page, name, quality: q, qty, box: [x, y, x + 50, y + 50] });
  const items = [
    t(1, "A", "1", 1, 100, 0), t(1, "B", "2", 1, 100, 100), t(1, "C", "3", 1, 200, 0), t(1, "D", "4", 1, 200, 100),
    t(2, "C", "3", 1, 100, 0), t(2, "D", "4", 1, 100, 100), t(2, "E", "5", 1, 200, 0),
  ];
  const dup = flagOverlaps(items);
  assert.deepEqual(dup.map(i => items.indexOf(i)), [4, 5], "les 2 cases de début de page 2 = fin de page 1");
  const single = [t(1, "A", "1", 1, 100, 0), t(1, "B", "2", 1, 100, 100), t(2, "B", "2", 1, 100, 0), t(2, "E", "5", 1, 100, 100)];
  assert.equal(flagOverlaps(single).length, 0, "une seule case identique ne suffit pas (lots identiques possibles)");
});

test("10. Retrait d'une partie du stock, jamais au-delà", async () => {
  await adjust(matsu, { location: "Lorville", resource_id: quanta, quality_key: "258", mode: "remove", quantity: 4, kind: "refining" });
  assert.equal(await stock(matsu, "Lorville", quanta), 26);
  await rejects(adjust(matsu, { location: "Lorville", resource_id: quanta, quality_key: "258", mode: "remove", quantity: 999 }), /Stock insuffisant/);
  await rejects(adjust(matsu, { location: "Lorville", resource_id: quanta, quality_key: "258", mode: "remove", quantity: 1, kind: "production" }), /sens du mouvement/);
});

test("11. Correction d'une erreur de lecture sans fausse production ni perte d'historique", async () => {
  await scan(joueurB, "Area18", [line(quanta, 900, 18)]);
  await scan(joueurB, "Area18", [line(quanta, 900, 81)]);            // l'IA a lu 81 au lieu de 18
  await rejects(adjust(joueurB, { location: "Area18", resource_id: quanta, quality_key: "900", mode: "set", quantity: 18 }), /motif/);
  await adjust(joueurB, { location: "Area18", resource_id: quanta, quality_key: "900", mode: "set", quantity: 18, note: "Erreur de lecture 81/18" });
  const r = await scan(joueurB, "Area18", [line(quanta, 900, 18)]);
  assert.equal(r.changes.length, 0);
  const m = await moves(joueurB, quanta);
  assert.deepEqual(m.filter(x => x.after === 81 || x.before === 81).map(x => x.kind), ["increase", "correction"], "historique conservé");
  // La hausse erronée peut être reclassée ; la correction l'annule.
});

test("12. Impossible de modifier le stock d'un autre membre ; un admin le peut avec un motif", async () => {
  await rejects(scan(joueurB, "Lorville", [line(quanta, 258, 0)], { owner_id: matsu }), /propre inventaire/);
  await rejects(adjust(joueurB, { owner_id: matsu, location: "Lorville", resource_id: quanta, quality_key: "258", mode: "set", quantity: 0, note: "x" }), /propre inventaire/);
  // Écriture directe dans la table : la RLS ne laisse rien passer (comme via l'API Supabase).
  const upd = await as(db, joueurB, `update user_stocks set quantity = 0 where user_id = $1`, [matsu]);
  assert.equal(upd.affectedRows, 0);
  assert.equal(await stock(matsu, "Lorville", quanta), 26);
  await rejects(as(db, joueurB, `insert into user_stocks (user_id, location_id, resource_id, quantity)
    select $1, id, $2, 1 from locations limit 1`, [joueurB, quanta]), /row-level security/);
  await rejects(as(db, joueurB, `insert into movements (name, mode, owner_id) values ('x', 'add', $1)`, [matsu]), /row-level security/);
  await rejects(as(db, joueurB, `select public._write_stock($1, null, null, '1', '', 1, null, 'scan', '', null)`, [matsu]), /permission denied/);
  const pending = await addUser(db, "EnAttente", "pending");
  await rejects(scan(pending, "Lorville", [line(quanta, 1, 1)]), /non validé/);
  await adjust(admin, { owner_id: matsu, location: "Lorville", resource_id: quanta, quality_key: "258", mode: "set", quantity: 25, note: "Contrôle admin" });
  assert.equal(await stock(matsu, "Lorville", quanta), 25);
  const last = await db.query(`select by, owner_id, note from movements where owner_id = $1 order by id desc limit 1`, [matsu]);
  assert.equal(last.rows[0].by, admin);
  assert.equal(last.rows[0].owner_id, matsu);
});

test("13. Deux scans simultanés du même inventaire : le second doit relancer son aperçu", async () => {
  const items1 = [line(aphorite, 600, 3)], items2 = [line(aphorite, 600, 9)];
  const p1 = await preview(joueurB, "Orison", items1);
  const p2 = await preview(joueurB, "Orison", items2);
  assert.equal(p1.state_token, p2.state_token);
  await scan(joueurB, "Orison", items1, { state_token: p1.state_token });
  await rejects(scan(joueurB, "Orison", items2, { state_token: p2.state_token }), /STATE_CHANGED/);
  assert.equal(await stock(joueurB, "Orison", aphorite, "600"), 3);
});

test("14. Capture plus ancienne que le dernier état : refusée sauf confirmation", async () => {
  await scan(matsu, "Seraphim", [line(quanta, 10, 50)], { observed_at: new Date().toISOString() });
  const old = new Date(Date.now() - 3600e3).toISOString();
  const p = await preview(matsu, "Seraphim", [line(quanta, 10, 40)], { observed_at: old });
  assert.equal(p.stale, true);
  await rejects(scan(matsu, "Seraphim", [line(quanta, 10, 40)], { observed_at: old }), /STALE/);
  assert.equal(await stock(matsu, "Seraphim", quanta, "10"), 50);
  await scan(matsu, "Seraphim", [line(quanta, 10, 40)], { observed_at: old, allow_stale: true });
  assert.equal(await stock(matsu, "Seraphim", quanta, "10"), 40);
});

test("Unités natives conservées : 20x et 20 SCU sont deux stocks distincts", async () => {
  await scan(matsu, "Everus Harbor", [line(quanta, 333, 20, ""), line(quanta, 333, 20, "SCU")]);
  assert.equal(await stock(matsu, "Everus Harbor", quanta, "333", ""), 20);
  assert.equal(await stock(matsu, "Everus Harbor", quanta, "333", "SCU"), 20);
});

test("Lecture : un compte en attente ne voit aucun stock", async () => {
  const pending = (await db.query(`select id from profiles where role = 'pending' limit 1`)).rows[0].id;
  const r = await as(db, pending, `select count(*)::int as n from user_stocks`);
  assert.equal(r.rows[0].n, 0);
});

test("15-16. Migration : rien n'est perdu, anciens stocks à part, aucun double comptage", async () => {
  const d = await freshDb({ upTo: "006" });
  const a = await addUser(d, "Admin", "admin");
  const m = await addUser(d, "Matsu89");
  const res = await rpc(d, a, "create_resource", [JSON.stringify({ name: "Glacosite", places: { "Lorville": { "614": 1, "1000": 6 }, "": { "511": 2 } } }), "manuel", ""]);
  await rpc(d, a, "add_resource_ref", [res, "data:image/jpeg;base64,AAAA"]);
  await rpc(d, a, "apply_lots", [res, "add", JSON.stringify({ "857": 4 }), "manuel", "", null, "Area18"]);
  const before = {
    res: (await d.query(`select id, name, image, refs, places from resources order by id`)).rows,
    mv: (await d.query(`select count(*)::int as n from movements`)).rows[0].n,
    total: (await d.query(`select sum(qty)::float as t from resources`)).rows[0].t,
  };

  await runRemaining(d, "006");
  await runRemaining(d, "006");                                       // relançable sans effet de bord

  assert.deepEqual((await d.query(`select id, name, image, refs, places from resources order by id`)).rows, before.res, "catalogue, images et anciens lots intacts");
  assert.equal((await d.query(`select count(*)::int as n from movements`)).rows[0].n, before.mv, "journal intact");
  assert.equal((await d.query(`select count(*)::int as n from archive.movements_avant_006`)).rows[0].n, before.mv, "sauvegarde faite");
  const legacy = (await d.query(`select place_name, quality_key, quantity::float as q, status from legacy_stocks order by place_name, quality_key`)).rows;
  assert.equal(legacy.reduce((s, l) => s + l.q, 0), before.total, "tout l'ancien stock est repris en « non attribué »");
  assert.equal((await d.query(`select count(*)::int as n from legacy_stocks`)).rows[0].n, 4, "relancer la migration ne duplique rien");
  assert.equal((await d.query(`select count(*)::int as n from user_stocks`)).rows[0].n, 0, "rien n'est attribué automatiquement");

  // Rapprochement : la quantité passe de « non attribué » au stock personnel, sans être comptée deux fois.
  const global = async () => ({
    perso: (await d.query(`select coalesce(sum(quantity), 0)::float as t from user_stocks`)).rows[0].t,
    open: (await d.query(`select coalesce(sum(quantity), 0)::float as t from legacy_stocks where status = 'open'`)).rows[0].t,
  });
  const g0 = await global();
  const lorv = (await d.query(`select id from legacy_stocks where place_name = 'Lorville' and quality_key = '1000'`)).rows[0].id;
  await rejects(rpc(d, m, "resolve_legacy", [lorv, "attribute", m, null, ""]), /propriétaire/);
  const ch = await rpc(d, a, "resolve_legacy", [lorv, "attribute", m, null, "Déclaré par Matsu"]);
  assert.equal(ch.kind, "legacy_attribution", "jamais compté comme production");
  const g1 = await global();
  assert.equal(g1.perso + g1.open, g0.perso + g0.open, "total inchangé : aucun double comptage");
  assert.equal(g1.perso, 6);
  const noPlace = (await d.query(`select id from legacy_stocks where place_name = ''`)).rows[0].id;
  await rejects(rpc(d, a, "resolve_legacy", [noPlace, "attribute", m, null, ""]), /lieu/);
  await rpc(d, a, "resolve_legacy", [noPlace, "archive", null, null, "Déjà compté"]);
  assert.equal((await d.query(`select count(*)::int as n from legacy_stocks`)).rows[0].n, 4, "rien n'est supprimé");
  await rejects(rpc(d, a, "resolve_legacy", [lorv, "archive", null, null, ""]), /déjà été traitée/);
});

test("Fusion de ressources : les stocks personnels suivent, sans perte ni doublon de ligne", async () => {
  const dup = await rpc(db, admin, "create_resource", [JSON.stringify({ name: "Quantanium (doublon)" }), "manuel", ""]);
  await scan(matsu, "Lorville", [line(dup, 258, 5)]);
  const before = await stock(matsu, "Lorville", quanta);
  await rpc(db, admin, "merge_resources", [dup, quanta]);
  assert.equal(await stock(matsu, "Lorville", quanta), before + 5);
  await rejects(rpc(db, admin, "delete_resource", [quanta]), /possèdent encore/);
});

test("Raffinerie (migration 013) : chaque ordre s'ajoute au stock du lieu, sans rien remplacer", async () => {
  const lieu = "Levski raffinerie";
  await runRemaining(db, "013");   // relancer la migration ne change rien
  const raf = (items, extra = {}) => scan(matsu, lieu, items, { terminal_type: "raffinerie", mode: "add", coverage: "complete", reasons: {}, ...extra });
  // Un autre minerai déjà présent : un ordre de raffinerie ne doit jamais le mettre à 0.
  await scan(matsu, lieu, [line(aphorite, "500", 3, "SCU")]);
  const r1 = await raf([line(quanta, "382", 16.05, "SCU"), line(quanta, "597", 6.23, "SCU")],
    { reasons: { [`${quanta}|382|SCU`]: "refined" } });
  assert.equal(r1.coverage, "partial", "toujours partielle");
  assert.equal(await stock(matsu, lieu, quanta, "382", "SCU"), 16.05);
  const kindOf = async q => (await db.query(`select kind from movements where owner_id = $1 and resource_id = $2 and quality_key = $3 order by id desc limit 1`, [matsu, quanta, q])).rows[0].kind;
  assert.equal(await kindOf("382"), "refined", "premier lot : sortie de raffinerie, pas un stock initial");
  assert.equal(await kindOf("597"), "increase", "sans nature choisie : hausse à classer, jamais « stock initial »");
  // Aperçu du deuxième ordre : la variation est le lot lu, l'état final la somme.
  const pv = await preview(matsu, lieu, [line(quanta, "382", 24.71, "SCU")], { mode: "add" });
  assert.equal(Number(pv.changes[0].before), 16.05);
  assert.equal(Number(pv.changes[0].after), 40.76);
  assert.equal(Number(pv.changes[0].delta), 24.71);
  await raf([line(quanta, "382", 24.71, "SCU"), line(quanta, "597", 4.3, "SCU")]);
  assert.equal(await stock(matsu, lieu, quanta, "382", "SCU"), 40.76);
  assert.equal(await stock(matsu, lieu, quanta, "597", "SCU"), 10.53);
  assert.equal(await stock(matsu, lieu, aphorite, "500", "SCU"), 3, "les autres minerais ne changent pas");
  // Ajout plus ancien que le dernier état : accepté (ce n'est pas un relevé).
  await raf([line(quanta, "597", 1, "SCU")], { observed_at: new Date(Date.now() - 864e5).toISOString() });
  assert.equal(await stock(matsu, lieu, quanta, "597", "SCU"), 11.53);
  await rejects(raf([line(quanta, "597", 0, "SCU")]), /Quantité invalide/);
  // Sans le mode ajout, rien ne change : une capture reste un relevé.
  await scan(matsu, lieu, [line(quanta, "597", 5, "SCU")]);
  assert.equal(await stock(matsu, lieu, quanta, "597", "SCU"), 5);
});
