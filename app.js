const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const num = v => { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const okHex = h => /^#[0-9a-f]{6}$/i.test(String(h || "")) ? h : "";
const swatch = (h, title) => okHex(h) ? `<span class="sw" style="background:${okHex(h)}"${title ? ` title="${esc(title)}"` : ""}></span>` : '<span class="sw none" title="Pas de couleur"></span>';

const okImg = s => typeof s === "string" && s.startsWith("data:image/jpeg;base64,");
// Images de référence d'une ressource : la principale puis les autres vues.
// Images de référence d'une ressource : la principale puis celles de la bibliothèque (ou l'ancien champ refs).
const refsOf = r => {
  if (!r) return [];
  const lib = st.refImages.filter(x => x.resource_id === r.id).map(x => x.image);
  const rest = st.libReady ? lib : (Array.isArray(r.refs) ? r.refs : []);
  return [r.image, ...rest.filter(x => x !== r.image)].filter(okImg);
};

const cfg = window.REGISTRE_CONFIG || {};
const configured = /^https:\/\/.+/.test(cfg.supabaseUrl || "") && cfg.supabaseKey && !/TON-PROJET|TA-CLE/.test(cfg.supabaseUrl + cfg.supabaseKey);
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

const st = { me: null, profiles: {}, orgs: [], resources: [], moves: [], shots: [], items: [], channel: null, recovering: false,
  stocks: [], locations: [], legacy: [], scansMeta: [], myMoves: [], reasons: {}, diff: null, scanKey: null, v2: false,
  refImages: [], libReady: false, requests: [], reqReady: false, rqEdit: null };

function show(view) {
  for (const id of ["authView", "recoveryView", "pendingView", "configView", "appView"]) $("#" + id).hidden = id !== view;
}
function setStatus(msg) { const el = $("#status"); el.textContent = msg || ""; el.hidden = !msg; }
function errText(e) { return (e && (e.message || e.error_description)) || "Une erreur est survenue. Réessaie dans un instant."; }

// ---------- lots par qualité : { "258": 20, "1000": 6, "-": 5 } ("-" = qualité inconnue) ----------
const qKey = q => (q === "" || q == null || !isFinite(parseFloat(q))) ? "-" : String(Math.min(1000, Math.max(0, Math.round(num(q)))));
const qVal = k => k === "-" ? -1 : +k;
const byQdesc = (a, b) => qVal(b) - qVal(a);
function lotsOf(r) {
  const l = r && r.lots && typeof r.lots === "object" ? r.lots : {};
  const o = {}; for (const k in l) if (num(l[k]) > 0) o[k] = num(l[k]); return o;
}
const sumLots = l => Object.values(l).reduce((s, v) => s + num(v), 0);
function clean(o) { for (const k in o) if (!(num(o[k]) > 0)) delete o[k]; return o; }
// Même calcul que public.merge_lots côté serveur, pour l'aperçu avant enregistrement.
function mergeLots(base, delta, mode) {
  if (mode === "set") return clean({ ...delta });
  const o = { ...base };
  for (const [k, v] of Object.entries(delta)) {
    if (mode === "add") o[k] = num(o[k]) + v;
    else if (k !== "-") o[k] = Math.max(0, num(o[k]) - v);
    else {
      let left = v;
      for (const kk of Object.keys(o).sort((a, b) => qVal(a) - qVal(b))) { const t = Math.min(left, o[kk]); o[kk] -= t; left -= t; if (left <= 0) break; }
    }
  }
  return clean(o);
}
// Stations et villes de Star Citizen proposées (on peut aussi taper n'importe quel autre lieu).
const GAME_PLACES = [
  ["Lorville", "Stanton · Hurston"], ["Everus Harbor", "Stanton · Hurston"],
  ["Area18", "Stanton · ArcCorp"], ["Baijini Point", "Stanton · ArcCorp"],
  ["New Babbage", "Stanton · microTech"], ["Port Tressler", "Stanton · microTech"],
  ["Orison", "Stanton · Crusader"], ["Seraphim Station", "Stanton · Crusader"],
  ["Grim HEX", "Stanton · Yela"],
  ["HUR-L1 Green Glade Station", "Stanton · Lagrange"], ["HUR-L2 Faithful Dream Station", "Stanton · Lagrange"],
  ["HUR-L3 Thundering Express Station", "Stanton · Lagrange"], ["HUR-L4 Melodic Fields Station", "Stanton · Lagrange"],
  ["HUR-L5 High Course Station", "Stanton · Lagrange"],
  ["CRU-L1 Ambitious Dream Station", "Stanton · Lagrange"], ["CRU-L4 Shallow Fields Station", "Stanton · Lagrange"],
  ["CRU-L5 Beautiful Glen Station", "Stanton · Lagrange"],
  ["ARC-L1 Wide Forest Station", "Stanton · Lagrange"], ["ARC-L2 Lively Pathway Station", "Stanton · Lagrange"],
  ["ARC-L3 Modern Express Station", "Stanton · Lagrange"], ["ARC-L4 Faint Glen Station", "Stanton · Lagrange"],
  ["ARC-L5 Yellow Core Station", "Stanton · Lagrange"],
  ["MIC-L1 Shallow Frontier Station", "Stanton · Lagrange"], ["MIC-L2 Long Forest Station", "Stanton · Lagrange"],
  ["MIC-L3 Endless Odyssey Station", "Stanton · Lagrange"], ["MIC-L4 Red Crossroads Station", "Stanton · Lagrange"],
  ["MIC-L5 Modern Icarus Station", "Stanton · Lagrange"],
  // Une « Gateway » porte le nom du système vers lequel elle mène : Nyx Gateway se trouve dans Pyro.
  ["Pyro Gateway", "Porte de saut vers Pyro (Stanton, Nyx)"], ["Stanton Gateway", "Porte de saut vers Stanton (Pyro, Nyx)"],
  ["Nyx Gateway", "Porte de saut vers Nyx (Pyro, Stanton)"],
  ["Ruin Station", "Pyro"], ["Checkmate", "Pyro"], ["Orbituary", "Pyro"], ["Starlight Service Station", "Pyro"],
  ["Patch City", "Pyro"], ["Gaslight", "Pyro"], ["Rod's Fuel 'N Supplies", "Pyro"], ["Rat's Nest", "Pyro"],
  ["Endgame", "Pyro"], ["Dudley & Daughters", "Pyro"], ["Megumi Refueling", "Pyro"],
  ["Levski", "Nyx · Delamar"],
];

// ---------- lieux de stockage : places ={ "Lorville": { "258": 20 }, "": { … } } ("" = non précisé) ----------
const NO_PLACE = "Lieu non précisé";
const placeLabel = k => k || NO_PLACE;
function placesOf(r) {
  const p = r && r.places && typeof r.places === "object" ? r.places : null;
  if (!p || !Object.keys(p).length) { const l = lotsOf(r); return sumLots(l) ? { "": l } : {}; }
  const o = {};
  for (const k in p) { const l = lotsOf({ lots: p[k] }); if (sumLots(l)) o[k] = l; }
  return o;
}
const placeKeys = p => Object.keys(p).sort((a, b) => (a === "") - (b === "") || a.localeCompare(b));
const usedPlaces = () => [...new Set(st.resources.flatMap(r => Object.keys(placesOf(r))).filter(Boolean))].sort((a, b) => a.localeCompare(b));
// Texte éditable : un bloc par lieu, « [Lorville] » puis une ligne par lot. Sans en-tête = lieu non précisé.
function placesToText(p) {
  return placeKeys(p).map(k => (k ? `[${k}]\n` : "") + lotsToLines(p[k])).join("\n");
}
function parsePlaces(txt) {
  const o = {}; let cur = "";
  for (const line of String(txt).split(/\n/)) {
    const h = line.match(/^\s*\[(.*)\]\s*$/);
    if (h) { cur = h[1].trim(); continue; }
    const l = parseLots(line);
    if (sumLots(l)) o[cur] = mergeLots(o[cur] || {}, l, "add");
  }
  return o;
}
function avgQ(l) {
  let s = 0, n = 0; for (const [k, v] of Object.entries(l)) if (k !== "-") { s += +k * v; n += v; }
  return n ? Math.round(s / n) : null;
}
const lotsText = l => Object.keys(l).sort(byQdesc).map(k => (k === "-" ? "Q?" : "Q" + k) + " ×" + fmt(l[k])).join(", ");
const lotsToLines = l => Object.keys(l).sort(byQdesc).map(k => k === "-" ? String(l[k]) : k + " x " + l[k]).join("\n");
function parseLots(txt) {
  const o = {};
  for (const line of String(txt).split(/[\n;]+/)) {
    const ns = line.match(/\d+(?:[.,]\d+)?/g); if (!ns) continue;
    const [k, v] = ns.length >= 2 ? [qKey(ns[0]), num(ns[1])] : ["-", num(ns[0])];
    if (v > 0) o[k] = num(o[k]) + v;
  }
  return o;
}
function lotChips(l) {
  const ks = Object.keys(l).sort(byQdesc);
  const shown = ks.slice(0, 6).map(k => `<span class="lot${qVal(k) >= 700 ? " hi" : ""}"><b>${k === "-" ? "Q?" : "Q" + k}</b> ×${fmt(l[k])}</span>`).join("");
  return ks.length ? `<div class="lots">${shown}${ks.length > 6 ? `<span class="lot" title="${esc(lotsText(l))}">+${ks.length - 6}</span>` : ""}</div>` : "";
}

// ---------- authentification ----------
let signup = false;
function setTab(isSignup) {
  signup = isSignup;
  $("#tabLogin").setAttribute("aria-selected", String(!isSignup));
  $("#tabSignup").setAttribute("aria-selected", String(isSignup));
  $("#pseudoField").hidden = !isSignup;
  $("#aPseudo").required = isSignup;
  $("#aPassword").autocomplete = isSignup ? "new-password" : "current-password";
  $("#authSubmit").textContent = isSignup ? "Créer mon compte" : "Se connecter";
  $("#forgot").hidden = isSignup;
  authMsg("");
}
function authMsg(t, kind) { const el = $("#authMsg"); el.textContent = t; el.className = "formmsg" + (kind ? " " + kind : ""); }
$("#tabLogin").addEventListener("click", () => setTab(false));
$("#tabSignup").addEventListener("click", () => setTab(true));

$("#authForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), password = $("#aPassword").value;
  $("#authSubmit").disabled = true;
  try {
    if (signup) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { pseudo: $("#aPseudo").value.trim() }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) authMsg("Compte créé. Ouvre le lien reçu par e-mail pour confirmer ton adresse, puis connecte-toi.", "ok");
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error.message === "Invalid login credentials" ? new Error("E-mail ou mot de passe incorrect.") : error;
    }
  } catch (err) { authMsg(errText(err), "err"); }
  $("#authSubmit").disabled = false;
});

$("#forgot").addEventListener("click", async () => {
  const email = $("#aEmail").value.trim();
  if (!email) { authMsg("Saisis ton e-mail, puis clique à nouveau sur « Mot de passe oublié ».", "err"); $("#aEmail").focus(); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  authMsg(error ? errText(error) : "Si ce compte existe, un lien de réinitialisation vient d'être envoyé.", error ? "err" : "ok");
});

$("#recoveryForm").addEventListener("submit", async e => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $("#rPassword").value });
  const el = $("#recoveryMsg");
  if (error) { el.textContent = errText(error); el.className = "formmsg err"; return; }
  st.recovering = false;
  enter((await sb.auth.getSession()).data.session);
});

document.querySelectorAll(".logout").forEach(b => b.addEventListener("click", () => sb.auth.signOut()));

async function enter(session) {
  if (st.recovering) return show("recoveryView");
  if (!session) { stopRealtime(); st.me = null; setTab(false); return show("authView"); }
  const { data: me, error } = await sb.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error || !me) { show("authView"); authMsg("Profil introuvable. Contacte un administrateur.", "err"); return; }
  st.me = me;
  startRealtime();
  if (me.role === "pending" && !me.is_owner) { $("#pendingName").textContent = me.pseudo; loadPendingOrgs(); return show("pendingView"); }
  $("#meName").textContent = me.pseudo;
  applyRights();
  show("appView");
  await Promise.all([loadOrgs(), loadProfiles(), loadResources(), loadMoves(), loadStocks(), loadRefImages(), loadRequests()]);
  loadMyMoves();
}

// ---------- données ----------
// Ce que le compte connecté peut voir et faire (le serveur vérifie de toute façon chaque action).
function applyRights() {
  const me = st.me; if (!me) return;
  $("#meRole").textContent = me.is_owner ? "Propriétaire" : me.role === "admin" ? "Administrateur" : "Membre";
  $("#meRole").className = "role" + (isAdmin() ? " admin" : "");
  const org = orgName(me.org_id); $("#meOrg").textContent = org; $("#meOrg").hidden = !org;
  $("#openMembers").hidden = !isAdmin();
  $("#tabDb").hidden = !can("catalog");
  $("#tabGlobal").hidden = !can("view_global");
  $("#mergePanel").hidden = !isOwner();
  $("#resetPanel").hidden = !isOwner();
  $("#addRes").hidden = !can("catalog");
  $("#capOwnerBox").hidden = !can("edit_others");
  $("#mOwner").hidden = !can("view_global");
  const cur = document.querySelector('#appTabs [aria-selected="true"]');
  if (cur && cur.hidden) showTab("mine");
}
async function loadOrgs() {
  const { data, error } = await sb.from("organizations").select("id, name, created_at").order("name");
  st.orgs = error ? [] : data || [];
  applyRights();
  if ($("#members").open) renderMembers();
}
// Compte en attente : choix de l'organisation à rejoindre.
async function loadPendingOrgs() {
  const { data } = await sb.from("organizations").select("id, name").order("name");
  st.orgs = data || [];
  const sel = $("#pOrg");
  sel.innerHTML = '<option value="">Choisis ton organisation…</option>' + st.orgs.map(o => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("");
  if (st.me.org_id) sel.value = st.me.org_id;
  const m = $("#pMsg");
  m.textContent = st.me.org_id ? `Demande envoyée à « ${orgName(st.me.org_id)} ». Un de ses administrateurs doit la valider.`
    : st.orgs.length ? "" : "Aucune organisation n'existe encore : contacte le propriétaire du site.";
  m.className = "formmsg" + (st.me.org_id ? " ok" : "");
  $("#pJoin").textContent = st.me.org_id ? "Changer de demande" : "Envoyer la demande";
}
$("#pJoin").addEventListener("click", async () => {
  const v = $("#pOrg").value, m = $("#pMsg");
  if (!v) { m.textContent = "Choisis une organisation."; m.className = "formmsg err"; return; }
  $("#pJoin").disabled = true;
  try { await rpc("request_organization", { p_org: v }); st.me.org_id = v; await loadPendingOrgs(); }
  catch (err) { m.textContent = errText(err); m.className = "formmsg err"; }
  $("#pJoin").disabled = false;
});
async function loadProfiles() {
  const { data } = await sb.from("profiles").select("*").order("created_at");
  st.profiles = Object.fromEntries((data || []).map(p => [p.id, p]));
  const pend = (data || []).filter(p => p.role === "pending").length;
  $("#pendingCount").textContent = pend; $("#pendingCount").hidden = !pend;
  if ($("#members").open) renderMembers();
  renderLog();
  renderAllStocks();
  memberOptions($("#sMember"), "Tous les membres");
}
async function loadResources() {
  const { data, error } = await sb.from("resources").select("*").order("name");
  if (error) return setStatus("Impossible de charger les stocks : " + errText(error));
  setStatus("");
  st.resources = data || [];
  renderAllStocks();
  // Les deux noms sont proposés à la saisie : « Cuivre » comme « Copper ».
  $("#resList").innerHTML = st.resources.map(r => `<option value="${esc(r.name)}">${r.name_en ? esc(r.name_en) : ""}</option>`
    + (r.name_en && norm(r.name_en) !== norm(r.name) ? `<option value="${esc(r.name_en)}">${esc(r.name)}</option>` : "")).join("");
  if (!$("#dbView").hidden) renderDb();
}
async function loadMoves() {
  const { data } = await sb.from("movements").select("*").order("at", { ascending: false }).limit(40);
  st.moves = data || [];
  renderLog();
}

// Lecture paginée (l'API renvoie 1000 lignes au plus par requête).
async function fetchAll(table, select, order) {
  const out = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from(table).select(select).order(order).range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
// Stocks personnels, lieux, anciens stocks non attribués et date des derniers relevés.
async function loadStocks() {
  try {
    const [stocks, locations, legacy, scans] = await Promise.all([
      fetchAll("user_stocks", "*", "id"), fetchAll("locations", "*", "name"), fetchAll("legacy_stocks", "*", "id"),
      sb.from("inventory_scans").select("user_id, location_id, observed_at, coverage_status").eq("validation_status", "applied")
        .order("observed_at", { ascending: false }).limit(2000).then(r => { if (r.error) throw r.error; return r.data; }),
    ]);
    Object.assign(st, { stocks, locations, legacy, scansMeta: scans, v2: true });
    try { bp.cache = null; if (!$("#bpView").hidden) renderBlueprints(); } catch (_) { /* onglet pas encore prêt */ }
  } catch (err) {
    st.v2 = false;
    setStatus(/does not exist|schema cache|relation/i.test(errText(err))
      ? "La base de données n'est pas encore à jour : un administrateur doit exécuter la migration 006 (stocks personnels)."
      : "Impossible de charger les inventaires : " + errText(err));
  }
  renderAllStocks();
}

// Temps réel : on recharge la table concernée (quelques centaines de lignes au plus).
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
// Bibliothèque d'images (migration 007). Avant la migration, on garde l'ancien affichage.
async function loadRefImages() {
  try {
    const cols = "id, resource_id, terminal_type, image, added_by, created_at, source";
    // screen_main (image choisie par écran) arrive avec la migration 011.
    st.refImages = await fetchAll("reference_images", cols + ", screen_main", "id").catch(() => fetchAll("reference_images", cols, "id"));
    st.libReady = true;
  } catch (_) { st.refImages = []; st.libReady = false; }
  $("#tabImg").hidden = !st.libReady;
  if (!$("#imgView").hidden) renderImages();
  if (!$("#dbView").hidden) renderDb();
  if (st.items.length) renderReview();
}
const reloadRes = debounce(loadResources, 250), reloadStocks = debounce(loadStocks, 250), reloadLib = debounce(loadRefImages, 250);
const reloadReq = debounce(() => loadRequests(), 250);
const reloadBp = debounce(() => loadBlueprints(), 1500);
const reloadMoves = debounce(() => { loadMoves(); loadMyMoves(); }, 250);
function startRealtime() {
  if (st.channel) return;
  st.channel = sb.channel("registre")
    .on("postgres_changes", { event: "*", schema: "public", table: "resources" }, reloadRes)
    .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, reloadMoves)
    .on("postgres_changes", { event: "*", schema: "public", table: "user_stocks" }, reloadStocks)
    .on("postgres_changes", { event: "*", schema: "public", table: "legacy_stocks" }, reloadStocks)
    .on("postgres_changes", { event: "*", schema: "public", table: "locations" }, reloadStocks)
    .on("postgres_changes", { event: "*", schema: "public", table: "reference_images" }, reloadLib)
    .on("postgres_changes", { event: "*", schema: "public", table: "requests" }, reloadReq)
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_sync_runs" }, () => { if (bp.loaded) reloadBp(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "member_blueprints" }, () => { if (bp.loaded) reloadBp(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "sc_material_map" }, () => { if (bp.loaded) reloadBp(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "organizations" }, () => { if (st.me && st.me.role !== "pending") loadOrgs(); })
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, payload => {
      if (st.me && payload.new && payload.new.id === st.me.id && rightsSig(payload.new) !== rightsSig(st.me)) return sb.auth.getSession().then(r => enter(r.data.session));
      if (st.me && st.me.role !== "pending") loadProfiles();
    })
    .subscribe();
}
function stopRealtime() { if (st.channel) { sb.removeChannel(st.channel); st.channel = null; } }

async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}
const applyLots = (r, mode, delta, source, note, patch, place) =>
  rpc("apply_lots", { p_id: r.id, p_mode: mode, p_delta: delta, p_source: source, p_note: note || "", p_patch: patch || null, p_place: place || "" });
const createResource = (v, source, note) =>
  rpc("create_resource", { p: { name: v.name, category: v.category || "", unit: v.unit || "", color: okHex(v.color), color_name: v.color_name || "", threshold: v.threshold || 0,
    ...(v.places ? { places: v.places } : { lots: clean({ ...(v.lots || {}) }), place: v.place || "" }) }, p_source: source, p_note: note || "" });

// ---------- inventaires personnels : affichage commun ----------
const KIND = {
  initial: "Stock initial", increase: "Hausse à classer", deposit: "Dépôt", production: "Production minière",
  transfer_in: "Transfert reçu", purchase: "Achat", decrease: "Baisse à classer", withdrawal: "Retrait",
  refined: "Sortie de raffinerie", sale: "Vente", transfer_out: "Transfert envoyé", refining: "Raffinage", consumption: "Consommation", loss: "Perte",
  delivery: "Livraison",
  correction: "Correction", legacy_attribution: "Ancien stock attribué",
};
const INC_KINDS = ["production", "refined", "deposit", "transfer_in", "purchase"];
const DEC_KINDS = ["sale", "delivery", "transfer_out", "refining", "consumption", "loss", "withdrawal"];
// Motifs proposés dans « Déclarer un mouvement » (un transfert interne passe par « Transférer »).
const MV_KINDS = {
  remove: [["sale", "Vente"], ["delivery", "Livraison"], ["consumption", "Consommation"], ["refining", "Envoi en raffinerie"], ["loss", "Perte"],
           ["withdrawal", "Autre retrait"], ["transfer_out", "Transfert hors de l'organisation (note obligatoire)"]],
  add: [["production", "Production minière"], ["refined", "Sortie de raffinerie"], ["deposit", "Dépôt"], ["purchase", "Achat"],
        ["transfer_in", "Reçu hors de l'organisation (note obligatoire)"]],
};
const qLabel = q => (q === "-" || q == null) ? "Q?" : "Q" + q;
const unitTxt = u => u ? " " + u : "";
const locName = id => (st.locations.find(l => l.id === id) || {}).name || "Lieu inconnu";
const who = id => (st.profiles[id] || {}).pseudo || "Membre";
const resOf = id => st.resources.find(r => r.id === id);
// Une ressource se retrouve par son nom français ou anglais.
const resMatch = (r, q) => !!r && (norm(r.name).includes(q) || (!!r.name_en && norm(r.name_en).includes(q)));
const resByName = n => { const k = norm(n); return k ? st.resources.find(r => norm(r.name) === k) || st.resources.find(r => r.name_en && norm(r.name_en) === k) : undefined; };
const isOwner = () => !!(st.me && st.me.is_owner);
const isAdmin = () => !!(st.me && (st.me.is_owner || st.me.role === "admin"));
// Droit d'un membre ; un administrateur (ou le propriétaire) les a tous.
const can = p => !!st.me && (isAdmin() || !!st.me["can_" + p]);
const orgName = id => (st.orgs.find(o => o.id === id) || {}).name || "";
const sameOrg = p => !!p.org_id && p.org_id === (st.me && st.me.org_id);
const rightsSig = p => ["role", "org_id", "is_owner", "can_view_global", "can_scan", "can_catalog", "can_edit_others"].map(k => p[k]).join("|");
const byName = (a, b) => ((a && a.name) || "").localeCompare((b && b.name) || "");
// Quantités par unité native : « 120 · 30 SCU » (on n'additionne jamais des objets et des SCU).
function unitSums(rows, field = "quantity") { const m = {}; for (const r of rows) m[r.unit || ""] = num(m[r.unit || ""]) + num(r[field]); return m; }
const sumsText = m => Object.keys(m).length ? Object.entries(m).sort().map(([u, v]) => fmt(v) + unitTxt(u)).join(" · ") : "–";
const dateTxt = iso => iso ? new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
function resCell(r, fallback) {
  const img = r && okImg(r.image) ? `<img class="rimg" src="${esc(r.image)}" alt="">` : swatch(r && r.color);
  return `${img}<span class="res-name">${esc(r ? r.name : fallback || "Ressource supprimée")}${r && r.name_en ? ` <span class="muted" style="font-weight:400" lang="en">(${esc(r.name_en)})</span>` : ""}</span>`;
}
function memberOptions(sel, allLabel) {
  const cur = sel.value;
  const list = Object.values(st.profiles).filter(p => p.role !== "pending" && sameOrg(p)).sort((a, b) => a.pseudo.localeCompare(b.pseudo));
  sel.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : "")
    + list.map(p => `<option value="${esc(p.id)}">${esc(p.pseudo)}${st.me && p.id === st.me.id ? " (moi)" : ""}</option>`).join("");
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  else if (!allLabel && st.me) sel.value = st.me.id;
}
function locationOptions(sel, ids, allLabel) {
  const cur = sel.value;
  const locs = st.locations.filter(l => !ids || ids.has(l.id)).sort(byName);
  sel.innerHTML = `<option value="">${allLabel}</option>` + locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
}
// Lieux proposés : ceux déjà enregistrés, puis les stations et villes du jeu.
function renderPlaceLists() {
  const known = new Set(GAME_PLACES.map(p => ScanLogic.norm(p[0])));
  $("#placeList").innerHTML = st.locations.filter(l => !known.has(ScanLogic.norm(l.name))).map(l => `<option value="${esc(l.name)}" label="Déjà enregistré">`).join("")
    + GAME_PLACES.map(([n, w]) => `<option value="${esc(n)}" label="${esc(w)}">`).join("");
}
function renderAllStocks() {
  renderPlaceLists();
  memberOptions($("#capOwner"));
  $("#capOwnerBox").hidden = !can("edit_others");
  renderGlobal(); renderMine(); renderLegacy();
  if (!$("#reqView").hidden) renderRequests();
  if (st.items.length) renderReview();
}

// ---------- détail d'un minerai : qualités à sélectionner, puis qui la possède et où ----------
// Pseudos des détenteurs : « Matsu89, JoueurB » ; au-delà de max, « Matsu89, JoueurB +3 ».
function names(ss, max) {
  const l = [...new Set(ss.map(s => who(s.user_id)))].sort((a, b) => a.localeCompare(b));
  return max && l.length > max ? l.slice(0, max).join(", ") + " +" + (l.length - max) : l.join(", ");
}
const qSel = new Map();   // "portée:ressource" -> qualités sélectionnées (aucune = toutes)
function oreDetail(scope, id, ss, span, { withOwner = false, canEdit = false } = {}) {
  const byQ = new Map();
  for (const s of ss) { if (!byQ.has(s.quality_key)) byQ.set(s.quality_key, []); byQ.get(s.quality_key).push(s); }
  const ks = [...byQ.keys()].sort(byQdesc);
  const sel = new Set([...(qSel.get(scope + ":" + id) || [])].filter(k => byQ.has(k)));
  const attrs = `data-scope="${scope}" data-id="${esc(id)}"`;
  const picks = ks.map(k => {
    const g = byQ.get(k), on = sel.has(k), n = new Set(g.map(s => s.user_id)).size;
    return `<button type="button" class="qpick${on ? " on" : ""}${qVal(k) >= 700 ? " hi" : ""}" ${attrs} data-q="${esc(k)}" aria-pressed="${on}">`
      + `<b>${qLabel(k)}</b><span>${esc(sumsText(unitSums(g)))}</span>${withOwner ? `<small title="${esc(names(g))}">${esc(names(g, 2))}</small>` : ""}</button>`;
  }).join("");
  const rows = ss.filter(s => !sel.size || sel.has(s.quality_key)).sort((a, b) => qVal(b.quality_key) - qVal(a.quality_key)
    || (withOwner ? who(a.user_id).localeCompare(who(b.user_id)) : 0) || locName(a.location_id).localeCompare(locName(b.location_id)));
  const head = `<th>Qualité</th>${withOwner ? "<th>Membre</th>" : ""}<th>Lieu</th><th>Quantité</th><th>Mis à jour</th>${canEdit ? "<th></th>" : ""}`;
  const body = rows.map(s => `<tr><td class="num">${qLabel(s.quality_key)}</td>${withOwner ? `<td>${esc(who(s.user_id))}</td>` : ""}`
    + `<td>${esc(locName(s.location_id))}</td><td class="num"><strong>${fmt(s.quantity)}</strong>${esc(unitTxt(s.unit))}</td><td class="muted">${dateTxt(s.updated_at)}</td>`
    + `${canEdit ? `<td><button type="button" data-use="${s.id}">Mouvement</button></td>` : ""}</tr>`).join("");
  const hint = sel.size ? `${sel.size} qualité${sel.size > 1 ? "s" : ""} sélectionnée${sel.size > 1 ? "s" : ""} · <button type="button" class="linkbtn" ${attrs} data-q="*">Tout afficher</button>`
    : `${ks.length} qualité${ks.length > 1 ? "s" : ""} · clique sur une ou plusieurs qualités pour voir ${withOwner ? "qui la possède et où" : "où elle se trouve"}`;
  return `<tr class="detail"><td colspan="${span}"><div class="qpicks">${picks}</div><div class="muted qhint">${hint}</div>`
    + `<table class="sub"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></td></tr>`;
}
// Clic sur une qualité (sélection multiple) ou sur la ligne d'un minerai (ouvre / ferme).
function oreClicks(tbody, open, rerender) {
  tbody.addEventListener("click", e => {
    const q = e.target.closest("[data-q]");
    if (q) {
      const key = q.dataset.scope + ":" + q.dataset.id, sel = qSel.get(key) || new Set();
      if (q.dataset.q === "*") sel.clear(); else if (sel.has(q.dataset.q)) sel.delete(q.dataset.q); else sel.add(q.dataset.q);
      qSel.set(key, sel); rerender(); return;
    }
    if (e.target.closest("[data-use], a, input, select")) return;
    const row = e.target.closest("[data-open]"); if (!row) return;
    const id = row.dataset.open; if (open.has(id)) open.delete(id); else open.add(id);
    rerender();
  });
}

// ---------- chiffres de l'en-tête ----------
// Calculés sur ce que le compte peut voir (son organisation, ou son seul stock sans le droit « voir »).
function renderKpis() {
  const all = st.stocks.filter(s => num(s.quantity) > 0);
  $("#stCount").textContent = new Set(all.map(s => s.resource_id)).size;
  // On n'additionne jamais des SCU et des objets : SCU d'abord, objets en dessous.
  const scu = all.filter(s => /^scu$/i.test(s.unit || "")).reduce((t, s) => t + num(s.quantity), 0);
  const obj = all.filter(s => !s.unit).reduce((t, s) => t + num(s.quantity), 0);
  $("#stScu").textContent = scu || !obj ? fmt(scu) : fmt(obj);
  $("#stScuLbl").textContent = scu || !obj ? (obj ? `SCU · ${fmt(obj)} objets` : "SCU en stock") : "Objets en stock";
  $("#stHq").textContent = all.filter(s => s.quality_key !== "-" && +s.quality_key >= 700).length;
  const open = st.requests.filter(r => r.org_id === (st.me && st.me.org_id) && (r.status === "open" || r.status === "in_progress"));
  const urgent = open.filter(r => r.priority === "urgent" && r.status === "open").length;
  $("#stReqBox").hidden = !st.reqReady;
  $("#stReq").textContent = open.length;
  $("#stReqLbl").textContent = urgent ? `Demandes · ${urgent} urgente${urgent > 1 ? "s" : ""}` : "Demandes en cours";
  $("#stReqBox").classList.toggle("alert", urgent > 0);
  const week = Date.now() - 7 * 864e5;
  $("#stActive").textContent = new Set(st.scansMeta.filter(s => new Date(s.observed_at).getTime() >= week).map(s => s.user_id)).size;
  // « Sous le seuil » seulement si un seuil a été défini dans la base de données.
  const totalBy = {}; for (const s of all) totalBy[s.resource_id] = num(totalBy[s.resource_id]) + num(s.quantity);
  const withMin = st.resources.filter(r => r.threshold > 0);
  const low = withMin.filter(r => num(totalBy[r.id]) < r.threshold).length;
  $("#stLowBox").hidden = !withMin.length;
  $("#stLow").textContent = low;
  $("#stLowBox").classList.toggle("alert", low > 0);
}
$("#stReqBox").addEventListener("click", () => showTab("req"));

// ---------- inventaire global : somme des stocks personnels, jamais des anciens stocks ----------
const gOpen = new Set();
function stocksFiltered() {
  const q = norm($("#q").value), c = $("#cat").value, loc = $("#gLoc").value, mb = $("#gMember").value;
  const qmin = $("#gQmin").value === "" ? null : num($("#gQmin").value), qmax = $("#gQmax").value === "" ? null : num($("#gQmax").value);
  return st.stocks.filter(s => {
    if (!(num(s.quantity) > 0)) return false;
    const r = resOf(s.resource_id);
    if (q && !(r && (resMatch(r, q) || norm(r.category).includes(q)))) return false;
    if (c && (!r || r.category !== c)) return false;
    if (loc && s.location_id !== loc) return false;
    if (mb && s.user_id !== mb) return false;
    if (qmin !== null || qmax !== null) {
      if (s.quality_key === "-") return false;
      const v = +s.quality_key;
      if ((qmin !== null && v < qmin) || (qmax !== null && v > qmax)) return false;
    }
    return true;
  });
}
function renderGlobal() {
  const all = st.stocks.filter(s => num(s.quantity) > 0);
  const totalBy = {}; for (const s of all) totalBy[s.resource_id] = num(totalBy[s.resource_id]) + num(s.quantity);
  renderKpis();

  const cats = [...new Set(st.resources.map(r => r.category).filter(Boolean))].sort();
  const sel = $("#cat"), cur = sel.value;
  sel.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c => `<option${c === cur ? " selected" : ""}>${esc(c)}</option>`).join("");
  $("#catList").innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");
  locationOptions($("#gLoc"), new Set(all.map(s => s.location_id)), "Tous les lieux");
  memberOptions($("#gMember"), "Tous les membres");

  const byRes = new Map();
  for (const s of stocksFiltered()) { if (!byRes.has(s.resource_id)) byRes.set(s.resource_id, []); byRes.get(s.resource_id).push(s); }
  const list = [...byRes.entries()].map(([id, ss]) => ({ id, r: resOf(id), ss })).sort((a, b) => byName(a.r, b.r));
  $("#stockEmpty").hidden = list.length > 0;
  $("#stockBody").innerHTML = list.map(({ id, r, ss }) => {
    const lots = {}; for (const s of ss) lots[s.quality_key] = num(lots[s.quality_key]) + num(s.quantity);
    const aq = avgQ(lots), owners = new Set(ss.map(s => s.user_id)).size, places = new Set(ss.map(s => s.location_id)).size;
    const isLowRes = r && r.threshold > 0 && num(totalBy[id]) < r.threshold, open = gOpen.has(id);
    const detail = open ? oreDetail("g", id, ss, 5, { withOwner: true }) : "";
    return `<tr class="grp${isLowRes ? " low" : ""}${open ? " open" : ""}" data-open="${esc(id)}">
      <td>${resCell(r)}${r && r.category ? `<span class="chip">${esc(r.category)}</span>` : ""}${isLowRes ? ' <span class="pill low">Sous le seuil</span>' : ""}</td>
      <td><div class="qty">${esc(sumsText(unitSums(ss)))}</div></td>
      <td>${aq == null ? '<span class="muted">–</span>' : `<div class="qual">Q moy. ${aq}</div>`}${lotChips(lots)}</td>
      <td><span title="${esc(names(ss))}">${esc(names(ss, 3))}</span><div class="colordesc">${places} lieu${places > 1 ? "x" : ""}</div></td>
      <td><button type="button" aria-expanded="${open}">${open ? "Masquer" : "Qualités"}</button></td></tr>${detail}`;
  }).join("");
}
oreClicks($("#stockBody"), gOpen, () => renderGlobal());
["#q", "#gQmin", "#gQmax"].forEach(s => $(s).addEventListener("input", renderGlobal));
["#cat", "#gLoc", "#gMember"].forEach(s => $(s).addEventListener("change", renderGlobal));
$("#gExport").addEventListener("click", () => exportStocks(stocksFiltered(), false));

function exportStocks(rows, withLegacy) {
  const out = [["Membre", "Lieu", "Ressource", "Catégorie", "Qualité", "Quantité", "Unité", "Mis à jour"]];
  const sorted = rows.slice().sort((a, b) => who(a.user_id).localeCompare(who(b.user_id)) || locName(a.location_id).localeCompare(locName(b.location_id)) || byName(resOf(a.resource_id), resOf(b.resource_id)));
  for (const s of sorted) {
    const r = resOf(s.resource_id);
    out.push([who(s.user_id), locName(s.location_id), r ? r.name : "", r ? r.category : "", s.quality_key === "-" ? "" : s.quality_key,
      frNum(s.quantity), s.unit, new Date(s.updated_at).toLocaleString("fr-FR")]);
  }
  if (withLegacy) for (const l of st.legacy.filter(x => x.status === "open"))
    out.push(["(ancien stock non attribué)", l.place_name || "Non précisé", l.resource_name, "", l.quality_key === "-" ? "" : l.quality_key, frNum(l.quantity), "", ""]);
  download(`stocks-${today()}.csv`, csv(out), "text/csv;charset=utf-8");
}

// ---------- mon inventaire (ou celui d'un autre membre, en lecture) ----------
const mineOwner = () => $("#mOwner").value || (st.me && st.me.id);
const mOpen = new Set();
const canEditOwner = id => !!st.me && (id === st.me.id || can("edit_others"));
function renderMine() {
  memberOptions($("#mOwner"));
  const owner = mineOwner(), self = !!st.me && owner === st.me.id;
  $("#mineTitle").textContent = self ? "Mon inventaire" : "Inventaire de " + who(owner);
  const mine = st.stocks.filter(s => s.user_id === owner);
  const ids = new Set(mine.filter(s => num(s.quantity) > 0).map(s => s.location_id));
  locationOptions($("#mLoc"), ids, self ? "Tous mes lieux" : "Tous ses lieux");
  const loc = $("#mLoc").value;
  const rows = mine.filter(s => num(s.quantity) > 0 && (!loc || s.location_id === loc));
  const canEdit = canEditOwner(owner);
  $("#mineEmpty").hidden = rows.length > 0;
  // Une ligne par minerai ; ses qualités et ses lieux se déplient au clic.
  const byRes = new Map();
  for (const s of rows) { if (!byRes.has(s.resource_id)) byRes.set(s.resource_id, []); byRes.get(s.resource_id).push(s); }
  const list = [...byRes.entries()].map(([id, ss]) => ({ id, r: resOf(id), ss })).sort((a, b) => byName(a.r, b.r));
  $("#mineBody").innerHTML = list.map(({ id, r, ss }) => {
    const lots = {}; for (const s of ss) lots[s.quality_key] = num(lots[s.quality_key]) + num(s.quantity);
    const places = [...new Set(ss.map(s => locName(s.location_id)))].sort();
    const upd = ss.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), ""), open = mOpen.has(id), aq = avgQ(lots);
    return `<tr class="grp${open ? " open" : ""}" data-open="${esc(id)}">
      <td>${resCell(r)}</td>
      <td>${places.length > 2 ? `${places.length} lieux` : esc(places.join(", "))}</td>
      <td>${aq == null ? "" : `<div class="qual">Q moy. ${aq}</div>`}${lotChips(lots)}</td>
      <td class="num"><strong>${esc(sumsText(unitSums(ss)))}</strong></td><td class="muted">${dateTxt(upd)}</td>
      <td><button type="button" aria-expanded="${open}">${open ? "Masquer" : "Qualités"}</button></td></tr>`
      + (open ? oreDetail("m" + owner, id, ss, 6, { canEdit, withOwner: true }) : "");
  }).join("");
  // Date du dernier relevé fiable, par lieu.
  const last = new Map();
  for (const sc of st.scansMeta) if (sc.user_id === owner && !last.has(sc.location_id)) last.set(sc.location_id, sc);
  const shown = [...ids].filter(id => !loc || id === loc).sort((a, b) => locName(a).localeCompare(locName(b)));
  $("#mineScans").hidden = !shown.length;
  $("#mineScans").innerHTML = shown.map(id => {
    const sc = last.get(id);
    return `<span class="chip">${esc(locName(id))} · ${sc ? `dernier relevé ${dateTxt(sc.observed_at)}${sc.coverage_status === "complete" ? " (complet)" : ""}` : "aucun relevé par capture"}</span>`;
  }).join("");
  $("#moveForm").hidden = !canEdit;
  const rs = $("#mvRes"), cur = rs.value;
  rs.innerHTML = st.resources.slice().sort(byName).map(r => `<option value="${esc(r.id)}">${esc(r.name)}${r.name_en && norm(r.name_en) !== norm(r.name) ? " (" + esc(r.name_en) + ")" : ""}</option>`).join("");
  if (cur && st.resources.some(r => r.id === cur)) rs.value = cur;
  if (!$("#mvPlace").value) $("#mvPlace").value = loc ? locName(loc) : $("#capPlace").value;
  renderMvLots();
}
$("#mOwner").addEventListener("change", () => { renderMine(); loadMyMoves(); });
$("#mLoc").addEventListener("change", () => { $("#mvPlace").value = $("#mLoc").value ? locName($("#mLoc").value) : $("#mvPlace").value; renderMine(); });
oreClicks($("#mineBody"), mOpen, () => renderMine());
$("#mineBody").addEventListener("click", e => {
  const b = e.target.closest("[data-use]"); if (!b) return;
  const s = st.stocks.find(x => String(x.id) === b.dataset.use); if (!s) return;
  $("#mvRes").value = s.resource_id; $("#mvPlace").value = locName(s.location_id);
  $("#mvQ").value = s.quality_key === "-" ? "" : s.quality_key; $("#mvUnit").value = s.unit;
  mvReset(); renderMvLots();
  $("#moveForm").scrollIntoView({ block: "nearest" }); $("#mvQty").focus();
});
// ---------- déclarer un mouvement : aperçu, puis confirmation ----------
// L'identifiant d'opération est créé à l'aperçu et réutilisé tant que l'opération n'a pas réussi :
// un double clic ou une nouvelle tentative après une coupure réseau ne l'applique jamais deux fois.
const mvType = () => (document.querySelector("input[name=mvType]:checked") || {}).value || "remove";
function showMvType() {
  const t = mvType();
  $("#mvKindBox").hidden = !MV_KINDS[t];
  if (MV_KINDS[t]) {
    const cur = $("#mvKind").value;
    $("#mvKind").innerHTML = MV_KINDS[t].map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join("");
    if (MV_KINDS[t].some(([k]) => k === cur)) $("#mvKind").value = cur;
  }
  $("#mvToPlaceBox").hidden = $("#mvToOwnerBox").hidden = t !== "transfer";
  $("#mvPlaceLbl").textContent = t === "transfer" ? "Depuis le lieu" : "Lieu";
  $("#mvNote").placeholder = t === "set" ? "Motif de la correction (obligatoire)" : "Facultative";
  $("#mvGo").textContent = "Vérifier";
  if (t === "transfer") memberOptions($("#mvToOwner"));
  renderMvLots();
}
document.querySelectorAll("input[name=mvType]").forEach(r => r.addEventListener("change", () => { mvReset(); showMvType(); }));
// Lots existants du membre pour la ressource et le lieu choisis : un clic remplit qualité et unité exactes.
function renderMvLots() {
  const owner = mineOwner(), res = $("#mvRes").value, slug = norm($("#mvPlace").value);
  const lots = st.stocks.filter(s => s.user_id === owner && s.resource_id === res && num(s.quantity) > 0
    && (!slug || norm(locName(s.location_id)) === slug)).sort((a, b) => qVal(b.quality_key) - qVal(a.quality_key));
  $("#mvLots").innerHTML = lots.length && mvType() !== "add"
    ? `<span class="muted" style="font-size:13px;align-self:center">Lots disponibles :</span>` + lots.map(s =>
      `<button type="button" class="chip pick" data-lot="${s.id}">${esc(locName(s.location_id))} · ${qLabel(s.quality_key)} · ${fmt(s.quantity)}${esc(unitTxt(s.unit) || " objets")}</button>`).join("")
    : "";
}
$("#mvLots").addEventListener("click", e => {
  const b = e.target.closest("[data-lot]"); if (!b) return;
  const s = st.stocks.find(x => String(x.id) === b.dataset.lot); if (!s) return;
  $("#mvPlace").value = locName(s.location_id); $("#mvQ").value = s.quality_key === "-" ? "" : s.quality_key; $("#mvUnit").value = s.unit;
  mvReset(); $("#mvQty").focus();
});
function mvReset() { st.mvPending = null; $("#mvPreview").hidden = true; $("#mvGo").hidden = false; }
["#mvRes", "#mvPlace", "#mvQ", "#mvUnit", "#mvQty", "#mvKind", "#mvToPlace", "#mvToOwner", "#mvNote"].forEach(sel =>
  $(sel).addEventListener("input", () => { mvReset(); if (sel === "#mvRes" || sel === "#mvPlace") renderMvLots(); }));
$("#mvRes").addEventListener("change", renderMvLots);
function mvPayload() {
  const t = mvType(), owner = mineOwner(), base = { resource_id: $("#mvRes").value, quality_key: $("#mvQ").value, unit: $("#mvUnit").value.trim(),
    quantity: num($("#mvQty").value), note: $("#mvNote").value.trim() };
  if (t === "transfer") return { fn: "transfer_stock", p: { ...base, from_owner: owner === st.me.id ? null : owner, from_location: $("#mvPlace").value.trim(),
    to_location: ($("#mvToPlace").value || $("#mvPlace").value).trim(), to_owner: $("#mvToOwner").value || null } };
  return { fn: "adjust_stock", p: { ...base, owner_id: owner === st.me.id ? null : owner, location: $("#mvPlace").value.trim(), mode: t,
    kind: t === "set" ? null : $("#mvKind").value } };
}
const qtyTxt = (v, u) => fmt(v) + (u ? " " + u : " objets");
function renderMvPreview(r, fn) {
  const lot = `${esc(r.name)} ${qLabel(r.quality_key)} · ${esc(r.unit || "objets")}`;
  let html;
  if (fn === "transfer_stock") {
    html = `<div>${lot}</div><div class="big">${esc(locName(r.from.location_id))}${r.from.owner_id !== r.to.owner_id ? " (" + esc(who(r.from.owner_id)) + ")" : ""} : ${fmt(r.from.before)} → ${fmt(r.from.after)}</div>
      <div class="big">${esc(locName(r.to.location_id))}${r.from.owner_id !== r.to.owner_id ? " (" + esc(who(r.to.owner_id)) + ")" : ""} : ${fmt(r.to.before)} → ${fmt(r.to.after)}</div>
      <div class="muted">Transfert de ${qtyTxt(r.quantity, r.unit)} : le total de l'organisation ne change pas.</div>`;
  } else {
    html = `<div>${lot} · ${esc(locName(r.location_id))}${r.owner_id !== st.me.id ? " · inventaire de " + esc(who(r.owner_id)) : ""} · ${esc(KIND[r.kind] || r.kind)}</div>
      <div class="big">Avant ${fmt(r.before)} · ${r.delta > 0 ? "+" : r.delta < 0 ? "−" : ""}${fmt(Math.abs(r.delta))} · Après ${fmt(r.after)}</div>`;
  }
  $("#mvPreviewText").innerHTML = html;
  const sim = (r.similar || []);
  $("#mvWarn").hidden = !sim.length;
  $("#mvWarn").textContent = sim.length ? "Doublon possible : " + sim.map(m => `${m.delta > 0 ? "+" : ""}${fmt(m.delta)} (${KIND[m.kind] || m.kind}${m.scan ? ", constaté par capture" : ""}) ${ago(m.at)}`).join(" ; ")
    + (sim.some(m => m.unclassified) ? ". Si c'est la même opération, classe plutôt la variation dans la liste des mouvements au lieu de la déclarer une deuxième fois." : ". Confirme seulement s'il s'agit d'une nouvelle opération.") : "";
  $("#mvPreview").hidden = false; $("#mvGo").hidden = true;
  $("#mvConfirm").focus();
}
$("#moveForm").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#mvMsg"), { fn, p } = mvPayload();
  $("#mvGo").disabled = true; m.textContent = ""; m.className = "formmsg";
  try {
    const r = await rpc(fn, { p: { ...p, dry_run: true } });
    // L'aperçu fixe la quantité de départ : si le stock change avant la confirmation, le serveur refuse.
    st.mvPending = { fn, p: { ...p, operation_id: crypto.randomUUID(), expected_before: fn === "transfer_stock" ? r.from.before : r.before } };
    renderMvPreview(r, fn);
  } catch (err) { m.textContent = errText(err); m.className = "formmsg err"; }
  $("#mvGo").disabled = false;
});
$("#mvEdit").addEventListener("click", () => { mvReset(); $("#mvQty").focus(); });
$("#mvConfirm").addEventListener("click", async () => {
  const pend = st.mvPending, m = $("#mvMsg"); if (!pend) return;
  $("#mvConfirm").disabled = true; m.textContent = "Enregistrement…"; m.className = "formmsg";
  try {
    const r = await rpc(pend.fn, { p: pend.p });
    m.textContent = pend.fn === "transfer_stock"
      ? `Transfert enregistré : ${fmt(r.from.before)} → ${fmt(r.from.after)} à ${locName(r.from.location_id)}, ${fmt(r.to.before)} → ${fmt(r.to.after)} à ${locName(r.to.location_id)}.`
      : r.unchanged ? "Aucun changement : la quantité est déjà celle-ci." : `Mouvement enregistré (${KIND[r.kind] || r.kind}) : ${fmt(r.before)} → ${fmt(r.after)}.`;
    if (r.replayed) m.textContent += " (déjà enregistré : rien n'a été appliqué deux fois)";
    m.className = "formmsg ok"; $("#mvQty").value = ""; $("#mvNote").value = ""; mvReset();
    await loadStocks(); loadMyMoves();
  } catch (err) {
    const t = errText(err);
    if (/STATE_CHANGED/.test(t)) { mvReset(); m.textContent = t.replace(/^STATE_CHANGED:\s*/, "") + " Clique sur « Vérifier »."; }
    // Erreur réseau : on garde le même identifiant, « Confirmer » peut être relancé sans risque de doublon.
    else m.textContent = t + (/fetch|network|réseau|Failed/i.test(t) ? " Tu peux cliquer à nouveau sur « Confirmer » : l'opération ne sera appliquée qu'une fois." : "");
    m.className = "formmsg err";
  }
  $("#mvConfirm").disabled = false;
});
showMvType();

// Mouvements du membre affiché ; une hausse ou une baisse d'origine inconnue peut être classée après coup.
let movesReq = 0;
async function loadMyMoves() {
  const owner = mineOwner(); if (!owner || !st.v2) return;
  const req = ++movesReq;
  const { data, error } = await sb.from("movements").select("*").eq("owner_id", owner).order("at", { ascending: false }).limit(50);
  if (error || req !== movesReq) return;
  st.myMoves = data || []; renderMyMoves();
}
// Annulable par mouvement compensatoire : saisie manuelle, correction ou transfert, pas encore annulé.
const canReverse = m => !m.undone_at && !m.reverses_id && ["stock", "correction", "transfer"].includes(m.mode)
  && !["initial", "legacy_attribution"].includes(m.kind) && num(m.delta) !== 0;
function renderMyMoves() {
  const canEdit = canEditOwner(mineOwner());
  $("#myMovesEmpty").hidden = st.myMoves.length > 0;
  $("#myMoves").innerHTML = st.myMoves.map(m => {
    const d = num(m.delta), open = (m.kind === "increase" || m.kind === "decrease") && !m.undone_at && !m.reverses_id && !m.transfer_id;
    const opts = (d > 0 ? INC_KINDS : DEC_KINDS).map(k => `<option value="${k}">${KIND[k]}</option>`).join("");
    const rev = st.revOpen === m.id;
    const tags = (m.reverses_id ? ' · <span class="tag">Annulation</span>' : "") + (m.undone_at ? ' · <span class="tag">Annulé</span>' : "")
      + (m.transfer_id && !m.reverses_id ? ' · <span class="tag">Transfert lié</span>' : "");
    return `<li class="${m.undone_at ? "undone" : ""}"><div><span class="d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${fmt(d)}${esc(unitTxt(m.unit))}</span> · <strong>${esc(m.name)}</strong> <span class="muted">${qLabel(m.quality_key)}</span></div>
      <div class="meta">${esc(locName(m.location_id))} · <span class="tag${open ? " warn" : ""}">${esc(KIND[m.kind] || m.kind || "")}</span>${tags}${m.note ? " · " + esc(m.note) : ""}</div>
      ${open && canEdit ? `<div class="meta"><select data-classify="${m.id}" aria-label="Préciser la nature du mouvement"><option value="">Préciser la nature…</option>${opts}</select></div>` : ""}
      <div class="meta">${fmt(m.before)} → ${fmt(m.after)} · ${m.by && m.by !== m.owner_id ? "par " + esc(who(m.by)) + " · " : ""}${ago(m.at)}
        ${canEdit && canReverse(m) && !rev ? ` · <button type="button" class="linkbtn" data-rev="${m.id}">Annuler…</button>` : ""}</div>
      ${rev ? `<div class="revbox"><input type="text" id="revNote" maxlength="200" placeholder="Motif de l'annulation (obligatoire)" aria-label="Motif de l'annulation">
        <button type="button" class="danger" data-revgo="${m.id}">Annuler ce mouvement${m.transfer_id ? " (et son transfert lié)" : ""}</button><button type="button" data-revno>Garder</button></div>` : ""}</li>`;
  }).join("");
  if (st.revOpen) { const i = $("#revNote"); if (i) i.focus(); }
}
$("#myMoves").addEventListener("click", async e => {
  const open = e.target.closest("[data-rev]"), go = e.target.closest("[data-revgo]"), no = e.target.closest("[data-revno]");
  if (open) { st.revOpen = Number(open.dataset.rev); st.revOp = { id: st.revOpen, op: crypto.randomUUID() }; return renderMyMoves(); }
  if (no) { st.revOpen = null; return renderMyMoves(); }
  if (!go) return;
  const id = Number(go.dataset.revgo), note = ($("#revNote") || {}).value || "";
  if (!note.trim()) { setStatus("Indique le motif de l'annulation."); return; }
  if (!st.revOp || st.revOp.id !== id) st.revOp = { id, op: crypto.randomUUID() };
  go.disabled = true;
  try {
    // Même identifiant si on réessaie après une erreur réseau : jamais deux annulations.
    await rpc("reverse_movement", { p: { operation_id: st.revOp.op, movement_id: id, note: note.trim() } });
    st.revOpen = null; st.revOp = null; setStatus("");
    await loadStocks(); loadMyMoves();
  } catch (err) { setStatus(errText(err)); go.disabled = false; }
});
$("#myMoves").addEventListener("change", async e => {
  const s = e.target.closest("[data-classify]"); if (!s || !s.value) return;
  s.disabled = true;
  try { await rpc("classify_movement", { p_id: Number(s.dataset.classify), p_kind: s.value }); setStatus(""); await loadMyMoves(); }
  catch (err) { setStatus(errText(err)); s.disabled = false; }
});

// ---------- anciens stocks non attribués (rapprochement par un administrateur) ----------
function renderLegacy() {
  const open = st.legacy.filter(l => l.status === "open").sort((a, b) => a.resource_name.localeCompare(b.resource_name) || a.place_name.localeCompare(b.place_name));
  $("#legacyPanel").hidden = !open.length;
  $("#legacyTotal").textContent = open.length ? `${open.length} ligne${open.length > 1 ? "s" : ""} · ${fmt(open.reduce((t, l) => t + num(l.quantity), 0))} unités` : "";
  const members = Object.values(st.profiles).filter(p => p.role !== "pending").sort((a, b) => a.pseudo.localeCompare(b.pseudo))
    .map(p => `<option value="${esc(p.id)}">${esc(p.pseudo)}</option>`).join("");
  $("#legacyBody").innerHTML = open.map(l => `<tr data-lid="${l.id}">
    <td>${resCell(resOf(l.resource_id), l.resource_name)}</td><td>${l.place_name ? esc(l.place_name) : '<span class="muted">Non précisé</span>'}</td>
    <td class="num">${qLabel(l.quality_key)}</td><td class="num">${fmt(l.quantity)}</td>
    <td>${isOwner() ? `<div class="acts legacy-acts"><select id="lg-who-${l.id}" aria-label="Membre"><option value="">Attribuer à…</option>${members}</select>${l.location_id ? "" : `<input type="text" id="lg-loc-${l.id}" list="placeList" placeholder="Lieu" aria-label="Lieu">`}<button type="button" data-legacy="attribute">Attribuer</button><button type="button" data-legacy="archive" title="Déjà compté dans un inventaire personnel, ou obsolète">Archiver</button></div>` : ""}</td></tr>`).join("");
}
$("#legacyBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-legacy]"); if (!b) return;
  const id = Number(b.closest("tr").dataset.lid), action = b.dataset.legacy;
  const owner = action === "attribute" ? $(`#lg-who-${id}`).value : null;
  if (action === "attribute" && !owner) return setStatus("Choisis le membre à qui attribuer ce stock.");
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
  b.disabled = true;
  try {
    await rpc("resolve_legacy", { p_id: id, p_action: action, p_owner: owner || null, p_location: ($(`#lg-loc-${id}`) || {}).value || null, p_note: "" });
    setStatus(""); await loadStocks();
  } catch (err) { setStatus(errText(err)); b.disabled = false; b.classList.remove("armed"); b.textContent = action === "attribute" ? "Attribuer" : "Archiver"; }
});

// ---------- contributions ----------
const CAT = {
  production: ["production"], other_in: ["refined", "deposit", "transfer_in", "purchase", "legacy_attribution"], unknown_in: ["increase"],
  out: ["withdrawal", "sale", "delivery", "transfer_out", "refining", "consumption", "loss"], unknown_out: ["decrease"],
  initial: ["initial"], correction: ["correction"],
};
async function loadStats() {
  if (!st.v2) return;
  const from = $("#sFrom").value, to = $("#sTo").value, mb = $("#sMember").value, out = [];
  for (let p = 0; p < 20; p++) {
    let q = sb.from("movements").select("owner_id, location_id, name, unit, quality_key, delta, kind, at")
      .not("owner_id", "is", null).order("at", { ascending: false }).range(p * 1000, p * 1000 + 999);
    if (from) q = q.gte("at", new Date(from + "T00:00:00").toISOString());
    if (to) q = q.lte("at", new Date(to + "T23:59:59").toISOString());
    if (mb) q = q.eq("owner_id", mb);
    const { data, error } = await q;
    if (error) return setStatus(errText(error));
    out.push(...data); if (data.length < 1000) break;
  }
  renderStats(out);
}
function renderStats(ms) {
  const by = new Map();
  for (const m of ms) {
    const cat = Object.keys(CAT).find(c => CAT[c].includes(m.kind)); if (!cat) continue;
    if (!by.has(m.owner_id)) by.set(m.owner_id, {});
    const row = by.get(m.owner_id);
    (row[cat] = row[cat] || []).push({ unit: m.unit, v: cat === "out" || cat === "unknown_out" ? -num(m.delta) : num(m.delta) });
  }
  const cell = list => list ? esc(sumsText(unitSums(list, "v"))) : '<span class="muted">–</span>';
  $("#statsBody").innerHTML = [...by.entries()].sort((a, b) => who(a[0]).localeCompare(who(b[0]))).map(([o, r]) =>
    `<tr><td><strong>${esc(who(o))}</strong></td><td>${cell(r.production)}</td><td>${cell(r.other_in)}</td><td>${cell(r.unknown_in)}</td><td>${cell(r.out)}</td><td>${cell(r.unknown_out)}</td><td class="muted">${cell(r.initial)}</td><td>${cell(r.correction)}</td></tr>`
  ).join("") || '<tr><td colspan="8" class="muted">Aucun mouvement sur cette période.</td></tr>';
  const ins = ms.filter(m => num(m.delta) > 0 && m.kind !== "initial" && m.kind !== "correction");
  $("#contribCount").textContent = `${ins.length} apport${ins.length > 1 ? "s" : ""}${ins.length > 500 ? " (500 premiers affichés)" : ""}`;
  $("#contribBody").innerHTML = ins.slice(0, 500).map(m => `<tr><td class="num">${dateTxt(m.at)}</td><td>${esc(who(m.owner_id))}</td><td>${esc(m.name)}</td><td>${esc(locName(m.location_id))}</td><td class="num">${qLabel(m.quality_key)}</td><td class="num up">+${fmt(m.delta)}${esc(unitTxt(m.unit))}</td><td><span class="tag${m.kind === "increase" ? " warn" : ""}">${esc(KIND[m.kind] || m.kind)}</span></td></tr>`).join("")
    || '<tr><td colspan="7" class="muted">Aucun apport sur cette période.</td></tr>';
}
$("#sGo").addEventListener("click", loadStats);
$("#sTo").value = new Date().toISOString().slice(0, 10);
$("#sFrom").value = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);

// ---------- fiche ressource (catalogue : les quantités sont dans les inventaires des membres) ----------
const dlg = $("#dlg");
let editing = null;
function openDialog(r) {
  editing = r || null;
  $("#dlgTitle").textContent = r ? "Modifier " + r.name : "Nouvelle ressource";
  $("#fName").value = r ? r.name : "";
  $("#fCat").value = r ? r.category || "" : "";
  $("#fUnit").value = r ? r.unit || "" : "";
  $("#fMin").value = r && r.threshold ? r.threshold : "";
  $("#fColor").value = (r && okHex(r.color)) || "#888888";
  $("#fColor").dataset.touched = r && okHex(r.color) ? "1" : "";
  $("#fColorName").value = r ? r.color_name || "" : "";
  const del = $("#fDelete"); del.hidden = !r; del.classList.remove("armed"); del.textContent = "Supprimer";
  dlg.showModal(); $("#fName").focus();
}
$("#addRes").addEventListener("click", () => openDialog(null));
$("#fCancel").addEventListener("click", () => dlg.close());
$("#fColor").addEventListener("input", e => { e.target.dataset.touched = "1"; });
$("#fDelete").addEventListener("click", async e => {
  const b = e.currentTarget;
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer la suppression"; return; }
  const r = editing; dlg.close();
  try { await rpc("delete_resource", { p_id: r.id }); } catch (err) { setStatus(errText(err)); }
});
$("#resForm").addEventListener("submit", async e => {
  e.preventDefault();
  const v = {
    name: $("#fName").value.trim(), category: $("#fCat").value.trim(), unit: $("#fUnit").value.trim(), threshold: num($("#fMin").value),
    color: $("#fColor").dataset.touched ? $("#fColor").value : "", color_name: $("#fColorName").value.trim(),
  };
  if (!v.name) return;
  const r = editing;
  if (!r && resByName(v.name)) { $("#fName").setCustomValidity("Cette ressource existe déjà."); $("#fName").reportValidity(); $("#fName").setCustomValidity(""); return; }
  $("#fSave").disabled = true;
  try {
    // Mise à jour du catalogue seulement : un écart vide ne crée aucun mouvement de stock.
    if (r) await applyLots(r, "add", {}, "correction", "", { name: v.name, category: v.category, unit: v.unit, threshold: v.threshold, color: okHex(v.color), color_name: v.color_name });
    else await createResource(v, "manuel", "");
    dlg.close();
  } catch (err) { dlg.close(); setStatus(errText(err)); }
  $("#fSave").disabled = false;
});

// ---------- journal ----------
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return "il y a " + Math.floor(s / 60) + " min";
  if (s < 86400) return "il y a " + Math.floor(s / 3600) + " h";
  return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
const modeLabel = { add: "Entrée", remove: "Sortie", set: "Inventaire", create: "Création", delete: "Suppression", merge: "Fusion", undo: "Annulation",
  scan: "Capture", stock: "Mouvement", correction: "Correction", legacy: "Attribution" };
function renderLog() {
  $("#logEmpty").hidden = st.moves.length > 0;
  $("#log").innerHTML = st.moves.map(m => {
    const d = m.delta != null ? num(m.delta) : num(m.after) - num(m.before);
    const by = (st.profiles[m.by] && st.profiles[m.by].pseudo) || "Un membre";
    const whose = m.owner_id ? `${esc(who(m.owner_id))} · ${esc(locName(m.location_id))} · ${qLabel(m.quality_key)}` : "Ancien registre (non attribué)";
    const label = m.kind ? KIND[m.kind] || m.kind : modeLabel[m.mode] || m.mode;
    return `<li><div><span class="d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${fmt(d)}${esc(unitTxt(m.unit))}</span> · <strong>${esc(m.name)}</strong></div>
      <div class="meta">${whose}</div>
      <div class="meta"><span class="num">${fmt(m.before)} → ${fmt(m.after)}</span> · ${esc(label)}${m.source === "capture" ? " par capture" : ""}${m.note ? " · " + esc(m.note) : ""}</div>
      <div class="meta">${m.owner_id && m.by !== m.owner_id ? "par " : ""}${esc(by)} · ${ago(m.at)}</div></li>`;
  }).join("");
}

// ---------- membres (admin) ----------
const roleLabel = { pending: "En attente", member: "Membre", admin: "Administrateur" };
const PERMS = [["view_global", "Voir l'inventaire global"], ["scan", "Analyser des captures (IA)"], ["catalog", "Gérer le catalogue"], ["edit_others", "Modifier les stocks des autres"]];
function renderMembers() {
  const owner = isOwner(), all = Object.values(st.profiles);
  $("#orgBox").hidden = !owner;
  if (owner) {
    const n = id => all.filter(p => p.org_id === id).length;
    $("#orgList").innerHTML = st.orgs.map(o => `<div class="org-row" data-org="${esc(o.id)}">
      <input type="text" value="${esc(o.name)}" maxlength="60" aria-label="Nom de l'organisation ${esc(o.name)}">
      <span class="muted">${n(o.id)} compte${n(o.id) > 1 ? "s" : ""}</span>
      <button type="button" data-org-act="rename">Renommer</button>
      ${n(o.id) ? "" : '<button type="button" class="danger" data-org-act="del">Supprimer</button>'}</div>`).join("") || '<div class="muted">Aucune organisation.</div>';
  }
  const gkey = p => p.role === "pending" && !p.is_owner ? "0" : "1" + (orgName(p.org_id) || "~");
  const list = all.filter(p => owner || p.org_id === st.me.org_id)
    .sort((x, y) => gkey(x).localeCompare(gkey(y)) || x.pseudo.localeCompare(y.pseudo));
  const orgOpts = sel => '<option value="">Choisir l\'organisation…</option>' + st.orgs.map(o => `<option value="${esc(o.id)}"${o.id === sel ? " selected" : ""}>${esc(o.name)}</option>`).join("");
  let last = null;
  $("#membList").innerHTML = list.map(p => {
    const self = p.id === st.me.id, locked = self || (p.is_owner && !owner), pend = p.role === "pending" && !p.is_owner;
    const full = p.is_owner || p.role === "admin", k = gkey(p);
    const head = k !== last ? `<div class="memb-group">${pend ? "Demandes en attente" : esc(orgName(p.org_id) || "Sans organisation")}</div>` : "";
    last = k;
    const sub = pend ? (p.org_id ? ` · demande à rejoindre ${esc(orgName(p.org_id))}` : " · n'a pas encore choisi d'organisation") : "";
    return head + `<div class="memb-row" data-id="${esc(p.id)}">
      <div class="who"><strong>${esc(p.pseudo)}${self ? " (toi)" : ""}</strong><span>Inscrit le ${new Date(p.created_at).toLocaleDateString("fr-FR")}${sub}</span></div>
      ${locked ? `<span class="role admin">${p.is_owner ? "Propriétaire" : roleLabel[p.role]}</span>` : `<div class="row">
        ${pend ? '<button type="button" class="primary" data-act="validate">Valider</button>' : ""}
        ${owner ? `<select data-f="org" aria-label="Organisation de ${esc(p.pseudo)}">${orgOpts(p.org_id)}</select>` : ""}
        <select data-f="role" aria-label="Rôle de ${esc(p.pseudo)}">${Object.entries(roleLabel).map(([v, l]) => `<option value="${v}"${v === p.role ? " selected" : ""}>${l}</option>`).join("")}</select>
        <button type="button" class="danger" data-act="remove">${pend ? "Refuser" : "Retirer"}</button>
      </div>`}
      ${pend ? "" : `<div class="perms">${PERMS.map(([pk, l]) => `<label class="perm"><input type="checkbox" data-perm="${pk}"${full || p["can_" + pk] ? " checked" : ""}${full || locked ? " disabled" : ""}>${l}</label>`).join("")}
        ${full ? '<span class="muted perm-note">Administrateur : tous les droits</span>' : ""}</div>`}
    </div>`;
  }).join("") || '<div class="muted" style="padding:16px 20px">Aucun membre.</div>';
}
function membMsg(t, ok) { const m = $("#membMsg"); m.textContent = t; m.className = "formmsg " + (ok ? "ok" : "err"); }
async function setMember(id, patch) {
  try { await rpc("set_member", { p_id: id, p: patch }); membMsg("Modification enregistrée.", true); }
  catch (err) { membMsg(errText(err)); }
  await loadProfiles();
  renderMembers();
}
$("#openMembers").addEventListener("click", () => { $("#membMsg").textContent = ""; renderMembers(); $("#members").showModal(); });
$("#closeMembers").addEventListener("click", () => $("#members").close());
$("#membList").addEventListener("click", e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const row = b.closest(".memb-row"), id = row.dataset.id, p = st.profiles[id];
  if (b.dataset.act === "validate") {
    const org = row.querySelector('[data-f="org"]');
    const orgId = org ? org.value : p.org_id;
    if (!orgId) return membMsg("Choisis d'abord l'organisation de ce membre.");
    return setMember(id, { role: "member", org_id: orgId });
  }
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
  // Retirer : le compte repasse en attente, sans organisation ; ses stocks sont conservés.
  setMember(id, { role: "pending", org_id: null });
});
$("#membList").addEventListener("change", e => {
  const row = e.target.closest(".memb-row"); if (!row) return;
  const id = row.dataset.id, t = e.target;
  if (t.dataset.f === "role") {
    const org = row.querySelector('[data-f="org"]');
    setMember(id, t.value !== "pending" && org && org.value ? { role: t.value, org_id: org.value } : { role: t.value });
  } else if (t.dataset.f === "org") {
    if (st.profiles[id].role === "pending") return;   // appliqué au moment de « Valider »
    setMember(id, { org_id: t.value || null, ...(t.value ? {} : { role: "pending" }) });
  } else if (t.dataset.perm) setMember(id, { ["can_" + t.dataset.perm]: t.checked });
});
// Organisations (propriétaire du site)
$("#orgAdd").addEventListener("click", async () => {
  const n = $("#orgName").value.trim(); if (!n) return membMsg("Indique le nom de l'organisation.");
  try { await rpc("create_organization", { p_name: n }); $("#orgName").value = ""; membMsg(`Organisation « ${n} » créée.`, true); }
  catch (err) { membMsg(errText(err)); }
  await loadOrgs();
});
$("#orgList").addEventListener("click", async e => {
  const b = e.target.closest("[data-org-act]"); if (!b) return;
  const row = b.closest(".org-row"), id = row.dataset.org;
  try {
    if (b.dataset.orgAct === "rename") { await rpc("rename_organization", { p_id: id, p_name: row.querySelector("input").value.trim() }); membMsg("Organisation renommée.", true); }
    else {
      if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
      await rpc("delete_organization", { p_id: id }); membMsg("Organisation supprimée.", true);
    }
  } catch (err) { membMsg(errText(err)); }
  await loadOrgs();
});

// ---------- capture ----------
const drop = $("#drop");
function capMsg(t, err) { const el = $("#capMsg"); el.textContent = t; el.className = err ? "err" : "muted"; }
// Plusieurs captures (pages d'inventaire) : chacune est analysée séparément, les lots s'additionnent.
const MAX_SHOTS = 12;
let shotSeq = 0;
function addImages(files) {
  // Vidéo (survol des caisses) : lecture gratuite des infobulles, image par image.
  for (const f of [...(files || [])].filter(f => f && f.type && f.type.startsWith("video/"))) ocr.queue = (ocr.queue || Promise.resolve()).then(() => ocrVideo(f));
  const imgs = [...(files || [])].filter(f => f && f.type && f.type.startsWith("image/"));
  if (!imgs.length) return;
  const room = MAX_SHOTS - st.shots.length;
  for (const f of imgs.slice(0, Math.max(0, room))) {
    // Date de la capture : celle du fichier (capture enregistrée) ou du collage.
    const shot = { id: ++shotSeq, file: f, url: URL.createObjectURL(f), status: "new", n: 0, err: "", observedAt: f.lastModified || Date.now() };
    st.shots.push(shot);
    fingerprint(f).then(h => { shot.fp = h; }).catch(() => {});
  }
  hideDiff();
  renderShots();
  const p = pendingShots().length;
  if (imgs.length > room) capMsg(`${MAX_SHOTS} captures au maximum à la fois : enregistre celles-ci, puis continue.`, true);
  else capMsg(p > 1 ? `${p} captures prêtes. Colle la page suivante ou lance l'analyse.` : "Capture prête. Colle la page suivante si l'inventaire en a plusieurs, ou lance l'analyse.");
}
// Captures (images) à analyser. Une vidéo ou une lecture en direct n'est jamais envoyée à l'analyse par image.
const pendingShots = () => st.shots.filter(s => (s.status === "new" || s.status === "error") && s.file && !s.video);
const shotPage = id => st.shots.findIndex(s => s.id === id) + 1;
function renderShots() {
  const has = st.shots.length > 0;
  $("#dropEmpty").hidden = has; $("#thumbs").hidden = !has; $("#dropMore").hidden = !has || st.shots.length >= MAX_SHOTS;
  $("#clearCap").hidden = !has;
  $("#thumbs").innerHTML = st.shots.map((s, i) => {
    const state = s.status === "done" ? `<span class="ok">${s.n} lot${s.n > 1 ? "s" : ""}</span>`
      : s.status === "busy" ? "lecture…" : s.status === "error" ? `<span class="bad" title="${esc(s.err)}">échec</span>` : "à analyser";
    return `<div class="thumb">${s.url ? `<img src="${s.url}" alt="Page ${i + 1}">` : '<div class="hint" style="padding:20px">vidéo…</div>'}${s.video ? '<span class="tag" style="position:absolute;left:4px;top:4px">vidéo</span>' : ""}
      <div class="tcap"><span>Page ${i + 1}</span>${state}</div>
      <button class="tdel" data-del="${s.id}" title="Retirer cette capture" aria-label="Retirer la page ${i + 1}" ${s.status === "busy" ? "disabled" : ""}>×</button></div>`;
  }).join("");
  const p = pendingShots().length, busy = st.shots.some(s => s.status === "busy");
  $("#analyze").disabled = !p || busy || !can("scan");
  $("#ocrRead").hidden = !p || busy;
  if (p && !can("scan")) capMsg("Tu n'as pas le droit d'analyser des captures avec l'IA : demande-le à un administrateur de ton organisation.", true);
  const retry = p && pendingShots().every(s => s.status === "error");
  $("#analyze").textContent = retry ? (p > 1 ? `Réessayer les ${p} captures en échec` : "Réessayer la capture en échec")
    : p > 1 ? `Analyser les ${p} captures` : st.items.length && p ? "Analyser la nouvelle capture" : "Analyser la capture";
}
$("#thumbs").addEventListener("click", e => {
  e.stopPropagation();
  const b = e.target.closest("[data-del]"); if (!b) return;
  const id = +b.dataset.del, s = st.shots.find(x => x.id === id);
  if (!s || s.status === "busy") return;
  if (s.url && s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
  st.shots = st.shots.filter(x => x !== s);
  st.items = st.items.filter(it => it.shot !== id);
  if (!st.shots.length) return clearCapture();
  renderShots();
  if (st.items.length) renderReview(); else $("#review").hidden = true;
});
drop.addEventListener("click", () => $("#file").click());
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } });
$("#file").addEventListener("change", e => { addImages(e.target.files); e.target.value = ""; });
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); addImages(e.dataTransfer.files); });
document.addEventListener("paste", e => {
  if ($("#appView").hidden || $("#mineView").hidden) return;
  const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (fs.length) { e.preventDefault(); addImages(fs); drop.scrollIntoView({ block: "nearest" }); }
});
$("#clearCap").addEventListener("click", e => { e.stopPropagation(); clearCapture(); });
// Empreinte SHA-256 de l'image : signale une capture déjà enregistrée, sans jamais bloquer un nouveau relevé.
async function fingerprint(file) {
  const h = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function clearCapture() {
  for (const s of st.shots) if (s.url && s.url.startsWith("blob:")) URL.revokeObjectURL(s.url);
  st.shots = []; st.items = []; st.reasons = {}; st.scanKey = null;
  st.modeTouched = false; setCapMode($("#capTerminal").value === "raffinerie" ? "add" : "update");
  hideDiff();
  $("#review").hidden = true; $("#file").value = ""; capMsg("");
  const last = $("#ocrLast"); if (last) last.hidden = true;
  renderShots();
}
// Lieu de la capture, mémorisé d'une visite à l'autre.
try { $("#capPlace").value = localStorage.getItem("registre.place") || ""; } catch (_) {}
$("#capPlace").addEventListener("change", e => {
  try { localStorage.setItem("registre.place", e.target.value.trim()); } catch (_) {}
  if (st.items.length) renderReview();
});
// Couverture : une capture partielle ne touche qu'aux minerais visibles ; un inventaire complet met les absents à 0.
const capCoverage = () => document.querySelector("input[name=capCov]:checked").value;
document.querySelectorAll("input[name=capCov]").forEach(r => r.addEventListener("change", () => {
  $("#capCovHint").textContent = capCoverage() === "complete"
    ? "Les minerais absents des captures passeront à 0 dans ce lieu. L'aperçu te les montrera avant d'enregistrer."
    : "Seuls les minerais visibles sont mis à jour ; les autres ne changent pas.";
  hideDiff();
}));
["#capOwner", "#capTerminal", "#capPlace", "#capRefPanel"].forEach(sel => $(sel).addEventListener("change", hideDiff));
// Raffinerie : on choisit quel ordre lire (celui en préparation ou un ordre terminé).
const refPanel = () => ["done", "running"].includes($("#capRefPanel").value) ? $("#capRefPanel").value : "setup";
// Enregistrement : « Mettre à jour » (relevé : la quantité lue remplace), « Ajouter » (les lots s'additionnent)
// ou « Fin de run » (la récolte s'additionne, comptée comme production minière).
const MODE_HINT = {
  update: "La quantité lue remplace celle enregistrée ; l'écart devient une variation.",
  add: "Chaque lot lu s'ajoute au stock déjà enregistré dans ce lieu ; rien d'autre ne change.",
  run: "La récolte du run s'ajoute au stock de ce lieu, comptée comme production minière.",
};
const capMode = () => (document.querySelector("input[name=capMode]:checked") || {}).value || "update";
function setCapMode(m) { const r = document.querySelector(`input[name=capMode][value="${m}"]`); if (r) r.checked = true; showCapMode(); }
function showCapMode() {
  $("#capModeHint").textContent = MODE_HINT[capMode()];
  // « Partie ou inventaire complet » n'a de sens que pour une mise à jour.
  $("#capCovBox").hidden = capMode() !== "update";
}
document.querySelectorAll("input[name=capMode]").forEach(r => r.addEventListener("change", () => { st.modeTouched = true; showCapMode(); hideDiff(); }));
showCapMode();
$("#capTerminal").addEventListener("change", () => {
  const raf = $("#capTerminal").value === "raffinerie";
  $("#capRefBox").hidden = !raf;
  // Un ordre de raffinerie s'ajoute au stock par défaut (modifiable).
  if (!st.modeTouched) setCapMode(raf ? "add" : "update");
});

// Réduit l'image (2000 px max) pour limiter le coût d'analyse et le temps d'envoi.
async function toBase64Jpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.9).split(",")[1];
}

async function analyzeShot(s) {
  const image = await toBase64Jpeg(s.file);
  const { data, error } = await sb.functions.invoke("analyze-capture", { body: { image, media_type: "image/jpeg", terminal_hint: $("#capTerminal").value || null, refinery_panel: refPanel() } });
  if (error) {
    let msg = "L'analyse a échoué. Réessaie dans un instant.";
    try { msg = (await error.context.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  s.terminal = String(data?.terminal_type || "inconnu");
  const raw = (Array.isArray(data?.items) ? data.items : []).filter(i => i && i.name);
  // Raffinerie : toutes les lignes ont la même icône de lingot, inutile de la garder comme vignette ;
  // le rendement est affiché en cSCU (centièmes de SCU) : on l'enregistre en SCU.
  const refinery = ($("#capTerminal").value || s.terminal) === "raffinerie";
  const crops = refinery ? [] : await cropTiles(s.file, raw.map(i => i.box));
  const amount = i => {
    const unit = String(i.unit || "").trim();
    // Caisse de minerai dont le contenu n'est pas affiché : quantité en SCU à saisir (jamais 1 par défaut).
    if (i.qty == null && /^scu$/i.test(unit) && !refinery) return { qty: "", unit: "SCU", needQty: true };
    const qty = i.qty == null ? 1 : num(i.qty);
    return refinery && !/^scu$/i.test(unit) ? { qty: Math.round(qty) / 100, unit: "SCU" } : { qty, unit };
  };
  return raw.map((i, k) => ({
    name: String(i.name).trim(), quality: qKey(i.quality) === "-" ? "" : qKey(i.quality), ...amount(i), color: String(i.color || "").trim(), hex: okHex(String(i.hex || "").trim()), by: String(i.by || ""),
    on: true, target: matchTarget(String(i.name)), shot: s.id, crop: crops[k],
    box: Array.isArray(i.box) && i.box.length === 4 ? i.box.map(num) : null,
    confidence: i.confidence == null ? null : Math.max(0, Math.min(1, num(i.confidence))),
    // Lots lus comme le même caillou (même nom ou même couleur) : renommer l'un renomme les autres, sur toutes les pages.
    group: norm(i.name),
  }));
}

// Découpe la case de chaque lot dans la capture d'origine, pour vérifier le caillou à l'œil.
async function cropTiles(file, boxes) {
  if (!boxes.some(b => Array.isArray(b) && b.length === 4)) return [];
  let bmp; try { bmp = await createImageBitmap(file); } catch (_) { return []; }
  const W = bmp.width, H = bmp.height;
  return boxes.map(b => {
    if (!Array.isArray(b) || b.length !== 4) return "";
    let [l, t, r, d] = b.map(v => Math.min(1000, Math.max(0, num(v))));
    if (r - l < 5 || d - t < 5) return "";
    // Si la position couvre toute la case (format presque carré), on rogne le haut (qualité) et le bas (icône).
    const W2 = (r - l) * W, H2 = (d - t) * H;
    if (H2 > 0.75 * W2) { const h = d - t; t += h * 0.15; d -= h * 0.08; const w = r - l; l += w * 0.06; r -= w * 0.06; }
    const sx = l / 1000 * W, sy = t / 1000 * H, sw = (r - l) / 1000 * W, sh = (d - t) / 1000 * H;
    const k = Math.min(1, 160 / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    c.getContext("2d").drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.85);
  });
}

$("#analyze").addEventListener("click", async () => {
  const todo = pendingShots(); if (!todo.length) return;
  for (const s of todo) { s.status = "busy"; s.err = ""; }
  renderShots();
  let left = todo.length;
  capMsg(`Lecture de ${todo.length > 1 ? todo.length + " captures" : "la capture"} en cours… (10 à 60 secondes)`);
  const queue = todo.slice();
  const worker = async () => { // 3 analyses en parallèle au plus
    for (let s; (s = queue.shift());) {
      try {
        const items = await analyzeShot(s);
        if (!st.shots.includes(s)) continue; // tout effacé entre-temps
        // Un nom déjà corrigé sur une page précédente s'applique aux nouvelles pages.
        for (const it of items) {
          const prev = st.items.find(x => x.group === it.group);
          if (prev) { it.name = prev.name; it.target = prev.target; }
        }
        st.items.push(...items);
        s.status = "done"; s.n = items.length;
      } catch (err) { s.status = "error"; s.err = errText(err); }
      left--;
      if (left) capMsg(`Lecture en cours… encore ${left} capture${left > 1 ? "s" : ""}.`);
      renderShots();
      if (!st.modeTouched && !$("#capTerminal").value && isRefineryScan() && capMode() === "update") setCapMode("add");
      if (st.items.length) { st.items.sort((a, b) => shotPage(a.shot) - shotPage(b.shot)); markOverlaps(); renderReview(); }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const failed = st.shots.filter(s => s.status === "error");
  if (!st.items.length) {
    $("#review").hidden = true;
    capMsg(failed.length ? failed[0].err : "Aucune ressource lue. Essaie une capture plus nette ou recadrée sur l'inventaire.", true);
  } else {
    const kinds = new Set(st.items.map(i => norm(i.name))).size, pages = st.shots.filter(s => s.status === "done").length;
    let msg = `${st.items.length} lot${st.items.length > 1 ? "s" : ""} lu${st.items.length > 1 ? "s" : ""} sur ${pages} page${pages > 1 ? "s" : ""}, ${kinds} minerai${kinds > 1 ? "s" : ""}. Vérifie les valeurs avant d'enregistrer.`;
    if (failed.length) msg += ` ${failed.length} capture${failed.length > 1 ? "s ont" : " a"} échoué : relance l'analyse pour réessayer.`;
    capMsg(msg, failed.length > 0);
  }
  renderShots();
});

function matchTarget(name) {
  const n = norm(name); if (!n) return "new";
  let r = st.resources.find(x => norm(x.name) === n) || st.resources.find(x => x.name_en && norm(x.name_en) === n);
  // Correspondance partielle : jamais entre un minerai brut « X (Ore) » et la ressource raffinée « X ».
  const ore = t => /[([]\s*(ore|raw|brut)\s*[)\]]|\bbrut\b/i.test(t);
  if (!r) r = st.resources.find(x => { const k = norm(x.name); return ore(x.name) === ore(name) && k.length > 3 && (k.includes(n) || n.includes(k)); });
  return r ? r.id : "new";
}

// Cases probablement répétées entre deux pages qui se chevauchent : décochées, avec un avertissement.
function markOverlaps() {
  const entries = st.items.map(it => ({ page: shotPage(it.shot), name: it.name, quality: it.quality, qty: it.qty, unit: it.unit, box: it.box, it }));
  for (const it of st.items) if (it.dup) { it.dup = false; }
  for (const e of ScanLogic.flagOverlaps(entries)) { e.it.dup = true; e.it.on = false; }
}

function renderReview() {
  $("#review").hidden = false;
  const opts = st.resources.slice().sort(byName);
  const groups = new Map();
  // Lecture des infobulles : la dernière caisse lue en haut de la liste (on voit tout de suite ce qui s'ajoute).
  const order = st.items.map((_, i) => i);
  if (st.items.some(it => it.ocr)) order.reverse();
  for (const i of order) { const it = st.items[i]; if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(i); }
  for (const it of st.items) if (it.target !== "new" && !st.resources.some(x => x.id === it.target)) it.target = "new";
  // Boutons « vue de référence » / « image principale » pour la vignette d'une case.
  const refBtns = i => {
    const it = st.items[i], r = resOf(it.target), views = r ? refsOf(r) : [];
    if (!r || !it.crop) return "";
    const term = itemTerminal(it), sr = screenRef(r.id, term);
    const screenBtn = st.libReady && term !== "inconnu" && can("catalog") && !(sr && sr.image === it.crop)
      ? `<button type="button" class="linkbtn" data-ref="${i}" data-how="screen" title="Cette vignette devient l'image de ${esc(r.name)} pour l'écran « ${esc(TERM[term])} » : elle sert de comparaison pour les prochaines captures de cet écran">Image pour l'écran ${esc(TERM[term].replace(/^./, c => c.toLowerCase()))}</button>` : "";
    const known = views.includes(it.crop) || libOf(r.id).some(x => x.image === it.crop);
    return `<span class="rv-acts">${known ? "" : `<button type="button" class="linkbtn" data-ref="${i}" data-how="add" title="Cette vignette montre bien ${esc(r.name)} : elle rejoint ses images de référence (utile quand le caillou s'affiche autrement selon l'écran)">${views.length ? "+ Ajouter aux références" : "Utiliser comme référence"}</button>`}`
      + screenBtn
      + (views.length && r.image !== it.crop ? `<button type="button" class="linkbtn" data-ref="${i}" data-how="main" title="Remplace l'image affichée pour ${esc(r.name)} dans le stock et partout sur le site">Mettre en image principale</button>` : "") + "</span>";
  };
  const rows = [];
  for (const idx of groups.values()) {
    const it0 = st.items[idx[0]], r0 = resOf(it0.target), many = idx.length > 1;
    if (many) rows.push(`<tr class="rv-grp"><td colspan="8">
        <b>${idx.length} lots qui se ressemblent</b>${it0.color ? ` · ${esc(it0.color)}` : ""} → <b>${esc(r0 ? r0.name : "nouvelle ressource")}</b>
        <span class="muted">· changer le minerai d'une ligne change tout le groupe ; « Séparer » sort une ligne du groupe.</span>
        ${refBtns(idx[0])}</td></tr>`);
    for (const i of idx) {
      const it = st.items[i], r = resOf(it.target), views = r ? refsOf(r) : [];
      // Référence de l'écran de la capture si le minerai en a une, sinon l'image principale.
      const sr = r ? screenRef(r.id, itemTerminal(it)) : null, refSrc = sr ? sr.image : views[0];
      const refCap = sr ? "Réf. " + (TERM[sr.terminal_type] || "").replace(/^./, c => c.toLowerCase()).replace("inventaire personnel", "inventaire") : "Réf. principale";
      const pic = it.crop
        ? `<div class="rv-pics"><figure><img class="crop" src="${it.crop}" alt="Case lue sur la capture"><figcaption>Capture</figcaption></figure>`
          + (refSrc ? `<figure><img class="crop ref" src="${esc(refSrc)}" alt="" title="${esc(r.name)} : ${sr ? `image choisie pour l'écran « ${esc(TERM[sr.terminal_type])} »` : "image principale (aucune image pour cet écran)"}${views.length > 1 ? ` · ${views.length} images en tout` : ""}"><figcaption>${esc(refCap)}</figcaption></figure>` : `<figure><span class="crop ref none">?</span><figcaption>Aucune réf.</figcaption></figure>`)
          + "</div>"
        : it.proof ? `<div class="rv-pics"><figure><img class="proof" src="${it.proof}" alt="Infobulle lue"><figcaption>Infobulle lue</figcaption></figure></div>`
        : swatch(it.hex, it.color);
      const warn = [];
      if (it.same) warn.push('<span class="tag warn" title="Mêmes minerai, qualité et contenu que la caisse lue juste avant : vérifie que tu n\'as pas cliqué deux fois la même caisse">Identique à la précédente</span>');
      if (it.dup) warn.push('<span class="tag warn" title="La même suite de cases termine la page précédente : cette case est sans doute déjà comptée">Déjà vue page précédente ?</span>');
      if (it.confidence != null && it.confidence < 0.7) warn.push('<span class="tag warn" title="L\'IA n\'est pas sûre de cette lecture">Lecture incertaine</span>');
      if (it.by === "couleur") warn.push('<span class="tag" title="Le nom n\'était pas lisible : reconnu par l\'apparence du caillou">Reconnu par l\'apparence</span>');
      const extra = many ? `<span class="rv-acts"><button type="button" class="linkbtn" data-split="${i}" title="Ce caillou n'est pas le même minerai que les autres du groupe : le nommer à part">Séparer</button></span>`
        : `${it.color ? `<div class="colordesc">${esc(it.color)}</div>` : ""}${refBtns(i)}`;
      rows.push(`<tr data-i="${i}" class="${it.on ? "" : "off"}${many ? " in-grp" : ""}">
      <td><input type="checkbox" data-f="on" id="rv-on-${i}" ${it.on ? "checked" : ""} aria-label="Inclure cette ligne"></td>
      <td class="pg">p. ${shotPage(it.shot) || "–"}</td>
      <td><input type="text" data-f="name" id="rv-name-${i}" value="${esc(it.name)}">${warn.length ? `<div class="warns">${warn.join(" ")}</div>` : ""}</td>
      <td class="rv-case">${pic}${extra}</td>
      <td><input type="number" class="qin" step="1" min="0" max="1000" placeholder="?" data-f="quality" id="rv-q-${i}" value="${esc(it.quality)}" aria-label="Qualité"></td>
      <td><input type="number" step="any" min="0" data-f="qty" id="rv-qty-${i}" value="${it.qty}" aria-label="Quantité"${it.needQty && !(num(it.qty) > 0) ? (it.unit ? ' class="needqty" placeholder="SCU ?" title="Contenu de la caisse : survole-la dans le jeu et recopie la valeur en SCU"' : ' class="needqty" placeholder="nombre ?" title="Nombre de gemmes : la valeur « x1 », « x5 »… affichée sur la case"') : ""}>${it.needQty && !(num(it.qty) > 0) ? `<div class="colordesc">${it.unit ? "contenu à saisir (survol en jeu)" : "nombre affiché sur la case (x1, x5…)"}</div>` : ""}</td>
      <td><input type="text" class="uin" data-f="unit" id="rv-unit-${i}" list="unitList" maxlength="20" placeholder="objets" value="${esc(it.unit)}" aria-label="Unité"></td>
      <td><select data-f="target" id="rv-target-${i}"><option value="new"${it.target === "new" ? " selected" : ""}>Nouvelle ressource (ajoutée au catalogue)</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === it.target ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></td></tr>`);
    }
  }
  $("#reviewBody").innerHTML = rows.join("");
  const n = st.items.filter(i => i.on).length;
  $("#compare").textContent = n ? `Comparer ${n} lot${n > 1 ? "s" : ""} avec le stock enregistré` : "Aucune ligne cochée";
  $("#compare").disabled = !n;
}

// ---------- caisses de minerai : lecture gratuite des infobulles (OCR dans le navigateur, sans IA) ----------
// Tesseract.js est chargé à la demande depuis un CDN ; l'image ne quitte jamais l'ordinateur.
const OCR_MAX = 60;
const ocr = { worker: null, loading: null, dir: null, timer: null, seen: new Set(), since: 0, last: null };
function ocrMsg(t, err) { const el = $("#ocrMsg"); el.textContent = t; el.className = err ? "err" : "muted"; el.style.fontSize = "13px"; }
function loadScript(src) {
  return new Promise((ok, ko) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => ko(new Error("Chargement impossible : " + src)); document.head.appendChild(s); });
}
async function ocrWorker() {
  if (ocr.worker) return ocr.worker;
  if (!ocr.loading) ocr.loading = (async () => {
    ocrMsg("Préparation de la lecture (une seule fois, quelques Mo)…");
    if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js");
    ocr.worker = await Tesseract.createWorker(["fra", "eng"], 1);
    return ocr.worker;
  })().catch(e => { ocr.loading = null; throw e; });
  return ocr.loading;
}
// Repère la ligne de contenu de l'infobulle : l'étiquette violette du nom (« Cuivre (M) »).
// Renvoie un rectangle dans l'image d'origine, ou null (on lit alors l'image entière).
// Pixel de l'étiquette violette / magenta du nom.
function isBadge(d, i) {
  const r = d[i] / 255, gg = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), s = mx ? (mx - mn) / mx : 0;
  if (mx === mn) return false;
  let hue = mx === r ? 60 * (((gg - b) / (mx - mn)) % 6) : mx === gg ? 60 * ((b - r) / (mx - mn) + 2) : 60 * ((r - gg) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  return hue >= 260 && hue <= 356 && s > 0.3 && mx > 0.25;
}
// Pixel de l'étiquette olive du contenu (« 0.115 SCU ») : teinte 38-70°, mesurée sur les deux écrans du jeu.
function isOlive(d, i, strict) {
  const r = d[i], g2 = d[i + 1], b = d[i + 2], mx = Math.max(r, g2, b), mn = Math.min(r, g2, b);
  if (mx < 70 || mx === mn || (mx - mn) / mx < 0.45) return false;
  let hue = mx === r ? 60 * (((g2 - b) / (mx - mn)) % 6) : mx === g2 ? 60 * ((b - r) / (mx - mn) + 2) : 60 * ((r - g2) / (mx - mn) + 4);
  if (hue < 0) hue += 360;
  // Le fond orangé du terminal de fret est à 31-39° : la fin de l'étiquette se mesure à partir de 41°.
  return hue >= (strict ? 41 : 38) && hue <= 70;
}
function findTooltipLine(bmp) {
  // Zones violettes candidates (composantes connexes) : on garde celle qui a la forme de l'étiquette du nom
  // (petit rectangle plein, plus large que haut) suivie à droite de l'étiquette olive du contenu. Un cristal rose ou
  // un autre élément violet de l'écran n'a pas cette forme.
  const k = 2, w = Math.ceil(bmp.width / k), h = Math.ceil(bmp.height / k);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) if (isBadge(d, p * 4)) mask[p] = 1;
  const stack = new Int32Array(w * h); let best = null;
  const maxH = Math.max(18, Math.round(h * 0.03));
  for (let p0 = 0; p0 < w * h; p0++) {
    if (mask[p0] !== 1) continue;
    let sp = 0, n = 0, x0 = w, x1 = 0, y0 = h, y1 = 0; stack[sp++] = p0; mask[p0] = 2;
    while (sp) {
      const p = stack[--sp], x = p % w, y = (p - x) / w; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] === 1) { mask[p - 1] = 2; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] === 1) { mask[p + 1] = 2; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] === 1) { mask[p - w] = 2; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] === 1) { mask[p + w] = 2; stack[sp++] = p + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bh < 3 || bh > maxH || bw < bh * 2 || bw > w * 0.15 || n / (bw * bh) < 0.35) continue;
    let olive = 0;
    for (let y = y0; y <= y1; y++) for (let x = x1 + 1; x < Math.min(w, x1 + bh * 16); x++) if (isOlive(d, (y * w + x) * 4)) olive++;
    const score = (olive >= bh * 2 ? 1e6 : 0) + n;
    if (!best || score > best.score) best = { score, x0, x1, y0, y1 };
  }
  if (!best) return null;
  const x0 = best.x0, y0 = best.y0, y1 = best.y1, near = [[best.x0, best.y0], [best.x1, best.y1]];
  // Affinage en pleine résolution : hauteur exacte de l'étiquette (lignes contenant assez de violet).
  const fx = Math.max(0, (x0 - 3) * k), fy = Math.max(0, (y0 - 4) * k), fw = Math.min(bmp.width - fx, (Math.max(...near.map(p => p[0])) - x0 + 7) * k), fh = Math.min(bmp.height - fy, (y1 - y0 + 9) * k);
  const f = document.createElement("canvas"); f.width = fw; f.height = fh;
  const fg = f.getContext("2d", { willReadFrequently: true }); fg.drawImage(bmp, fx, fy, fw, fh, 0, 0, fw, fh);
  const fd = fg.getImageData(0, 0, fw, fh).data; let top = -1, bot = -1, lft = fw;
  for (let y = 0; y < fh; y++) {
    let n = 0;
    for (let x = 0; x < fw; x++) if (isBadge(fd, (y * fw + x) * 4)) { n++; if (x < lft) lft = x; }
    if (n >= Math.max(3, fw * 0.15)) { if (top < 0) top = y; bot = y; }
  }
  if (top < 0) return null;
  const h0 = bot - top + 1, left = fx + Math.max(0, lft - 2), y = Math.max(0, fy + top - Math.round(h0 * 0.15));
  const height = Math.min(bmp.height - y, Math.round(h0 * 1.3) + 1);
  // La ligne s'étend jusqu'au contenu en SCU, aligné à droite de l'infobulle (mesuré : environ 230 px sur 2000).
  let width = Math.min(bmp.width - left, Math.max(Math.round(h0 * 16), Math.round(bmp.width * 0.125)));
  // Fin de la ligne : bord droit de l'étiquette olive du contenu (« 0.115 SCU »). Ce qui suit gêne la lecture.
  const o = document.createElement("canvas"); o.width = width; o.height = height;
  const og = o.getContext("2d", { willReadFrequently: true }); og.drawImage(bmp, left, y, width, height, 0, 0, width, height);
  const od = og.getImageData(0, 0, width, height).data; let lastOlive = -1;
  for (let x = width - 1; x >= 0 && lastOlive < 0; x--) {
    let n = 0;
    for (let yy = 0; yy < height; yy++) {
      if (isOlive(od, (yy * width + x) * 4, true)) n++;
    }
    if (n >= Math.max(3, height * 0.5)) lastOlive = x;
  }
  if (lastOlive > h0 * 6) width = Math.min(width, lastOlive + Math.round(h0 * 0.4));
  return { x: left, y, w: width, h: height };
}
// Image préparée pour l'OCR : agrandie, en niveaux de gris, texte clair rendu foncé sur fond blanc.
function ocrCanvas(bmp, r, scale) {
  const c = document.createElement("canvas"); c.width = Math.round(r.w * scale); c.height = Math.round(r.h * scale);
  const g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingEnabled = true;
  g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data;
  // Texte de l'infobulle : clair et peu coloré (blanc, crème) ; les fonds colorés des étiquettes deviennent blancs.
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]), l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    const text = l > 135 && (mx - mn) / (mx || 1) < 0.4;
    d[i] = d[i + 1] = d[i + 2] = text ? 0 : 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}
async function readTooltip(file) {
  const bmp = await createImageBitmap(file);
  try { return await readTooltipBitmap(bmp, findTooltipLine(bmp), true); } finally { bmp.close && bmp.close(); }
}
async function readTooltipBitmap(bmp, line, fallback) {
  const w = await ocrWorker();
  let found = null, proof = null;
  if (line) {
    // Une seule ligne ; seulement les caractères possibles d'une infobulle (lettres, chiffres, unités).
    await w.setParameters({ tessedit_pageseg_mode: "7",
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÂÄÇÉÈÊËÎÏÔÖÙÛÜàâäçéèêëîïôöùûüŒœ0123456789.,()[]'µ -" });
    const scale = Math.max(1.2, Math.min(8, 66 / line.h));   // ligne d'environ 66 px (texte ~40 px) quelle que soit la résolution
    const { data } = await w.recognize(ocrCanvas(bmp, line, scale));
    found = OcrLogic.parseTooltip(data.text);
    if (found) found.confidence = (data.confidence || 0) / 100;
    const p = document.createElement("canvas"); p.width = Math.min(320, line.w); p.height = Math.round(line.h * p.width / line.w);
    p.getContext("2d").drawImage(bmp, line.x, line.y, line.w, line.h, 0, 0, p.width, p.height);
    proof = p.toDataURL("image/jpeg", 0.85);
  }
  if (!found && fallback) {
    // Repli : toute l'image (plus lent), lecture des blocs de texte épars.
    await w.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
    const { data } = await w.recognize(ocrCanvas(bmp, { x: 0, y: 0, w: bmp.width, h: bmp.height }, Math.min(2, 2600 / bmp.width)));
    found = OcrLogic.parseTooltip(data.text);
    if (found) found.confidence = Math.min(0.6, (data.confidence || 0) / 100);
  }
  return found ? { ...found, proof } : null;
}
const ocrShots = () => st.shots.filter(s => s.ocr);
// Dernière caisse lue, affichée en grand près des boutons de lecture.
function showLastRead(it) {
  const el = $("#ocrLast"), n = st.items.filter(x => x.ocr).length + 1, r = resOf(it.target);
  el.hidden = false;
  el.innerHTML = `<span class="muted">Caisse n° ${n} lue :</span> <strong>${esc(r ? r.name : it.name)}</strong> Q${esc(it.quality)} · ${it.gem ? "nombre à saisir" : esc(fmt(it.qty) + " " + it.unit)}`;
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
// Gemmes et objets (Hadanite, Dolivine…) : comptés en unités, jamais en SCU.
const GEM_NAMES = ["aphorite", "beradom", "carinite", "dolivine", "feynmaline", "glacosite", "hadanite", "janalite", "sadaryx", "saldynium", "yormandieye", "oeildeyormandi"];
function isGem(target, name) {
  const r = resOf(target);
  if (r && /objet|gemme/i.test(r.category || "")) return true;
  return [name, r && r.name, r && r.name_en].filter(Boolean).some(n => GEM_NAMES.includes(norm(String(n).replace(/\s*[([].*$/, ""))));
}
// Ajoute une caisse lue à la liste à vérifier. Même caisse lue deux fois de suite : décochée (doublon probable).
function pushOcrItem(r, s, at, windowMs) {
  const name = r.name.replace(/\s*\((?:M|Ore|Raw)\)\s*$/i, "").trim();
  const it = { name, quality: String(r.quality), qty: r.qty, unit: "SCU", color: "", hex: "", by: "nom", on: true, target: matchTarget(name),
    shot: s.id, crop: null, proof: r.proof, box: null, confidence: r.confidence ?? null, group: norm(name), ocr: true };
  const prev = st.items.find(x => x.group === it.group);
  if (prev) { it.name = prev.name; it.target = prev.target; }
  // Gemme : l'infobulle donne un volume, pas un nombre. Le nombre (x1, x5…) affiché sur la case est à saisir.
  if (isGem(it.target, name)) { it.unit = ""; it.qty = ""; it.needQty = true; it.gem = true; }
  showLastRead(it);
  const read = { name, quality: r.quality, qty: r.qty, at };
  if (OcrLogic.sameRead(ocr.last, read, windowMs)) { it.on = false; it.dup = true; }
  ocr.last = read;
  st.items.push(it);
  return it;
}
// ---------- vidéo : une seule vidéo en survolant les caisses, chaque nouvelle infobulle est lue ----------
const VIDEO_STEP = 0.25, VIDEO_MAX_READS = 120;
async function ocrVideo(file) {
  const shot = { id: ++shotSeq, file, url: "", status: "busy", n: 0, err: "", observedAt: file.lastModified || Date.now(), ocr: true, video: true };
  st.shots.push(shot);
  fingerprint(file).then(h => { shot.fp = h; }).catch(() => {});
  if (!st.modeTouched && capMode() === "update") setCapMode("add");
  hideDiff(); renderShots();
  const v = document.createElement("video"); v.muted = true; v.preload = "auto"; v.src = URL.createObjectURL(file);
  try {
    await new Promise((ok, ko) => { v.onloadeddata = ok; v.onerror = () => ko(new Error("Vidéo illisible par le navigateur (essaie un MP4).")); });
    await ocrWorker();
    const dur = v.duration, seek = t => new Promise(ok => { v.onseeked = ok; v.currentTime = t; });
    const fs = { prevLine: null, prevSig: "" }; let reads = 0, n = 0;
    for (let t = 0; t < dur && reads < VIDEO_MAX_READS; t += VIDEO_STEP) {
      if (!st.shots.includes(shot)) return;
      await seek(t);
      const bmp = await createImageBitmap(v);
      if (!shot.url) { const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * bmp.height / bmp.width); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); shot.url = c.toDataURL("image/jpeg", 0.7); renderShots(); }
      const got = await frameTooltip(bmp, shot, fs, t * 1000);
      if (got) { reads++; if (got.added) { n++; shot.n = n; ocrMsg(`Vidéo : ${n} caisse${n > 1 ? "s" : ""} lue${n > 1 ? "s" : ""} (${Math.round(t)} s / ${Math.round(dur)} s)…`); } }
      bmp.close && bmp.close();
    }
    shot.status = n ? "done" : "error"; shot.n = n;
    if (!n) shot.err = "Aucune infobulle de caisse lisible dans la vidéo.";
    ocrMsg(n ? `Vidéo lue : ${n} caisse${n > 1 ? "s" : ""}. Vérifie les valeurs dans le tableau avant d'enregistrer.` : shot.err, !n);
  } catch (err) { shot.status = "error"; shot.err = errText(err); ocrMsg(shot.err, true); }
  finally { URL.revokeObjectURL(v.src); renderShots(); }
}
// Une image (vidéo ou direct) : lit l'infobulle seulement si elle vient d'apparaître, a bougé (autre caisse) ou a changé.
// Renvoie null si rien de nouveau, sinon { added } (false si c'est la même caisse que la précédente).
// Une infobulle n'est lue que lorsqu'elle est restée immobile et identique pendant STABLE_MS (la souris s'est posée
// sur la caisse) : les caisses survolées en passant sont ignorées. Elle n'est relue que si elle change ou disparaît.
const STABLE_MS = 700;
const ocrTrigger = () => (document.querySelector("input[name=ocrTrig]:checked") || {}).value || "click";
// Cadres de sélection du jeu (trait fin et clair autour d'une case cliquée, légèrement incliné : écran en 3D).
// Renvoie les bords verticaux distincts (clé -> position) : il en apparaît deux quand une caisse est sélectionnée.
function selectionEdges(bmp) {
  const W = bmp.width, H = bmp.height, c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, W, H).data, L = new Uint8Array(W * H), S = new Uint8Array(W * H);
  for (let i = 0, p = 0; p < W * H; i += 4, p++) {
    const r = d[i], gg = d[i + 1], b = d[i + 2], mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
    L[p] = 0.3 * r + 0.59 * gg + 0.11 * b; S[p] = mx ? Math.round(100 * (mx - mn) / mx) : 0;
  }
  const k = 4, line = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = k; x < W - k; x++) {
    const p = y * W + x, l = L[p];
    if (l > 130 && S[p] < 35 && l - L[p - k] > 40 && l - L[p + k] > 40) line[p] = 1;
  }
  const used = new Uint8Array(W * H), minLen = Math.round(H * 0.09), keys = new Map();
  // Un bord = position horizontale + rangée de cases (centre vertical) : stable d'une image à l'autre.
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!line[p] || used[p]) continue;
    let cy = y, cx = x, gap = 0, sx = 0, n = 0;
    while (cy < H - 1) {
      used[cy * W + cx] = 1; sx += cx; n++;
      let nx = -1;
      for (const dx of [0, -1, 1, -2, 2]) { const xx = cx + dx; if (xx >= 0 && xx < W && line[(cy + 1) * W + xx]) { nx = xx; break; } }
      cy++;
      if (nx < 0) { if (++gap > 4) break; continue; }
      gap = 0; cx = nx;
    }
    if (cy - y >= minLen) {
      const k = Math.round(sx / n / (W / 200)) + ":" + Math.round((y + cy) / 2 / (H / 18));
      if (!keys.has(k)) keys.set(k, { x: Math.round(sx / n), y0: y, y1: cy });
    }
  }
  return keys;
}
// Journal de lecture (diagnostic) : ce que le site voit et décide, à copier pour le support.
const ocrLog = [];
function olog(t) { ocrLog.push(new Date().toLocaleTimeString("fr-FR") + " " + t); if (ocrLog.length > 300) ocrLog.shift(); }
// Compteurs « SÉLECTIONNÉ : N » des panneaux du jeu : ils augmentent exactement de 1 à chaque clic sur une caisse,
// ne sont jamais cachés par l'infobulle et ne bougent pas au défilement. Repérés une fois par OCR sur le haut de l'image.
async function findSelCounters(bmp) {
  const w = await ocrWorker(), top = Math.round(bmp.height * 0.4), scale = 2;
  const c = document.createElement("canvas"); c.width = bmp.width * scale; c.height = top * scale;
  const g = c.getContext("2d"); g.drawImage(bmp, 0, 0, bmp.width, top, 0, 0, c.width, c.height);
  await w.setParameters({ tessedit_pageseg_mode: "11", tessedit_char_whitelist: "" });
  const { data } = await w.recognize(c);
  const out = [];
  for (const wd of data.words || []) {
    if (!/S.?L.?CT.?ONN/i.test(wd.text || "") || /NER|TOUT/i.test(wd.text || "")) continue;   // pas les boutons « Tout sélectionner »
    const b = wd.bbox, h = (b.y1 - b.y0) / scale;
    out.push({ x: Math.max(0, Math.round(b.x0 / scale - h * 0.3)), y: Math.max(0, Math.round(b.y0 / scale - h * 0.3)),
               w: Math.round((b.x1 - b.x0) / scale + h * 5), h: Math.round(h * 1.6) });
  }
  return out;
}
function counterCanvas(bmp, r, forSig, boost = 1) {
  const scale = forSig ? 0 : Math.max(1, Math.min(6, 40 / r.h)) * boost;   // texte d'environ 40 px, quelle que soit la résolution (2K, 4K…)
  const c = document.createElement("canvas"); c.width = forSig ? 48 : Math.round(r.w * scale); c.height = forSig ? 8 : Math.round(r.h * scale);
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const im = g.getImageData(0, 0, c.width, c.height), d = im.data; let sum = 0, max = 0;
  for (let i = 0; i < d.length; i += 4) { const l = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; sum += l; if (l > max) max = l; }
  const thr = sum / (d.length / 4) + 0.45 * (max - sum / (d.length / 4));   // texte (clair, souvent orangé) sur fond sombre
  let sig = "";
  for (let i = 0; i < d.length; i += 4) { const on = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2] > thr; d[i] = d[i + 1] = d[i + 2] = on ? 0 : 255; sig += on ? "1" : "0"; }
  g.putImageData(im, 0, 0);
  return forSig ? sig : c;
}
async function readSelCounter(bmp, r) {
  const w = await ocrWorker();
  await w.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÉéÈè:0123456789 " });
  // Deux lectures à deux tailles : la valeur n'est retenue que si elles concordent (la compression de l'image en 4K
  // fait parfois lire 28 au lieu de 23 ; une telle erreur ne doit jamais compter comme un clic).
  const vals = [];
  for (const boost of [1, 1.7]) {
    const { data } = await w.recognize(counterCanvas(bmp, r, false, boost));
    const m = String(data.text || "").replace(/[Oo](?=\d|\s*$)/g, "0").match(/(\d{1,3})\s*$/);
    vals.push(m ? +m[1] : null);
  }
  return vals;
}
async function frameTooltip(bmp, shot, fs, at) {
  const line = findTooltipLine(bmp);
  // Mode « au clic » : on lit seulement quand une caisse vient d'être sélectionnée (nouveau cadre clair).
  // Le jeu masque l'infobulle au moment du clic : après une nouvelle sélection, on attend qu'elle s'affiche (4 s au plus).
  if (ocrTrigger() === "click" && !fs.noCounters) {
    // Compteurs « SÉLECTIONNÉ : N » (signal du clic) : cherchés une seule fois au départ, puis relus seulement quand ils changent.
    if (fs.counterBusy) return null;
    if (!fs.counters && !fs.counterTry) {
      fs.counterBusy = true; fs.counterTry = at;
      if (live.shot === shot) ocrMsg("Repérage du compteur « Sélectionné » du jeu… (2 secondes, attends avant de cliquer)");
      try { const regs = await findSelCounters(bmp); olog(`image ${bmp.width}×${bmp.height} · compteurs trouvés : ${regs.length} ${JSON.stringify(regs)}`); if (regs.length) fs.counters = regs.map(r => ({ r, sig: "", n: null })); }
      catch (e) { olog("erreur repérage compteur : " + errText(e)); }
      finally { fs.counterBusy = false; }
      // Écran sans compteur (inventaire personnel / local) : lecture quand la souris se pose sur la caisse.
      if (!fs.counters) { fs.noCounters = true; olog("pas de compteur : passage en lecture « souris posée »"); }
      if (live.shot === shot) ocrMsg(fs.counters ? "Prêt : clique sur chaque caisse dans le jeu, elle est lue à chaque clic (le compteur « Sélectionné » augmente)."
        : "Cet écran n'a pas de compteur « Sélectionné » (inventaire personnel ou local) : lecture quand la souris se pose. Pose la souris environ une seconde sur chaque caisse.");
      return null;
    }
    if (fs.counters) {
      fs.diag = fs.diag || { frames: 0, maxEdges: 0, clicks: 0, tips: 0 };
      fs.diag.frames++; if (line) fs.diag.tips++; fs.diag.counters = fs.counters.map(c => c.n).join(" / ");
      for (const c of fs.counters) {
        const sig = counterCanvas(bmp, c.r, true);
        if (sig === c.sig) continue;
        c.sig = sig;
        // Valeur retenue : confirmée par les deux lectures, ou lue une seule fois si c'est une hausse plausible (+1 à +3).
        const [v1, v2] = await readSelCounter(bmp, c.r);
        const one = v1 ?? v2, plausible = v => v != null && c.n != null && v > c.n && v <= c.n + 3;
        const n = v1 != null && v1 === v2 ? v1 : (v1 == null) !== (v2 == null) && (plausible(one) || c.n == null) ? one : null;
        olog(`compteur ${c.r.x},${c.r.y} : ${c.n ?? "?"} -> ${n ?? `ignoré (${v1 ?? "?"}/${v2 ?? "?"})`}`);
        if (n == null) continue;
        if (c.n != null && n > c.n) { fs.pending = at + 4000; fs.clickFrame = true; fs.diag.clicks++; olog(`clic repéré${line ? "" : " (pas d'infobulle sur cette image : attente)"}`); }
        c.n = n;
      }
      fs.diag.counters = fs.counters.map(c => c.n ?? "?").join(" / ");
      const sigNow = line ? lineSig(bmp, line) : "";
      if (!fs.pending) { fs.prevLine = line; fs.prevSig = sigNow; return null; }
      if (at > fs.pending) { fs.pending = 0; olog("aucune infobulle nouvelle vue dans les 4 s après le clic"); return { added: false, missed: true }; }
      // Infobulle de l'image même du clic (la caisse survolée au moment du clic) ; sinon, la première nouvelle infobulle.
      const onClick = fs.clickFrame; fs.clickFrame = false;
      const sameAsLast = line && fs.lastLine && Math.abs(line.x - fs.lastLine.x) + Math.abs(line.y - fs.lastLine.y) <= 12 && sigDiff(sigNow, fs.lastSig) <= 0.08;
      if (!line || (sameAsLast && !onClick)) return null;
      fs.pending = 0; fs.lastLine = line; fs.lastSig = sigNow;
      const r = await readTooltipBitmap(bmp, line, false);
      olog(r ? `infobulle lue : ${r.line}` : `infobulle vue en ${line.x},${line.y} mais texte illisible`);
      if (!r) return { added: false };
      const prevRead = ocr.last, it = pushOcrItem(r, shot, at, 0); ocr.last.video = shot.id;
      if (prevRead && OcrLogic.sameRead(prevRead, ocr.last, 1e9)) it.same = true;
      st.items.sort((a, b) => shotPage(a.shot) - shotPage(b.shot)); renderReview();
      return { added: true };
    }
    return null;
  }
  const sig = line ? lineSig(bmp, line) : "";
  const same = line && fs.prevLine && Math.abs(line.x - fs.prevLine.x) + Math.abs(line.y - fs.prevLine.y) <= 12 && sigDiff(sig, fs.prevSig) <= 0.08;
  if (!same) { fs.since = at; fs.done = false; }
  fs.prevLine = line; fs.prevSig = sig;
  if (!line || fs.done || at - fs.since < STABLE_MS) return null;
  fs.done = true;
  const r = await readTooltipBitmap(bmp, line, false);
  if (!r || (ocr.last && ocr.last.video === shot.id && OcrLogic.sameRead(ocr.last, { ...r, at }, 1e9))) return { added: false };
  pushOcrItem(r, shot, at, 1e9); ocr.last.video = shot.id;
  st.items.sort((a, b) => shotPage(a.shot) - shotPage(b.shot)); renderReview();
  return { added: true };
}
// ---------- lecture en direct : le site regarde la fenêtre du jeu (partage d'écran du navigateur), sans logiciel ----------
const live = { stream: null, video: null, timer: null, busy: false, shot: null, fs: null, n: 0 };
async function startLive() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return ocrMsg("Ton navigateur ne permet pas le partage d'écran : utilise Chrome, Edge ou Firefox.", true);
  // Pleine résolution demandée : le texte de l'infobulle est petit.
  try { live.stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false }); } catch (_) { return; }
  live.video = document.createElement("video"); live.video.muted = true; live.video.srcObject = live.stream;
  await live.video.play().catch(() => {});
  live.shot = { id: ++shotSeq, file: null, url: "", status: "busy", n: 0, err: "", observedAt: Date.now(), ocr: true, video: true, live: true };
  live.frames = 0; live.seen = 0; $("#ocrDiag").hidden = false; $("#ocrCopyLog").hidden = false;
  ocrLog.length = 0; olog(`début lecture en direct · version ${document.querySelector('script[src^="app.js"]').src.split("v=")[1]} · mode ${ocrTrigger()}`);
  st.shots.push(live.shot); live.fs = { prevLine: null, prevSig: "" }; live.n = 0;
  if (!st.modeTouched && capMode() === "update") setCapMode("add");
  hideDiff(); renderShots();
  $("#ocrLive").hidden = true; $("#ocrLiveStop").hidden = false;
  live.stream.getVideoTracks()[0].addEventListener("ended", stopLive);
  ocrMsg("Lecture en direct : survole chaque caisse jusqu'à l'apparition de son infobulle. Préparation…");
  await ocrWorker().catch(err => ocrMsg(errText(err), true));
  ocrMsg(ocrTrigger() === "click" ? "Lecture en direct active : clique sur chaque caisse et laisse la souris dessus jusqu'à l'apparition de son infobulle, puis passe à la suivante. Clique sur « Arrêter » à la fin." : "Lecture en direct active : pose la souris sur chaque caisse environ une seconde (le passage d'une caisse à l'autre est ignoré), puis clique sur « Arrêter ».");
  live.timer = setInterval(liveTick, 300);
}
// Image quasi uniformément noire (moyenne et écart très faibles), mesurée sur une version réduite.
function isBlackFrame(bmp) {
  const c = document.createElement("canvas"); c.width = 64; c.height = 36;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, 64, 36);
  const d = g.getImageData(0, 0, 64, 36).data; let sum = 0, max = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; if (l > max) max = l; }
  return sum / (d.length / 4) < 4 && max < 20;
}
async function liveTick() {
  if (live.busy || !live.video || live.video.readyState < 2) return;
  live.busy = true;
  try {
    const bmp = await createImageBitmap(live.video);
    if (!live.shot.url) { const c = document.createElement("canvas"); c.width = 320; c.height = Math.round(320 * bmp.height / bmp.width); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height); live.shot.url = c.toDataURL("image/jpeg", 0.7); renderShots(); }
    // Image partagée toute noire (jeu en plein écran exclusif) : on le signale au lieu de lire dans le vide.
    if (isBlackFrame(bmp)) {
      live.black = (live.black || 0) + 1;
      if (live.black === 6) ocrMsg("L'image partagée est noire : le navigateur ne voit pas le jeu. Arrête, puis relance en choisissant « Écran entier » au lieu de « Fenêtre » ; sinon mets le jeu en mode « Sans bordure » (Options › Graphismes), ou utilise les captures de ta carte graphique (NVIDIA Alt+F1, AMD Ctrl+Maj+I) avec « Surveiller mon dossier de captures ».", true);
      bmp.close && bmp.close(); live.busy = false; return;
    }
    if (live.black >= 6) ocrMsg("Lecture en direct active : le jeu est visible. Survole chaque caisse environ une seconde.");
    live.black = 0;
    live.frames = (live.frames || 0) + 1;
    if (live.lastBmp && live.lastBmp.close) live.lastBmp.close();
    live.lastBmp = await createImageBitmap(bmp);   // gardée pour le diagnostic
    const got = await frameTooltip(bmp, live.shot, live.fs, Date.now());
    if (live.fs.prevLine) live.seen = (live.seen || 0) + 1;
    bmp.close && bmp.close();
    const dg = live.fs.diag;
    if (dg && ocrTrigger() === "click" && live.frames % 10 === 0)
      $("#ocrDiagLine").textContent = `Images reçues : ${dg.frames} (${live.lastBmp.width}×${live.lastBmp.height}) · ${live.fs.counters ? `compteurs « Sélectionné » lus : ${dg.counters}` : `compteur « Sélectionné » non trouvé, cadres visibles : ${dg.edges ?? "?"}`} · clics repérés : ${dg.clicks} · infobulles vues : ${dg.tips} · caisses lues : ${live.n}`;
    if (!live.n && live.frames === 40) ocrMsg(`Aucune infobulle détectée pour l'instant (image reçue : ${live.lastBmp.width}×${live.lastBmp.height}${live.seen ? `, ${live.seen} étiquette(s) repérée(s) mais illisible(s)` : ", étiquette violette du nom jamais repérée"}). Survole une caisse jusqu'à voir son infobulle, puis clique sur « Envoyer l'image vue » et transmets-moi le fichier.`, true);
    if (got && got.missed) ocrMsg(`Caisse sélectionnée mais aucune infobulle vue : après le clic, laisse la souris sur la caisse jusqu'à ce que son infobulle apparaisse. (${live.n} caisse${live.n > 1 ? "s" : ""} lue${live.n > 1 ? "s" : ""})`, true);
    if (got && got.added) { live.n++; live.shot.n = live.n; ocrMsg(`Lecture en direct : ${live.n} caisse${live.n > 1 ? "s" : ""} lue${live.n > 1 ? "s" : ""}. Continue, ou clique sur « Arrêter ».`); }
    if (st.items.filter(i => i.shot === live.shot.id).length >= VIDEO_MAX_READS) stopLive();
  } catch (err) { ocrMsg(errText(err), true); }
  live.busy = false;
}
function stopLive() {
  clearInterval(live.timer); live.timer = null;
  if (live.stream) live.stream.getTracks().forEach(t => t.stop());
  live.stream = null; live.video = null;
  // Aucune caisse lue : la lecture ne reste pas dans la liste des captures.
  if (live.shot) { if (live.n) live.shot.status = "done"; else st.shots = st.shots.filter(x => x !== live.shot); }
  $("#ocrLive").hidden = false; $("#ocrLiveStop").hidden = true; renderShots();
  if (live.shot) ocrMsg(live.n ? `Lecture terminée : ${live.n} caisse${live.n > 1 ? "s" : ""}. Vérifie les valeurs dans le tableau avant d'enregistrer.` : "Lecture arrêtée : aucune infobulle lue.", !live.n);
  live.shot = null;
}
$("#ocrLive").addEventListener("click", startLive);
$("#ocrCopyLog").addEventListener("click", async () => {
  const txt = ocrLog.join("\n") + "\n" + $("#ocrDiagLine").textContent;
  try { await navigator.clipboard.writeText(txt); ocrMsg("Journal copié : colle-le dans la conversation (Ctrl+V)."); }
  catch (_) { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([txt], { type: "text/plain" })); a.download = "journal-lecture.txt"; a.click(); ocrMsg("Journal téléchargé (journal-lecture.txt) : envoie-le-moi."); }
});
// Diagnostic : télécharge l'image exacte reçue par le site, avec la zone repérée encadrée, pour régler la détection.
$("#ocrDiag").addEventListener("click", () => {
  const b = live.lastBmp; if (!b) return ocrMsg("Aucune image reçue pour l'instant.", true);
  const c = document.createElement("canvas"); c.width = b.width; c.height = b.height;
  const g = c.getContext("2d"); g.drawImage(b, 0, 0);
  const r = findTooltipLine(b);
  if (r) { g.strokeStyle = "#00ff00"; g.lineWidth = 3; g.strokeRect(r.x, r.y, r.w, r.h); }
  // Bords de carrés de sélection repérés (rouge).
  g.strokeStyle = "#ff2020"; g.lineWidth = 3;
  for (const e of selectionEdges(b).values()) { g.beginPath(); g.moveTo(e.x, e.y0); g.lineTo(e.x, e.y1); g.stroke(); }
  c.toBlob(blob => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `image-vue-par-le-site-${Date.now()}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }, "image/png");
  ocrMsg(`Image téléchargée (${b.width}×${b.height}${r ? ", zone repérée encadrée en vert" : ", aucune zone repérée"}). Envoie-la-moi en pièce jointe.`);
});
$("#ocrLiveStop").addEventListener("click", stopLive);
// Empreinte grossière de la ligne de l'infobulle (pour repérer un changement de contenu sans relancer l'OCR).
function lineSig(bmp, r) {
  const c = document.createElement("canvas"); c.width = 48; c.height = 6;
  const g = c.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, r.x, r.y, r.w, r.h, 0, 0, 48, 6);
  const d = g.getImageData(0, 0, 48, 6).data; let s = "";
  for (let i = 0; i < d.length; i += 4) s += (0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]) > 150 ? "1" : "0";
  return s;
}
const sigDiff = (a, b) => { if (!a || !b || a.length !== b.length) return 1; let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n / a.length; };
async function ocrShot(s) {
  s.status = "busy"; renderShots();
  try {
    const r = await readTooltip(s.file);
    if (!st.shots.includes(s)) return;
    if (!r) { s.status = "error"; s.err = "Aucune infobulle de caisse lisible sur cette capture."; }
    else { pushOcrItem(r, s, s.observedAt, 4000); s.status = "done"; s.n = 1; }
  } catch (err) { s.status = "error"; s.err = errText(err); }
  renderShots();
  if (st.items.length) { st.items.sort((a, b) => shotPage(a.shot) - shotPage(b.shot)); renderReview(); }
  const done = ocrShots().filter(x => x.status === "done").length, bad = ocrShots().filter(x => x.status === "error").length;
  ocrMsg(`${done} caisse${done > 1 ? "s" : ""} lue${done > 1 ? "s" : ""}${bad ? ` · ${bad} capture${bad > 1 ? "s" : ""} sans infobulle lisible (survole la caisse jusqu'à l'apparition de l'infobulle)` : ""}. Vérifie les valeurs dans le tableau avant d'enregistrer.`, bad > 0 && !done);
}
function addOcrFile(file) {
  if (st.shots.length >= OCR_MAX) { ocrMsg(`${OCR_MAX} captures au maximum à la fois : enregistre celles-ci, puis continue.`, true); return; }
  const shot = { id: ++shotSeq, file, url: URL.createObjectURL(file), status: "new", n: 0, err: "", observedAt: file.lastModified || Date.now(), ocr: true };
  st.shots.push(shot);
  fingerprint(file).then(h => { shot.fp = h; }).catch(() => {});
  if (!st.modeTouched && capMode() === "update") setCapMode("add");
  hideDiff();
  ocr.queue = (ocr.queue || Promise.resolve()).then(() => ocrShot(shot));
}
async function pollCaptures() {
  if (!ocr.dir) return;
  try {
    for await (const [name, h] of ocr.dir.entries()) {
      if (h.kind !== "file" || !/\.(png|jpe?g|webp)$/i.test(name) || ocr.seen.has(name)) continue;
      const f = await h.getFile();
      ocr.seen.add(name);
      if (f.lastModified >= ocr.since) addOcrFile(f);
    }
  } catch (err) { ocrMsg("Lecture du dossier impossible : " + errText(err), true); stopWatch(); }
}
function stopWatch() { clearInterval(ocr.timer); ocr.timer = null; ocr.dir = null; $("#ocrWatch").hidden = false; $("#ocrStop").hidden = true; }
$("#ocrWatch").addEventListener("click", async () => {
  if (!window.showDirectoryPicker) return ocrMsg("Ton navigateur ne permet pas de surveiller un dossier : utilise Chrome ou Edge, ou colle tes captures puis clique sur « Lire les infobulles ».", true);
  // Ouvre sur « Images » (les captures Windows y sont, dans « Captures d'écran ») ; le navigateur retient ensuite le dernier choix.
  try { ocr.dir = await window.showDirectoryPicker({ id: "captures-sc", mode: "read", startIn: "pictures" }); } catch (_) { return; }
  ocr.since = Date.now() - 2000; ocr.seen = new Set();
  for await (const [name] of ocr.dir.entries()) ocr.seen.add(name);   // les anciennes captures sont ignorées
  $("#ocrWatch").hidden = true; $("#ocrStop").hidden = false;
  ocr.timer = setInterval(pollCaptures, 1500);
  ocrMsg(`Surveillance du dossier « ${ocr.dir.name} » : en jeu, survole une caisse et appuie sur Win+Impr. écran.`);
  ocrWorker().then(() => ocrMsg(`Prêt : surveillance du dossier « ${ocr.dir.name} ».`)).catch(err => ocrMsg(errText(err), true));
});
$("#ocrStop").addEventListener("click", () => { stopWatch(); ocrMsg("Surveillance arrêtée."); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) pollCaptures(); });
// Captures collées ou déposées : lecture gratuite au lieu de l'analyse par l'IA.
$("#ocrRead").addEventListener("click", () => {
  for (const s of pendingShots()) { s.ocr = true; ocr.queue = (ocr.queue || Promise.resolve()).then(() => ocrShot(s)); }
});

// « Séparer » : ce lot quitte son groupe de couleur et prend un nom à lui.
let splitSeq = 0;
$("#reviewBody").addEventListener("click", async e => {
  const rb = e.target.closest("[data-ref]");
  if (rb) {
    const it = st.items[+rb.dataset.ref], r = st.resources.find(x => x.id === it.target);
    if (!r || !it.crop) return;
    rb.disabled = true;
    try {
      if (st.libReady) {
        // Bibliothèque : l'image rejoint les vues de ce minerai, classée par écran ; l'ancienne principale reste.
        const id = await addToLibrary(r.id, it.crop, itemTerminal(it), "capture");
        if (rb.dataset.how === "main") await rpc("set_primary_image", { p_id: id });
        if (rb.dataset.how === "screen" && !(libById(id) || {}).screen_main) await rpc("set_screen_image", { p_id: id });
        await Promise.all([loadResources(), loadRefImages()]);
      } else if (rb.dataset.how === "main") {
        const old = r.image;
        await rpc("set_resource_image", { p_id: r.id, p_image: it.crop, p_replace: true });
        if (okImg(old)) await rpc("add_resource_ref", { p_id: r.id, p_image: old }).catch(() => {});
        r.refs = [...(r.refs || []).filter(x => x !== it.crop), ...(okImg(old) ? [old] : [])].slice(-6);
        r.image = it.crop;
      } else {
        await rpc("add_resource_ref", { p_id: r.id, p_image: it.crop });
        if (!okImg(r.image)) r.image = it.crop; else r.refs = [...(r.refs || []), it.crop].slice(-6);
      }
      renderReview(); renderAllStocks(); setStatus("");
    }
    catch (err) { setStatus(errText(err)); rb.disabled = false; }
    return;
  }
  const b = e.target.closest("[data-split]"); if (!b) return;
  const it = st.items[+b.dataset.split];
  // Emmène aussi les lots du groupe dont la couleur décrite est la même (même type de caillou).
  const same = st.items.filter(x => x.group === it.group);
  let moved = same.filter(x => norm(x.color) === norm(it.color));
  if (moved.length === same.length) moved = [it];
  const g = "split:" + (++splitSeq), name = `${it.name} (autre)`;
  for (const x of moved) { x.group = g; x.name = name; x.target = "new"; x.edited = true; }
  hideDiff(); renderReview();
  const inp = $(`#rv-name-${b.dataset.split}`); if (inp) { inp.focus(); inp.select(); }
});
$("#reviewBody").addEventListener("change", e => {
  const f = e.target.dataset.f; if (!f) return;
  const it = st.items[+e.target.closest("tr").dataset.i];
  if (f === "on") it.on = e.target.checked;
  else if (f === "qty") { it.qty = num(e.target.value); it.edited = true; }
  else if (f === "quality") { it.quality = qKey(e.target.value) === "-" ? "" : qKey(e.target.value); it.edited = true; }
  else if (f === "unit") { it.unit = e.target.value.trim(); it.edited = true; }
  else if (f === "name" || f === "target") {
    const v = f === "name" ? e.target.value.trim() : e.target.value;
    for (const x of st.items.filter(x => x.group === it.group)) {
      x.edited = true;
      if (f === "name") {
        x.name = v;
        const t = matchTarget(v);
        if (t !== "new") x.target = t;
      } else {
        x.target = v;
        const r = st.resources.find(r => r.id === v);
        if (r) x.name = r.name;
      }
    }
  }
  hideDiff(); renderReview();
});

// ---------- comparaison avec le dernier relevé, puis enregistrement transactionnel ----------
function hideDiff() { $("#diff").hidden = true; st.diff = null; $("#forceStale").hidden = true; $("#forceDup").hidden = true; $("#commit").hidden = false; }
const scanOwner = () => can("edit_others") && $("#capOwner").value && $("#capOwner").value !== st.me.id ? $("#capOwner").value : null;
function detectedTerminal() {
  const votes = {};
  for (const s of st.shots) if (s.terminal && s.terminal !== "inconnu") votes[s.terminal] = (votes[s.terminal] || 0) + 1;
  return (Object.entries(votes).sort((a, b) => b[1] - a[1])[0] || ["inconnu"])[0];
}
// Raffinerie : un ordre est un lot qui s'AJOUTE au stock du lieu (deux ordres s'additionnent), pas un relevé.
const isRefineryScan = () => ($("#capTerminal").value || detectedTerminal()) === "raffinerie";
const isAddScan = () => capMode() !== "update";
function scanPayload(extra = {}) {
  const times = st.shots.map(s => s.observedAt).filter(Boolean);
  const items = st.items.filter(it => it.target && it.target !== "new").map(it => {
    const doubt = it.edited || (it.confidence != null && it.confidence < 0.7);
    return { resource_id: it.target, quality_key: it.quality, quantity: num(it.qty), unit: (it.unit || "").trim(),
      confidence: it.confidence, validation_status: !it.on ? "rejected" : it.edited ? "corrected" : "accepted",
      ...(doubt && it.crop ? { image_reference: it.crop } : {}) };
  });
  return {
    location: $("#capPlace").value.trim(), owner_id: scanOwner(), terminal_type: $("#capTerminal").value || detectedTerminal(),
    coverage: isAddScan() ? "partial" : capCoverage(), ...(isAddScan() ? { mode: "add" } : {}), observed_at: new Date(times.length ? Math.min(...times) : Date.now()).toISOString(),
    fingerprints: st.shots.map(s => s.fp).filter(Boolean), page_count: st.shots.length, note: $("#capNote").value.trim(),
    items, ...extra,
  };
}
function setMsg(sel, t, err) { const el = $(sel); el.textContent = t; el.className = err ? "err" : "muted"; }
async function preview() {
  st.scanKey = crypto.randomUUID();
  st.diff = await rpc("apply_scan", { p: scanPayload(), p_dry_run: true });
  st.diff.add = isAddScan() ? capMode() : "";
  // Nature proposée d'office (modifiable) : production pour une fin de run, sortie de raffinerie, sinon dépôt.
  const def = capMode() === "run" ? "production" : isRefineryScan() ? "refined" : "deposit";
  if (st.diff.add) for (const c of st.diff.changes || []) { const k = `${c.resource_id}|${c.quality_key}|${c.unit}`; if (c.delta > 0 && !st.reasons[k]) st.reasons[k] = def; }
  renderDiff();
}
$("#compare").addEventListener("click", async () => {
  if (!$("#capPlace").value.trim()) { $("#capPlace").focus(); return setMsg("#compareMsg", "Choisis le lieu de stockage avant de comparer.", true); }
  if (!isAddScan() && capCoverage() === "complete" && st.shots.some(s => s.status !== "done"))
    return setMsg("#compareMsg", "Pour un inventaire complet, toutes les pages doivent être analysées sans erreur.", true);
  if (st.items.some(it => it.on && !it.name.trim())) return setMsg("#compareMsg", "Chaque ligne cochée doit avoir un nom.", true);
  const empty = st.items.filter(it => it.on && it.needQty && !(num(it.qty) > 0)).length;
  if (empty) return setMsg("#compareMsg", `${empty} ligne${empty > 1 ? "s" : ""} sans quantité : contenu en SCU d'une caisse (au survol en jeu) ou nombre de gemmes affiché sur la case (x1, x5…). Remplis-les ou décoche-les.`, true);
  $("#compare").disabled = true; setMsg("#compareMsg", "Comparaison avec le dernier relevé…");
  try {
    // Les nouvelles ressources rejoignent d'abord le catalogue (sans aucun stock).
    const fresh = new Map();
    for (const it of st.items) if (it.on && it.target === "new") { const k = norm(it.name); if (!fresh.has(k)) fresh.set(k, it); }
    for (const [k, it] of fresh) {
      const known = resByName(it.name);
      const id = known ? known.id : await createResource({ name: it.name, unit: "", color: it.hex, color_name: it.color }, "capture", "");
      for (const x of st.items) if (x.target === "new" && norm(x.name) === k) x.target = id;
    }
    if (fresh.size) await loadResources();
    await preview();
    setMsg("#compareMsg", "");
  } catch (err) { setMsg("#compareMsg", errText(err), true); }
  $("#compare").disabled = false;
});
function renderDiff() {
  const d = st.diff; if (!d) return;
  $("#diff").hidden = false;
  const ch = d.changes || [], notes = [];
  if (d.add) notes.push(`${d.add === "run" ? "Fin de run : la récolte" : isRefineryScan() ? "Raffinerie : chaque lot lu" : "Ajout : chaque lot lu"} s'ajoute au stock déjà enregistré${$("#capPlace").value.trim() ? " à " + $("#capPlace").value.trim() : ""} ; rien d'autre ne change.`);
  else notes.push(`${ch.length} variation${ch.length > 1 ? "s" : ""} et ${d.unchanged} ligne${d.unchanged > 1 ? "s" : ""} inchangée${d.unchanged > 1 ? "s" : ""} pour ${$("#capPlace").value.trim()}${scanOwner() ? " (inventaire de " + who(scanOwner()) + ")" : ""}.`);
  const firsts = ch.filter(c => c.initial).length;
  if (firsts) notes.push(`${firsts} premier${firsts > 1 ? "s" : ""} relevé${firsts > 1 ? "s" : ""} : point de départ, jamais compté comme apport.`);
  const abs = ch.filter(c => c.absent).length;
  if (abs) notes.push(`Attention : ${abs} ligne${abs > 1 ? "s" : ""} absente${abs > 1 ? "s" : ""} des captures passer${abs > 1 ? "ont" : "a"} à 0, car tu as indiqué un inventaire complet.`);
  if (d.duplicate_images) notes.push(d.add ? "Attention : cette capture a déjà été enregistrée pour ce lieu. L'enregistrer encore ajouterait les mêmes lots une deuxième fois."
    : "Attention : une de ces images a déjà été enregistrée pour ce lieu. Vérifie que ce n'est pas la même capture.");
  if ((d.unit_conflicts || []).length) notes.push(`${d.unit_conflicts.length} lot${d.unit_conflicts.length > 1 ? "s" : ""} absent${d.unit_conflicts.length > 1 ? "s" : ""} de la capture mais lu${d.unit_conflicts.length > 1 ? "s" : ""} dans une autre unité (${d.unit_conflicts.map(c => `${c.name} ${qLabel(c.quality_key)} ${fmt(c.quantity)} ${c.unit || "objets"}`).join(", ")}) : conservé${d.unit_conflicts.length > 1 ? "s" : ""} tel${d.unit_conflicts.length > 1 ? "s" : ""} quel${d.unit_conflicts.length > 1 ? "s" : ""}, pas remis à zéro. Vérifie l'unité lue (SCU ou objets).`);
  if ((d.similar || []).length) notes.push(`Attention : ${d.similar.length} lot${d.similar.length > 1 ? "s" : ""} identique${d.similar.length > 1 ? "s" : ""} (même minerai, qualité et quantité) ${d.similar.length > 1 ? "ont" : "a"} déjà été ajouté${d.similar.length > 1 ? "s" : ""} ici ces derniers jours. Vérifie qu'il ne s'agit pas du même lot.`);
  if (d.stale) notes.push(`Attention : cette capture est plus ancienne que le dernier état enregistré (${dateTxt(d.last_state_at)}). L'appliquer remplacerait un état plus récent.`);
  // Case isolée identique sur deux pages (même minerai, qualité et quantité) : peut-être la même case vue deux fois.
  if (!d.add && st.shots.length > 1) {
    const seen = new Map();
    for (const i of st.items.filter(x => x.on)) { const k = ScanLogic.sig(i); if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(i.shot); }
    const rep = [...seen.values()].filter(p => p.size > 1).length;
    if (rep) notes.push(`À vérifier : ${rep} case${rep > 1 ? "s" : ""} identique${rep > 1 ? "s" : ""} sur plusieurs pages. Si c'est la même case vue deux fois, décoche le doublon (sinon elle serait comptée deux fois).`);
  }
  const dups = st.items.filter(i => i.dup && !i.on).length;
  if (dups) notes.push(`${dups} case${dups > 1 ? "s" : ""} probablement répétée${dups > 1 ? "s" : ""} entre deux pages ${dups > 1 ? "ont été décochées" : "a été décochée"}.`);
  $("#diffMsg").innerHTML = notes.map(esc).join("<br>");
  $("#diffBody").innerHTML = ch.map(c => {
    const k = `${c.resource_id}|${c.quality_key}|${c.unit}`;
    const nature = c.initial ? '<span class="tag">Stock initial</span>'
      : `<select data-reason="${esc(k)}" aria-label="Nature de la variation"><option value="">${c.delta > 0 ? "Hausse à classer (origine inconnue)" : "Baisse à classer (cause inconnue)"}</option>${
        (c.delta > 0 ? INC_KINDS : DEC_KINDS).map(x => `<option value="${x}"${st.reasons[k] === x ? " selected" : ""}>${KIND[x]}</option>`).join("")}</select>`;
    return `<tr class="${c.absent ? "low" : ""}"><td>${resCell(resOf(c.resource_id), c.name)}${c.absent ? '<div class="colordesc">absent des captures</div>' : ""}</td>
      <td class="num">${qLabel(c.quality_key)}</td><td>${esc(c.unit || "objets")}</td><td class="num">${fmt(c.before)}</td><td class="num">${fmt(c.after)}</td>
      <td class="num ${c.delta > 0 ? "up" : "down"}"><strong>${c.delta > 0 ? "+" : ""}${fmt(c.delta)}</strong></td><td>${nature}</td></tr>`;
  }).join("") || '<tr><td colspan="7" class="muted">Aucune variation : le stock est identique au dernier relevé.</td></tr>';
  $("#commit").textContent = ch.length ? `Enregistrer ${ch.length} variation${ch.length > 1 ? "s" : ""}` : "Enregistrer ce relevé";
  $("#commit").hidden = !!d.stale;
  $("#forceStale").hidden = !d.stale;
  $("#commitMsg").textContent = "";
  $("#diff").scrollIntoView({ block: "nearest" });
}
$("#diffBody").addEventListener("change", e => { const s = e.target.closest("[data-reason]"); if (s) st.reasons[s.dataset.reason] = s.value; });
$("#diffBack").addEventListener("click", () => { hideDiff(); $("#review").scrollIntoView({ block: "nearest" }); });
async function commitScan(allowStale, allowDup) {
  if (!st.diff) return;
  const place = $("#capPlace").value.trim();
  $("#commit").disabled = true; $("#forceStale").disabled = true; $("#forceDup").disabled = true; setMsg("#commitMsg", "Enregistrement…");
  const reasons = {}; for (const [k, v] of Object.entries(st.reasons)) if (v) reasons[k] = v;
  try {
    const res = await rpc("apply_scan", { p: scanPayload({ idempotency_key: st.scanKey, state_token: st.diff.state_token, reasons, allow_stale: !!allowStale, allow_duplicate: !!allowDup }), p_dry_run: false });
    // Vignettes vérifiées → bibliothèque : une par minerai et par écran, tant qu'il en a moins de 5 pour cet écran.
    // Sans la case cochée, seulement la première image des ressources qui n'en ont aucune.
    const learn = $("#capLearn").checked && st.libReady, done = new Set();
    let learned = 0;
    for (const it of st.items) {
      const r = resOf(it.target), term = itemTerminal(it), key = it.target + "|" + term;
      if (!it.on || !it.crop || !r || done.has(key)) continue;
      done.add(key);
      if (!okImg(r.image)) {
        await (st.libReady ? addToLibrary(r.id, it.crop, term, "capture") : rpc("set_resource_image", { p_id: r.id, p_image: it.crop }))
          .then(() => learned++, err => console.warn(err));
      } else if (learn && !refsOf(r).includes(it.crop) && libOf(r.id).filter(x => x.terminal_type === term).length < 5) {
        await addToLibrary(r.id, it.crop, term, "capture").then(() => learned++, err => console.warn(err));
      }
    }
    if (learned) loadRefImages();
    const n = (res.changes || []).length;
    clearCapture(); $("#capNote").value = "";
    capMsg(`Relevé enregistré pour ${place} : ${n} variation${n > 1 ? "s" : ""}${res.replayed ? " (cette opération était déjà enregistrée)" : ""}${learned ? ` · ${learned} vignette${learned > 1 ? "s ajoutées" : " ajoutée"} à la bibliothèque` : ""}.`);
    await loadStocks(); loadMyMoves();
  } catch (err) {
    const m = errText(err);
    if (/STATE_CHANGED/.test(m)) {
      try { await preview(); setMsg("#commitMsg", "L'inventaire a changé entre-temps : l'aperçu a été recalculé, vérifie-le avant d'enregistrer.", true); }
      catch (e2) { setMsg("#commitMsg", errText(e2), true); }
    } else if (/DUPLICATE/.test(m)) {
      // Même image déjà ajoutée à ce lieu : on n'ajoute une deuxième fois que sur confirmation explicite.
      $("#commit").hidden = true; $("#forceDup").hidden = false; setMsg("#commitMsg", m.replace(/^DUPLICATE:\s*/, ""), true);
    } else if (/STALE/.test(m)) {
      st.diff.stale = true; renderDiff(); setMsg("#commitMsg", m.replace(/^STALE:\s*/, ""), true);
    } else setMsg("#commitMsg", m, true);
  }
  $("#commit").disabled = false; $("#forceStale").disabled = false; $("#forceDup").disabled = false;
}
$("#commit").addEventListener("click", () => commitScan(false));
$("#forceStale").addEventListener("click", () => commitScan(true, !$("#forceDup").hidden));
$("#forceDup").addEventListener("click", () => commitScan(!!(st.diff && st.diff.stale), true));

// ---------- bibliothèque d'images de référence ----------
const TERM = { inventaire: "Inventaire personnel", ascenseur_fret: "Ascenseur de fret", asop: "Terminal ASOP", raffinerie: "Raffinerie", autre: "Autre écran", inconnu: "Écran non précisé" };
const libOf = id => st.refImages.filter(x => x.resource_id === id);
const libById = id => st.refImages.find(x => String(x.id) === String(id));
// Image d'un minerai pour un écran : celle choisie pour cet écran, sinon la plus récente de cet écran.
function screenRef(resourceId, term) {
  if (!term || term === "inconnu") return null;
  const l = libOf(resourceId).filter(x => x.terminal_type === term);
  return l.find(x => x.screen_main) || l.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}
// Écran d'une case lue : celui choisi pour la capture, sinon celui détecté par l'IA sur sa page.
function itemTerminal(it) {
  if ($("#capTerminal").value) return $("#capTerminal").value;
  const s = st.shots.find(x => x.id === it.shot);
  return (s && s.terminal) || "inconnu";
}
async function addToLibrary(resourceId, image, terminal, source) {
  return rpc("add_reference_image", { p_resource: resourceId, p_image: image, p_terminal: terminal || "inconnu", p_source: source || "capture", p_note: "" });
}

function renderImages() {
  const q = norm($("#iQ").value), t = $("#iTerm").value;
  const rs = $("#iRes"), cur = rs.value;
  rs.innerHTML = st.resources.slice().sort(byName).map(r => `<option value="${esc(r.id)}">${esc(r.name)}${r.name_en && norm(r.name_en) !== norm(r.name) ? " (" + esc(r.name_en) + ")" : ""}</option>`).join("");
  if (cur && st.resources.some(r => r.id === cur)) rs.value = cur;
  const list = st.resources.filter(r => !q || resMatch(r, q)).sort(byName);
  let shown = 0;
  $("#imgGrid").innerHTML = list.map(r => {
    const imgs = libOf(r.id).filter(x => !t || x.terminal_type === t);
    const all = libOf(r.id), counts = {};
    for (const x of all) counts[x.terminal_type] = (counts[x.terminal_type] || 0) + 1;
    if (t && !imgs.length) return "";
    shown++;
    const summary = Object.keys(TERM).filter(k => counts[k]).map(k => `${counts[k]} ${TERM[k].toLowerCase()}`).join(" · ") || "aucune image";
    return `<section class="imgcard">
      <div class="imgcard-h">${resCell(r)}<span class="muted">${esc(summary)}</span></div>
      ${imgs.length ? `<div class="imgrow">${imgs.map(x => {
        const main = x.image === r.image, mine = st.me && (x.added_by === st.me.id || can("catalog"));
        const sr = screenRef(r.id, x.terminal_type), isScreen = sr && sr.id === x.id;
        return `<figure class="refimg${main ? " main" : ""}">
          <img src="${esc(x.image)}" alt="${esc(r.name)}, ${esc(TERM[x.terminal_type])}" loading="lazy">
          <figcaption><span class="tag">${esc(TERM[x.terminal_type])}</span>${main ? '<span class="tag ok">Principale</span>' : ""}${isScreen ? `<span class="tag ok" title="${x.screen_main ? "Choisie" : "Plus récente, aucune choisie"} pour comparer les captures de cet écran">Image de l'écran${x.screen_main ? "" : " (auto)"}</span>` : ""}
            <span class="muted">${esc(who(x.added_by))}, ${dateTxt(x.created_at)}</span></figcaption>
          <div class="acts">${main || !can("catalog") ? "" : `<button type="button" data-lib="main" data-id="${x.id}">Principale</button>`}${!can("catalog") || x.terminal_type === "inconnu" || !("screen_main" in x) || (isScreen && !x.screen_main) ? "" : `<button type="button" data-lib="screen" data-id="${x.id}" title="${x.screen_main ? "Ne plus imposer cette image pour cet écran" : "Utiliser cette image pour comparer les captures de cet écran"}">${x.screen_main ? "Retirer le choix" : "Pour cet écran"}</button>`}${mine ? `<button type="button" class="danger" data-lib="del" data-id="${x.id}">Retirer</button>` : ""}</div>
        </figure>`;
      }).join("")}</div>` : '<div class="muted" style="padding:4px 0 8px">Aucune image : ajoute une capture de ce caillou ci-dessus, ou depuis la vérification d\'une capture.</div>'}
    </section>`;
  }).join("");
  $("#imgEmpty").hidden = shown > 0;
  const nRes = new Set(st.refImages.map(x => x.resource_id)).size;
  $("#imgCount").textContent = `${st.refImages.length} image${st.refImages.length > 1 ? "s" : ""} pour ${nRes} ressource${nRes > 1 ? "s" : ""}`;
}
$("#iQ").addEventListener("input", renderImages);
$("#iTerm").addEventListener("change", renderImages);
$("#imgGrid").addEventListener("click", async e => {
  const b = e.target.closest("[data-lib]"); if (!b) return;
  const x = libById(b.dataset.id); if (!x) return;
  if (b.dataset.lib === "del" && !b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
  b.disabled = true;
  try {
    if (b.dataset.lib === "main") await rpc("set_primary_image", { p_id: x.id });
    else if (b.dataset.lib === "screen") await rpc("set_screen_image", { p_id: x.id });
    else await rpc("delete_reference_image", { p_id: x.id });
    setStatus(""); await Promise.all([loadResources(), loadRefImages()]);
  } catch (err) { setStatus(errText(err)); b.disabled = false; }
});

// Ajout manuel : une ou plusieurs captures d'un seul caillou (recadrées avec Win+Maj+S), réduites à 240 px.
let pendingImgs = [];
async function toRefJpeg(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 240 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
async function queueImages(files) {
  const imgs = [...(files || [])].filter(f => f && f.type && f.type.startsWith("image/")).slice(0, 12);
  for (const f of imgs) { try { pendingImgs.push(await toRefJpeg(f)); } catch (_) {} }
  renderPending();
}
function renderPending() {
  $("#iPreview").innerHTML = pendingImgs.map((src, i) => `<span class="refcell"><img class="rimg" src="${src}" alt="Image à ajouter ${i + 1}"><button type="button" class="tdel" data-pend="${i}" aria-label="Retirer cette image">×</button></span>`).join("");
  $("#iAdd").disabled = !pendingImgs.length;
  $("#iAdd").textContent = pendingImgs.length > 1 ? `Ajouter ${pendingImgs.length} images` : "Ajouter à la bibliothèque";
}
$("#iPreview").addEventListener("click", e => { const b = e.target.closest("[data-pend]"); if (b) { pendingImgs.splice(+b.dataset.pend, 1); renderPending(); } });
$("#iDrop").addEventListener("click", () => $("#iFile").click());
$("#iDrop").addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#iFile").click(); } });
$("#iFile").addEventListener("change", e => { queueImages(e.target.files); e.target.value = ""; });
$("#iDrop").addEventListener("dragover", e => { e.preventDefault(); $("#iDrop").classList.add("over"); });
$("#iDrop").addEventListener("dragleave", () => $("#iDrop").classList.remove("over"));
$("#iDrop").addEventListener("drop", e => { e.preventDefault(); $("#iDrop").classList.remove("over"); queueImages(e.dataTransfer.files); });
document.addEventListener("paste", e => {
  if ($("#appView").hidden || $("#imgView").hidden) return;
  const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (fs.length) { e.preventDefault(); queueImages(fs); }
});
$("#iAdd").addEventListener("click", async () => {
  const m = $("#iMsg"), res = $("#iRes").value, term = $("#iAddTerm").value;
  if (!res) { m.textContent = "Choisis la ressource."; m.className = "formmsg err"; return; }
  $("#iAdd").disabled = true;
  let ok = 0;
  try {
    for (const src of pendingImgs) { await addToLibrary(res, src, term, "import"); ok++; }
    pendingImgs = []; renderPending();
    m.textContent = `${ok} image${ok > 1 ? "s ajoutées" : " ajoutée"} à « ${(resOf(res) || {}).name} » (${TERM[term].toLowerCase()}).`; m.className = "formmsg ok";
    await Promise.all([loadResources(), loadRefImages()]);
  } catch (err) { m.textContent = errText(err); m.className = "formmsg err"; pendingImgs = pendingImgs.slice(ok); renderPending(); }
});

// ---------- onglet Demandes (migration 009) ----------
const RQ_STATUS = { open: ["Ouverte", "low"], in_progress: ["Prise en charge", "warn"], done: ["Livrée", "ok"], cancelled: ["Annulée", "none"] };
async function loadRequests() {
  try { st.requests = await fetchAll("requests", "*", "id"); st.reqReady = true; }
  catch (_) { st.requests = []; st.reqReady = false; }   // migration 009 pas encore exécutée
  $("#tabReq").hidden = !st.reqReady;
  const open = st.requests.filter(r => r.status === "open").length;
  $("#reqCount").textContent = open; $("#reqCount").hidden = !open;
  renderKpis();
  if (!$("#reqView").hidden) renderRequests();
}
// Stocks visibles qui correspondent à la demande (même ressource, qualité suffisante), hors ceux du demandeur.
function rqMatches(r) {
  if (!r.resource_id) return [];
  return st.stocks.filter(s => s.resource_id === r.resource_id && num(s.quantity) > 0 && s.user_id !== r.requester_id
    && (r.min_quality == null || (s.quality_key !== "-" && +s.quality_key >= r.min_quality)))
    .sort((a, b) => num(b.quantity) - num(a.quantity));
}
function rqRow(r) {
  const me = st.me.id, mine = r.requester_id === me, taker = r.taken_by === me;
  const adm = isOwner() || (isAdmin() && r.org_id === st.me.org_id);
  const res = resOf(r.resource_id);
  const [lab, cls] = RQ_STATUS[r.status] || [r.status, "none"];
  const ms = r.status === "open" || r.status === "in_progress" ? rqMatches(r) : [];
  const avail = ms.length ? `${ms.slice(0, 3).map(s => `<div style="font-size:13px">${esc(who(s.user_id))} · ${esc(locName(s.location_id))} · ${qLabel(s.quality_key)} ×${fmt(s.quantity)}${unitTxt(s.unit)}</div>`).join("")}${ms.length > 3 ? `<div class="muted" style="font-size:12px">+${ms.length - 3} autre${ms.length > 4 ? "s" : ""}</div>` : ""}`
    : r.status === "open" || r.status === "in_progress" ? '<span class="muted" style="font-size:13px">' + (r.resource_id ? "Personne (dans ce que tu peux voir)" : "Ressource hors catalogue") + "</span>" : "";
  const b = (act, txt, extra = "") => `<button type="button" data-act="${act}" data-id="${r.id}"${extra}>${txt}</button>`;
  const acts = [];
  if (r.status === "open") acts.push(b("in_progress", "Je m'en occupe", ' class="primary"'));
  if (r.status === "in_progress" && (taker || mine || adm)) acts.push(b("open", taker ? "Je ne peux plus" : "Remettre ouverte"));
  if ((r.status === "open" || r.status === "in_progress") && (mine || adm || taker)) acts.push(b("done", "Livrée"));
  if ((r.status === "open" || r.status === "in_progress") && mine) acts.push(b("edit", "Modifier"));
  if ((r.status === "open" || r.status === "in_progress") && (mine || adm)) acts.push(b("cancelled", "Annuler", ' class="danger"'));
  if ((r.status === "done" || r.status === "cancelled") && (mine || adm)) acts.push(b("open", "Rouvrir"));
  const meta = [r.needed_by ? "pour le " + new Date(r.needed_by + "T12:00").toLocaleDateString("fr-FR") : "", r.note].filter(Boolean);
  return `<tr>
    <td>${res ? resCell(res) : `<span class="res-name">${esc(r.resource_name)}</span>`}${r.priority === "urgent" ? ' <span class="pill low">Urgent</span>' : ""}
      ${meta.length ? `<div class="muted" style="font-size:13px;margin-top:4px">${esc(meta.join(" · "))}</div>` : ""}</td>
    <td class="num">${fmt(r.quantity)}${unitTxt(esc(r.unit))}${r.min_quality != null ? `<div class="muted" style="font-size:12px">Q${r.min_quality} min.</div>` : ""}</td>
    <td>${esc(r.location) || '<span class="muted">–</span>'}</td>
    <td>${esc(who(r.requester_id))}${mine ? ' <span class="muted">(moi)</span>' : ""}<div class="muted" style="font-size:12px">${dateTxt(r.created_at)}</div></td>
    <td><span class="pill ${cls}">${lab}</span>${r.taken_by ? `<div class="muted" style="font-size:12px;margin-top:4px">par ${esc(who(r.taken_by))}</div>` : ""}</td>
    <td>${avail}</td>
    <td><div class="acts">${acts.join("")}</div></td>
  </tr>`;
}
function renderRequests() {
  if (!st.me) return;
  const f = $("#rqFilter").value, me = st.me.id;
  const keep = {
    active: r => r.status === "open" || r.status === "in_progress",
    mine: r => r.requester_id === me, taken: r => r.taken_by === me,
    closed: r => r.status === "done" || r.status === "cancelled", all: () => true,
  }[f] || (() => true);
  const rank = r => (r.status === "open" ? 0 : r.status === "in_progress" ? 1 : 2) * 2 + (r.priority === "urgent" ? 0 : 1);
  const rows = st.requests.filter(r => r.org_id === st.me.org_id || isOwner()).filter(keep)
    .sort((a, b) => rank(a) - rank(b) || String(b.created_at).localeCompare(String(a.created_at)));
  $("#rqBody").innerHTML = rows.map(rqRow).join("");
  $("#rqEmpty").hidden = rows.length > 0;
}
$("#rqFilter").addEventListener("change", renderRequests);
function rqResetForm() {
  st.rqEdit = null; $("#rqForm").reset();
  $("#rqTitle").textContent = "Nouvelle demande"; $("#rqGo").textContent = "Publier la demande"; $("#rqCancelEdit").hidden = true;
}
$("#rqCancelEdit").addEventListener("click", () => { rqResetForm(); $("#rqMsg").textContent = ""; });
$("#rqForm").addEventListener("submit", async e => {
  e.preventDefault();
  const m = $("#rqMsg"), name = $("#rqRes").value.trim();
  const res = resByName(name);
  const p = { resource_id: res ? res.id : "", resource_name: name, quantity: num($("#rqQty").value), unit: $("#rqUnit").value.trim(),
    min_quality: $("#rqQ").value === "" ? "" : Math.round(num($("#rqQ").value)), location: $("#rqPlace").value.trim(),
    needed_by: $("#rqBy").value, priority: $("#rqUrgent").checked ? "urgent" : "normal", note: $("#rqNote").value.trim() };
  $("#rqGo").disabled = true;
  try {
    if (st.rqEdit) await rpc("update_request", { p_id: st.rqEdit, p });
    else await rpc("create_request", { p });
    m.textContent = st.rqEdit ? "Demande modifiée." : `Demande publiée${res ? "" : " (ressource hors catalogue)"}.`; m.className = "formmsg ok";
    rqResetForm(); await loadRequests();
  } catch (err) { m.textContent = errText(err); m.className = "formmsg err"; }
  $("#rqGo").disabled = false;
});
$("#rqBody").addEventListener("click", async e => {
  const btn = e.target.closest("button[data-act]"); if (!btn) return;
  const r = st.requests.find(x => String(x.id) === btn.dataset.id); if (!r) return;
  if (btn.dataset.act === "edit") {
    st.rqEdit = r.id;
    $("#rqRes").value = (resOf(r.resource_id) || {}).name || r.resource_name; $("#rqQty").value = num(r.quantity); $("#rqUnit").value = r.unit;
    $("#rqQ").value = r.min_quality ?? ""; $("#rqPlace").value = r.location; $("#rqBy").value = r.needed_by || "";
    $("#rqUrgent").checked = r.priority === "urgent"; $("#rqNote").value = r.note;
    $("#rqTitle").textContent = "Modifier la demande"; $("#rqGo").textContent = "Enregistrer"; $("#rqCancelEdit").hidden = false;
    $("#rqMsg").textContent = ""; $("#rqForm").scrollIntoView({ behavior: "smooth", block: "start" }); $("#rqRes").focus();
    return;
  }
  if (btn.dataset.act === "cancelled" && btn.dataset.armed !== "1") {
    btn.dataset.armed = "1"; btn.textContent = "Confirmer l'annulation";
    setTimeout(() => { if (btn.isConnected) { btn.dataset.armed = ""; btn.textContent = "Annuler"; } }, 4000);
    return;
  }
  btn.disabled = true;
  try { await rpc("set_request_status", { p_id: r.id, p_status: btn.dataset.act }); await loadRequests(); }
  catch (err) { setStatus(errText(err)); btn.disabled = false; }
});

// ---------- onglet Blueprints (catalogue Star Citizen Wiki) ----------
// Lecture seule pour les stocks : on compare la recette aux stocks visibles, rien n'est jamais retiré.
const bp = { raw: new Map(), target: {}, loaded: false, loading: null, list: [], ing: new Map(), mats: [], map: {}, maps: [], owned: [], runs: [], errors: [],
  shown: 100, open: null, cache: null, ready: true };
const BP_STATUS = { suggested: "Suggestion à valider", confirmed: "Validée", rejected: "Aucune correspondance", unmatched: "Non trouvée" };
const bpStockScope = () => ($("#bpStock") || {}).value || (can("view_global") ? "org" : "me");
function bpStocks() {
  const me = st.me && st.me.id;
  return st.stocks.filter(s => num(s.quantity) > 0 && (bpStockScope() === "me" ? s.user_id === me : true));
}
async function fetchPaged(build) {
  const out = [];
  for (let p = 0; p < 50; p++) {
    const { data, error } = await build().range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    out.push(...data); if (data.length < 1000) break;
  }
  return out;
}
async function loadBlueprints() {
  if (bp.loading) return bp.loading;
  bp.loading = (async () => {
    try {
      const [list, ing, mats, maps, owned, runs] = await Promise.all([
        fetchPaged(() => sb.from("sc_blueprints").select("id, uuid, key, output_name, output_type, output_type_label, output_grade, craft_time_seconds, game_version, first_seen_version, missing_since, current_recipe_id, web_url, is_available_by_default").order("output_name")),
        fetchPaged(() => sb.from("sc_ingredients").select("id, recipe_id, tier_index, slot_key, slot_name, slot_position, required_count, option_count, option_index, kind, api_uuid, ore_uuid, name, quantity, unit, min_quality, sc_recipes!inner(is_current)").eq("sc_recipes.is_current", true).order("id")),
        fetchPaged(() => sb.from("sc_materials").select("*").order("name")),
        fetchPaged(() => sb.from("sc_material_map").select("*").order("api_uuid")),
        fetchPaged(() => sb.from("member_blueprints").select("user_id, blueprint_id, note, created_at").is("removed_at", null).order("id")),
        sb.from("sc_sync_runs").select("*").order("started_at", { ascending: false }).limit(10).then(r => { if (r.error) throw r.error; return r.data; }),
      ]);
      const ingBy = new Map();
      for (const i of ing) { if (!ingBy.has(i.recipe_id)) ingBy.set(i.recipe_id, []); ingBy.get(i.recipe_id).push(i); }
      Object.assign(bp, { list, ing: ingBy, mats, maps, owned, runs, loaded: true, ready: true, cache: null });
      bp.map = Object.fromEntries(maps.filter(m => m.status === "confirmed" && m.resource_id).map(m => [m.api_uuid, m.resource_id]));
      if (isAdmin()) {
        const { data } = await sb.from("sc_sync_errors").select("*").order("at", { ascending: false }).limit(30);
        bp.errors = data || [];
      }
    } catch (err) {
      bp.ready = false;
      $("#bpEmptyTxt").textContent = /does not exist|schema cache|relation/i.test(errText(err))
        ? "La base n'est pas encore à jour : un administrateur doit exécuter la migration 015 (blueprints)."
        : "Impossible de charger le catalogue : " + errText(err);
    }
    bp.loading = null;
    renderBlueprints();
  })();
  return bp.loading;
}
const bpIng = b => bp.ing.get(b.current_recipe_id) || [];
const bpOwners = b => bp.owned.filter(o => o.blueprint_id === b.id).map(o => o.user_id);
const craftTxt = s => s == null ? "" : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round(s % 3600 / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
function bpVerdict(b) {
  if (!bp.cache) bp.cache = new Map();
  if (!bp.cache.has(b.id)) bp.cache.set(b.id, BlueprintLogic.compare(bpIng(b), bpStocks(), bp.map, { crafts: 1 }));
  return bp.cache.get(b.id);
}
const verdictCell = v => v.craftable === true ? '<span class="bpok">Réalisable</span>'
  : v.craftable === false ? `<span class="bpshort">Manque ${esc(v.missing.filter(m => m.mapped).map(m => m.name).join(", "))}</span>`
  : '<span class="bpunk">Indéterminé</span>';
function syncLine() {
  const r = bp.runs.find(x => x.finished_at) || bp.runs[0];
  if (!r) return "Catalogue de l'API Star Citizen Wiki · aucune synchronisation pour l'instant.";
  const res = { success: "réussie", partial: "partielle (voir les erreurs)", error: "en échec", running: "en cours" }[r.status] || r.status;
  const ver = (bp.list.find(b => !b.missing_since) || {}).game_version;
  return `Catalogue de l'API Star Citizen Wiki${ver ? " · jeu " + ver : ""} · dernière synchronisation ${dateTxt(r.finished_at || r.started_at)} : ${res}`
    + ` · ${bp.list.filter(b => !b.missing_since).length} blueprints dans le catalogue`
    + (r.stats && r.stats.listed ? (num(r.stats.new_recipes) || num(r.stats.changed_recipes)
      ? ` (${num(r.stats.new_recipes)} recette(s) ajoutée(s), ${num(r.stats.changed_recipes)} modifiée(s))`
      : " (déjà à jour : aucune recette n'a changé dans l'API)") : "");
}
function renderBlueprints() {
  if ($("#bpView").hidden) return;
  if (!$("#bpStock")) {
    const sel = document.createElement("select"); sel.id = "bpStock"; sel.setAttribute("aria-label", "Stocks comparés");
    sel.innerHTML = (can("view_global") ? '<option value="org">Comparer aux stocks de l\'organisation</option>' : "") + '<option value="me">Comparer à mes stocks</option>';
    $("#bpSyncGo").before(sel); sel.addEventListener("change", () => { bp.cache = null; renderBlueprints(); });
  }
  $("#bpSyncGo").hidden = !isAdmin();
  $("#bpAdmin").hidden = !isAdmin() || !bp.loaded;
  $("#bpSync").textContent = bp.loaded ? syncLine() : "Chargement du catalogue…";
  $("#bpScope").textContent = bp.loaded ? (bpStockScope() === "org"
    ? "Comparaison avec les stocks de tous les membres de l'organisation, tous lieux confondus. Rien n'est retiré des stocks."
    : "Comparaison avec tes stocks seulement, tous lieux confondus. Rien n'est retiré des stocks.")
    : "";
  const sugg = bp.maps.filter(m => m.status === "suggested" && m.resource_id);
  const todo = bp.loaded && sugg.length > 0;
  $("#bpTodo").hidden = !todo;
  if (todo) $("#bpTodo").innerHTML = isAdmin()
    ? `<div><strong>${sugg.length} correspondance${sugg.length > 1 ? "s" : ""} à valider.</strong> Tant qu'une matière n'est pas reliée à une ressource du registre, ses blueprints restent « indéterminés ». Vérifie la liste puis valide-la en un clic, ou une par une plus bas.</div>
       <div class="muted" style="font-size:13px">${sugg.map(m => `${esc((bp.mats.find(x => x.api_uuid === m.api_uuid) || {}).name || "?")} → ${esc((resOf(m.resource_id) || {}).name || "?")}`).join(" · ")}</div>
       <div class="row"><button type="button" class="primary" data-confirmall>Valider ces ${sugg.length} correspondance${sugg.length > 1 ? "s" : ""}</button><button type="button" data-gomap>Voir le détail</button></div>`
    : `<div>Certaines matières ne sont pas encore reliées aux ressources du registre : les blueprints concernés restent « indéterminés » jusqu'à la validation par un administrateur.</div>`;
  const types = [...new Set(bp.list.map(b => b.output_type_label || b.output_type).filter(Boolean))].sort();
  const tSel = $("#bpType"), tCur = tSel.value;
  tSel.innerHTML = '<option value="">Tous les types</option>' + types.map(t => `<option>${esc(t)}</option>`).join("");
  tSel.value = types.includes(tCur) ? tCur : "";
  const q = norm($("#bpQ").value), own = $("#bpOwn").value, type = tSel.value, me = st.me && st.me.id;
  const rows = bp.list.filter(b => {
    if (b.missing_since && own !== "me" && own !== "org") return false;
    if (type && (b.output_type_label || b.output_type) !== type) return false;
    if (own === "me" && !bpOwners(b).includes(me)) return false;
    if (own === "org" && !bpOwners(b).length) return false;
    if (q && !norm(b.output_name + " " + b.key).includes(q) && !bpIng(b).some(i => norm(i.name).includes(q) || resMatch(resOf(bp.map[i.api_uuid]), q))) return false;
    if (own === "ok" && bpVerdict(b).craftable !== true) return false;
    return true;
  });
  $("#bpEmpty").hidden = rows.length > 0;
  if (bp.loaded && !rows.length && bp.list.length) $("#bpEmptyTxt").textContent = "Aucun blueprint pour ces filtres.";
  const page = rows.slice(0, bp.shown);
  $("#bpBody").innerHTML = page.map(b => {
    const ings = bpIng(b), owners = bpOwners(b);
    return `<tr class="grp${bp.open === b.id ? " open" : ""}" data-bp="${b.id}" style="cursor:pointer">
      <td><strong>${esc(b.output_name || b.key)}</strong>${b.missing_since ? ' <span class="tag warn">Retiré de l\'API</span>' : ""}${b.is_available_by_default ? ' <span class="tag">Par défaut</span>' : ""}<div class="colordesc">${esc(craftTxt(b.craft_time_seconds))}</div></td>
      <td>${esc(b.output_type_label || b.output_type || "")}${b.output_grade ? " · grade " + esc(b.output_grade) : ""}</td>
      <td class="muted" style="font-size:13px">${ings.length ? esc([...new Set(ings.map(i => i.name))].join(", ")) : "Recette non lue"}</td>
      <td>${ings.length ? verdictCell(bpVerdict(b)) : ""}</td>
      <td>${owners.includes(me) ? '<span class="tag">Moi</span> ' : ""}${owners.filter(o => o !== me).length ? `<span class="muted">${esc(owners.filter(o => o !== me).map(who).join(", "))}</span>` : ""}</td></tr>`;
  }).join("");
  $("#bpMoreBox").hidden = rows.length <= bp.shown;
  $("#bpCount").textContent = `${page.length} sur ${rows.length}`;
  renderBpDetail();
  if (isAdmin() && bp.loaded) renderBpAdmin();
}
// Qualités en stock pour une matière de la recette, dans l'unité de la recette (cSCU convertis en SCU).
// Vert : qualité suffisante pour la qualité visée ; grisé : en dessous. Les lots dans une autre unité sont signalés à part.
function stockQualities(o) {
  const byQ = {}, other = {};
  for (const s of bpStocks()) {
    if (s.resource_id !== o.resource_id) continue;
    const v = BlueprintLogic.inUnit(num(s.quantity), s.unit || "", o.unit || "");
    if (v == null) { const u = s.unit || "objets"; other[u] = num(other[u]) + num(s.quantity); continue; }
    byQ[s.quality_key] = num(byQ[s.quality_key]) + v;
  }
  const ks = Object.keys(byQ).sort(byQdesc);
  const ok = k => o.min_quality == null ? true : k === "-" ? o.min_quality <= 0 : +k >= o.min_quality;
  const chips = ks.map(k => `<span class="lot${ok(k) ? " hi" : " low"}" title="${ok(k) ? "Qualité suffisante" : "Sous la qualité visée"}"><b>${k === "-" ? "Q?" : "Q" + k}</b> ${fmt(byQ[k])}${o.unit ? " " + esc(o.unit) : ""}</span>`).join("");
  const rest = Object.entries(other).map(([u, v]) => `${fmt(v)} ${esc(u)}`).join(", ");
  return (chips ? `<div class="lots">${chips}</div>` : "") + (rest ? `<div class="colordesc">+ ${rest} non comptés (autre unité)</div>` : "")
    || '<div class="colordesc">rien en stock</div>';
}
function renderBpDetail() {
  const b = bp.list.find(x => x.id === bp.open);
  $("#bpDetail").hidden = !b; if (!b) return;
  const ings = bpIng(b), tiers = [...new Set(ings.map(i => i.tier_index))].sort((x, y) => x - y);
  $("#bpTier").hidden = tiers.length < 2;
  if (tiers.length > 1 && $("#bpTier").options.length !== tiers.length) $("#bpTier").innerHTML = tiers.map(t => `<option value="${t}">Palier ${t + 1}</option>`).join("");
  const tier = tiers.length > 1 ? Number($("#bpTier").value) || 0 : (tiers[0] || 0);
  const crafts = Math.max(1, Math.min(999, Math.floor(num($("#bpCrafts").value) || 1)));
  // Qualité visée : par pièce, sinon pour toutes ; jamais en dessous du minimum de la recette.
  // Le stock n'est alors compté qu'à partir de cette qualité.
  if (!bp.raw.has(b.current_recipe_id) && b.current_recipe_id) loadBpRaw(b.current_recipe_id);
  const mods = BlueprintLogic.modifiersBySlot(bp.raw.get(b.current_recipe_id));
  const qAll = $("#bpQall").value === "" ? null : Math.max(0, Math.min(1000, Math.round(num($("#bpQall").value))));
  const target = key => bp.target[key] != null ? bp.target[key] : qAll;
  const wanted = ings.map(i => { const t = target(i.slot_key); return t == null || i.min_quality == null ? i : { ...i, min_quality: Math.max(i.min_quality, t) }; });
  const v = BlueprintLogic.compare(wanted, bpStocks(), bp.map, { tier, crafts });
  const max = v.craftable === null ? null : BlueprintLogic.maxCrafts(wanted, bpStocks(), bp.map, { tier });
  $("#bpTitle").textContent = b.output_name || b.key;
  $("#bpMeta").innerHTML = `${esc(b.output_type_label || "")}${b.craft_time_seconds ? " · fabrication " + esc(craftTxt(b.craft_time_seconds)) : ""} · version ${esc(b.game_version || "?")} · <span class="num">${esc(b.key)}</span>${b.web_url ? ` · <a href="${esc(b.web_url)}" target="_blank" rel="noopener">fiche</a>` : ""}`;
  $("#bpMine").checked = bpOwners(b).includes(st.me && st.me.id);
  $("#bpVerdict").innerHTML = !ings.length ? "La recette n'a pas encore été lue : lance une synchronisation."
    : v.craftable === true ? `<span class="bpok">Réalisable ×${crafts}</span> avec les stocks comparés${max ? ` · jusqu'à ${max === 999 ? "999 ou plus" : max} fabrication${max > 1 ? "s" : ""}` : ""}.`
    : v.craftable === false ? `<span class="bpshort">Ressources manquantes pour ×${crafts}</span> : ${v.missing.filter(m => m.mapped).map(m => `${fmt(m.missing)} ${esc(m.unit || "objets")} de ${esc(m.name)}${m.min_quality ? " Q" + m.min_quality + "+" : ""}`).join(", ")}${v.missing.some(m => !m.mapped) ? ", plus des matières sans correspondance validée" : ""}.`
    : `<span class="bpunk">Indéterminé</span> : ${v.missing.some(m => !m.mapped) || v.slots.some(s => s.options.some(o => o.status === "unmapped")) ? "certaines matières n'ont pas de correspondance validée avec le registre" : "l'API ne fournit pas toutes les données (quantité ou qualité minimale)"}.`;
  const resName = id => (resOf(id) || {}).name || "?";
  const apiMin = key => Math.max(0, ...ings.filter(i => i.slot_key === key && i.min_quality != null).map(i => i.min_quality));
  const effAt = (key, q) => (mods[key] || []).map(m => ({ label: m.label, better: m.better_when, k: BlueprintLogic.modifierAt(m, q) }));
  const effTxt = list => list.map(e => e.k == null ? `${esc(e.label)} <span class="muted">effet non fourni</span>`
    : `${esc(e.label)} <span class="${(e.k > 1) === (e.better !== "lower") && e.k !== 1 && e.better !== "neutral" ? "up" : e.k !== 1 && e.better !== "neutral" ? "down" : ""}">${e.k >= 1 ? "+" : "−"}${fmt(Math.abs(e.k - 1) * 100)} %</span>`).join("<br>");
  $("#bpIngBody").innerHTML = v.slots.map(s => s.options.map((o, k) => {
    const mapRow = bp.maps.find(m => m.api_uuid === o.api_uuid);
    const reg = o.resource_id ? esc(resName(o.resource_id)) + ((resOf(o.resource_id) || {}).name_en ? ` <span class="muted" lang="en">(${esc(resOf(o.resource_id).name_en)})</span>` : "") + stockQualities(o) : mapRow && mapRow.status === "suggested" && mapRow.resource_id
      ? `<span class="bpunk">À valider : ${esc(resName(mapRow.resource_id))}</span>${isAdmin() ? ` <button type="button" class="linkbtn" data-okmap="${esc(o.api_uuid)}" data-res="${esc(mapRow.resource_id)}">Valider</button>` : ""}`
      : `<span class="muted">Aucune</span>${isAdmin() ? ' <button type="button" class="linkbtn" data-gomap>Choisir…</button>' : ""}`;
    const st_ = o.status === "alternative" ? '<span class="muted">alternative</span>' : o.status === "ok" ? '<span class="bpok">0</span>'
      : o.status === "short" ? `<span class="bpshort">${fmt(o.missing)}</span>` : o.status === "no_quantity" ? '<span class="bpunk">quantité inconnue</span>' : '<span class="bpunk">?</span>';
    const avail = o.resource_id ? `${fmt(o.available_ok)}${o.available !== o.available_ok ? ` <span class="muted" title="Dont sous la qualité minimale ou de qualité inconnue">(${fmt(o.available)} au total${o.unknown_quality ? ", " + fmt(o.unknown_quality) + " de qualité inconnue" : ""})</span>` : ""}` : "";
    return `<tr${o.status === "alternative" ? ' class="muted"' : ""}>
      <td>${k === 0 ? esc(s.slot_name || s.slot_key) + (s.choice ? ` <span class="tag">au choix : ${s.pick} sur ${s.options.length}</span>` : "") : ""}</td>
      <td>${esc(o.name)} <span class="muted">${o.kind === "item" ? "objet" : "raffiné"}</span></td>
      <td class="num">${o.need_value == null ? "non fourni" : fmt(o.need_value) + " " + esc(o.unit || "objets")}</td>
      <td class="num">${(ings.find(i => i.slot_key === s.slot_key && i.option_index === o.option_index) || {}).min_quality ?? "non fournie"}</td>
      <td class="num">${k === 0 ? `<input type="number" class="qin" min="0" max="1000" step="1" data-tq="${esc(s.slot_key)}" value="${bp.target[s.slot_key] ?? ""}" placeholder="${qAll ?? apiMin(s.slot_key)}" aria-label="Qualité visée pour ${esc(s.slot_name || s.slot_key)}">` : ""}</td>
      <td class="bpeff">${k === 0 ? effTxt(effAt(s.slot_key, target(s.slot_key) ?? apiMin(s.slot_key))) || '<span class="muted">aucun</span>' : ""}</td>
      <td>${reg}</td><td class="num">${avail}</td><td class="num">${st_}</td></tr>`;
  }).join("")).join("");
  // Résumé des effets par propriété (estimation : produit des effets de chaque pièce).
  const props = new Map();
  for (const s of v.slots) for (const e of effAt(s.slot_key, target(s.slot_key) ?? apiMin(s.slot_key))) {
    if (!props.has(e.label)) props.set(e.label, { better: e.better, list: [] });
    props.get(e.label).list.push({ slot: s.slot_name || s.slot_key, k: e.k });
  }
  $("#bpStats").hidden = !props.size;
  $("#bpStats").innerHTML = props.size ? `<table><thead><tr><th>Propriété</th><th>Pièces</th><th class="num">Effet estimé</th></tr></thead><tbody>${[...props].map(([label, p]) => {
    const known = p.list.every(x => x.k != null), tot = known ? p.list.reduce((a, x) => a * x.k, 1) : null;
    return `<tr><td>${esc(label)}${p.better === "lower" ? ' <span class="muted">(plus bas = mieux)</span>' : p.better === "neutral" ? ' <span class="muted">(neutre)</span>' : ""}</td>
      <td class="muted" style="font-size:13px">${p.list.map(x => `${esc(x.slot)} ${x.k == null ? "?" : (x.k >= 1 ? "+" : "−") + fmt(Math.abs(x.k - 1) * 100) + " %"}`).join(" · ")}</td>
      <td class="num">${tot == null ? "inconnu" : (tot >= 1 ? "+" : "−") + fmt(Math.abs(tot - 1) * 100) + " %"}</td></tr>`;
  }).join("")}</tbody></table>` : "";
  $("#bpNotes").textContent = "Qualité visée : le stock n'est compté qu'à partir de cette qualité, et l'effet affiché est celui de l'API à cette qualité (interpolation linéaire, ou par segments quand l'API les donne). "
    + "Quand plusieurs pièces touchent la même propriété, l'effet total est estimé en multipliant leurs effets. "
    + "Disponible : quantité de qualité suffisante dans les stocks comparés (cSCU convertis en SCU : 100 cSCU = 1 SCU ; les objets ne sont jamais convertis). "
    + "Une qualité inconnue ne compte que si aucune qualité minimale n'est demandée. Un même lot n'est jamais compté pour deux emplacements. Ce calcul ne retire rien des stocks.";
}
function renderBpAdmin() {
  const used = new Map();
  for (const b of bp.list) for (const i of bpIng(b)) { used.set(i.api_uuid, (used.get(i.api_uuid) || 0) + 1); if (i.ore_uuid) used.set(i.ore_uuid, used.get(i.ore_uuid) || 0); }
  const f = $("#bpMapFilter").value;
  const opts = st.resources.slice().sort(byName).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  const rows = bp.mats.map(m => ({ m, mm: bp.maps.find(x => x.api_uuid === m.api_uuid) || { status: "unmatched" } }))
    .filter(({ mm }) => f !== "todo" || ["suggested", "unmatched"].includes(mm.status))
    .sort((a, b) => (used.get(b.m.api_uuid) || 0) - (used.get(a.m.api_uuid) || 0));
  const nSugg = bp.maps.filter(m => m.status === "suggested" && m.resource_id).length;
  $("#bpConfirmAll").hidden = !nSugg;
  $("#bpConfirmAll").textContent = `Valider les ${nSugg} suggestion${nSugg > 1 ? "s" : ""}`;
  $("#bpMapBody").innerHTML = rows.map(({ m, mm }) => `<tr data-mat="${esc(m.api_uuid)}">
      <td><strong>${esc(m.name)}</strong></td><td>${m.kind === "ore" ? "minerai brut" : m.kind === "item" ? "objet" : "ressource raffinée"}</td>
      <td class="num">${used.get(m.api_uuid) || 0}</td>
      <td><span class="tag${mm.status === "suggested" ? " warn" : ""}">${esc(BP_STATUS[mm.status] || mm.status)}</span>${mm.reason && mm.status !== "confirmed" ? `<div class="colordesc">${esc(mm.reason)}${mm.confidence ? ` (${Math.round(mm.confidence * 100)} %)` : ""}</div>` : ""}</td>
      <td><select data-mapres aria-label="Ressource du registre pour ${esc(m.name)}"><option value="">—</option>${opts}</select></td>
      <td style="white-space:nowrap"><button type="button" data-mapact="confirm">Valider</button> <button type="button" data-mapact="reject">Aucune</button>${mm.status === "confirmed" || mm.status === "rejected" ? ' <button type="button" data-mapact="reset">Réinitialiser</button>' : ""}</td></tr>`).join("")
    || '<tr><td colspan="6" class="muted">Rien à traiter.</td></tr>';
  for (const { m, mm } of rows) { const sel = document.querySelector(`tr[data-mat="${m.api_uuid}"] [data-mapres]`); if (sel && mm.resource_id) sel.value = mm.resource_id; }
  $("#bpRuns").innerHTML = bp.runs.map(r => `<tr><td>${dateTxt(r.started_at)}</td><td>${r.trigger === "cron" ? "Automatique" : "Manuel" + (r.requested_by ? " (" + esc(who(r.requested_by)) + ")" : "")}</td>
      <td><span class="tag${r.status === "success" ? "" : " warn"}">${esc({ success: "Réussie", partial: "Partielle", error: "Échec", running: "En cours" }[r.status] || r.status)}</span></td>
      <td class="muted" style="font-size:13px">${r.stats ? esc(`${num(r.stats.listed)} listés · ${num(r.stats.to_fetch)} relus · ${num(r.stats.new_recipes)} nouvelles · ${num(r.stats.changed_recipes)} modifiées · ${num(r.stats.errors)} erreur(s)`) : ""}${r.error ? " · " + esc(r.error) : ""}</td></tr>`).join("")
    || '<tr><td colspan="4" class="muted">Aucune synchronisation.</td></tr>';
  $("#bpErrors").innerHTML = bp.errors.map(e => `<li><div><strong>${esc(e.context)}</strong> · ${esc(e.message)}</div><div class="meta">${ago(e.at)}</div></li>`).join("");
}
$("#bpQ").addEventListener("input", debounce(() => { bp.shown = 100; renderBlueprints(); }, 200));
["#bpType", "#bpOwn"].forEach(s => $(s).addEventListener("change", () => { bp.shown = 100; renderBlueprints(); }));
$("#bpMore").addEventListener("click", () => { bp.shown += 200; renderBlueprints(); });
$("#bpBody").addEventListener("click", e => {
  const r = e.target.closest("[data-bp]"); if (!r) return;
  bp.open = Number(r.dataset.bp) === bp.open ? null : Number(r.dataset.bp);
  $("#bpCrafts").value = 1; $("#bpTier").innerHTML = ""; bp.target = {}; $("#bpQall").value = bp.qAllApplied = ""; $("#bpQrange").value = 0;
  renderBlueprints(); if (bp.open) $("#bpDetail").scrollIntoView({ block: "nearest" });
});
$("#bpClose").addEventListener("click", () => { bp.open = null; renderBlueprints(); });
// Extrait brut de la recette (effets de la qualité par pièce), chargé à la demande.
async function loadBpRaw(id) {
  bp.raw.set(id, null);
  const { data } = await sb.from("sc_recipes").select("id, raw").eq("id", id).maybeSingle();
  bp.raw.set(id, data ? data.raw : null);
  renderBpDetail();
}
$("#bpQrange").addEventListener("input", () => { $("#bpQall").value = bp.qAllApplied = $("#bpQrange").value; bp.target = {}; renderBpDetail(); });
// Ne recalcule que si la valeur a vraiment changé (sinon quitter le champ effacerait le réglage d'une pièce).
$("#bpQall").addEventListener("change", () => {
  if ($("#bpQall").value === (bp.qAllApplied ?? "")) return;
  bp.qAllApplied = $("#bpQall").value; $("#bpQrange").value = $("#bpQall").value || 0; bp.target = {}; renderBpDetail();
});
$("#bpQreset").addEventListener("click", () => { $("#bpQall").value = bp.qAllApplied = ""; $("#bpQrange").value = 0; bp.target = {}; renderBpDetail(); });
$("#bpIngBody").addEventListener("change", e => {
  const i = e.target.closest("[data-tq]"); if (!i) return;
  if (i.value === "") delete bp.target[i.dataset.tq]; else bp.target[i.dataset.tq] = Math.max(0, Math.min(1000, Math.round(num(i.value))));
  renderBpDetail();
});
["#bpCrafts", "#bpTier"].forEach(s => $(s).addEventListener("input", renderBpDetail));
$("#bpMine").addEventListener("change", async () => {
  const b = bp.list.find(x => x.id === bp.open); if (!b) return;
  $("#bpMine").disabled = true;
  try { await rpc("set_member_blueprint", { p_blueprint: b.id, p_owned: $("#bpMine").checked, p_note: "", p_owner: null }); await loadBlueprints(); }
  catch (err) { setStatus(errText(err)); $("#bpMine").checked = !$("#bpMine").checked; }
  $("#bpMine").disabled = false;
});
$("#bpMapFilter").addEventListener("change", renderBpAdmin);
// Validation des correspondances suggérées (chacune passe par sc_set_material_map, réservée aux administrateurs).
async function confirmMaps(list, btn) {
  if (btn) btn.disabled = true;
  let ok = 0; const errs = [];
  for (const m of list) {
    try { await rpc("sc_set_material_map", { p_uuid: m.api_uuid, p_action: "confirm", p_resource: m.resource_id }); ok++; }
    catch (err) { errs.push(((bp.mats.find(x => x.api_uuid === m.api_uuid) || {}).name || "?") + " : " + errText(err)); }
  }
  setStatus(errs.length ? `${ok} correspondance(s) validée(s). Non validées : ${errs.join(" ; ")}` : "");
  await loadBlueprints();
}
document.addEventListener("click", e => {
  const all = e.target.closest("[data-confirmall], #bpConfirmAll"), one = e.target.closest("[data-okmap]"), go = e.target.closest("[data-gomap]");
  if (all && !$("#bpView").hidden) confirmMaps(bp.maps.filter(m => m.status === "suggested" && m.resource_id), all);
  else if (one) confirmMaps([{ api_uuid: one.dataset.okmap, resource_id: one.dataset.res }], one);
  else if (go) { $("#bpMapFilter").value = "todo"; renderBpAdmin(); $("#bpAdmin").scrollIntoView({ block: "start" }); }
});
$("#bpMapBody").addEventListener("click", async e => {
  const b = e.target.closest("[data-mapact]"); if (!b) return;
  const tr = b.closest("tr"), res = tr.querySelector("[data-mapres]").value || null;
  b.disabled = true;
  try { await rpc("sc_set_material_map", { p_uuid: tr.dataset.mat, p_action: b.dataset.mapact, p_resource: res }); setStatus(""); await loadBlueprints(); }
  catch (err) { setStatus(errText(err)); b.disabled = false; }
});
$("#bpRefresh").addEventListener("click", async () => {
  try { await rpc("sc_refresh_suggestions", {}); await loadBlueprints(); } catch (err) { setStatus(errText(err)); }
});
// Synchronisation manuelle : la fonction travaille par étapes d'environ 100 s ; on la relance jusqu'à la fin.
$("#bpSyncGo").addEventListener("click", async () => {
  const btn = $("#bpSyncGo"); btn.disabled = true;
  try {
    for (let i = 0; i < 40; i++) {
      $("#bpSync").textContent = i ? "Synchronisation en cours… (étape " + (i + 1) + ")" : "Synchronisation en cours…";
      const { data, error } = await sb.functions.invoke("sync-blueprints", { body: {} });
      if (error) { let m = "La synchronisation a échoué."; try { const j = await error.context.json(); m = j.error || m; } catch (_) {} throw new Error(m); }
      if (data.status === "busy") { $("#bpSync").textContent = "Une synchronisation est déjà en cours, nouvelle tentative dans 20 s…"; await new Promise(r => setTimeout(r, 20000)); continue; }
      if (data.status !== "continue") { setStatus(data.status === "error" ? "Synchronisation en échec : " + (data.error || "") : ""); break; }
      $("#bpSync").textContent = `Synchronisation en cours… ${data.pending} recette(s) restante(s)`;
    }
  } catch (err) { setStatus(errText(err)); }
  btn.disabled = false;
  await loadBlueprints();
});

// ---------- onglet Base de données (administrateurs) ----------
function showTab(tab) {
  document.querySelectorAll("#appTabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  for (const v of ["mine", "req", "global", "stats", "bp", "img", "db"]) $("#" + v + "View").hidden = tab !== v;
  if (tab === "bp") { if (!bp.loaded) loadBlueprints(); renderBlueprints(); }
  if (tab === "img") renderImages();
  if (tab === "db") { renderDb(); if (!hist.loaded) loadHistory(true); }
  if (tab === "stats") loadStats();
  if (tab === "req") renderRequests();
}
$("#appTabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });

// Édition directe des ressources. Une ligne modifiée et pas encore enregistrée n'est pas
// écrasée par les mises à jour en temps réel des autres membres.
const dirty = new Set();
function dbRow(r) {
  const held = st.stocks.filter(s => s.resource_id === r.id && num(s.quantity) > 0);
  return `<tr data-id="${esc(r.id)}">
    <td><input type="color" class="e-color" id="e-color-${esc(r.id)}" value="${okHex(r.color) || "#888888"}" data-had="${okHex(r.color) ? 1 : ""}" aria-label="Couleur de ${esc(r.name)}">
        ${refsOf(r).length ? `<div class="dbimg"><div class="refgrid">${refsOf(r).map((src, k) => `<span class="refcell"><img class="rimg" src="${esc(src)}" alt="" title="${k ? "Vue de référence " + (k + 1) : "Image principale"}"><button type="button" class="tdel" data-act="noimg" data-k="${k - 1}" data-src="${esc(src)}" title="Retirer cette image de référence" aria-label="Retirer cette image">×</button></span>`).join("")}</div><span class="muted" style="font-size:11px">${refsOf(r).length} image${refsOf(r).length > 1 ? "s" : ""} de référence</span></div>` : ""}</td>
    <td><input type="text" class="e-name" id="e-name-${esc(r.id)}" value="${esc(r.name)}" maxlength="80" aria-label="Nom">
        <input type="text" class="e-name-en" id="e-en-${esc(r.id)}" value="${esc(r.name_en || "")}" maxlength="80" placeholder="Nom anglais (jeu)" aria-label="Nom anglais" lang="en">
        <input type="text" class="e-colorname" id="e-cn-${esc(r.id)}" value="${esc(r.color_name)}" placeholder="Description de la couleur" aria-label="Description de la couleur"></td>
    <td><input type="text" class="e-cat" id="e-cat-${esc(r.id)}" value="${esc(r.category)}" list="catList" aria-label="Catégorie"></td>
    <td><input type="text" class="e-unit" id="e-unit-${esc(r.id)}" value="${esc(r.unit)}" aria-label="Unité" style="max-width:80px"></td>
    <td><input type="number" class="e-min" id="e-min-${esc(r.id)}" value="${r.threshold > 0 ? r.threshold : ""}" min="0" step="any" placeholder="aucun" aria-label="Seuil"></td>
    <td class="num">${esc(sumsText(unitSums(held)))}</td>
    <td><div class="acts"><button type="button" class="primary" data-act="save" disabled>Enregistrer</button><button type="button" class="danger" data-act="del">Supprimer</button></div></td>
  </tr>`;
}
function renderDb() {
  const q = norm($("#dbQ").value);
  const rows = st.resources.filter(r => !q || resMatch(r, q) || norm(r.category).includes(q)).sort((a, b) => a.name.localeCompare(b.name));
  const body = $("#dbBody");
  const keep = new Map([...body.querySelectorAll("tr[data-id]")].filter(tr => dirty.has(tr.dataset.id)).map(tr => [tr.dataset.id, tr]));
  const tmp = document.createElement("tbody");
  tmp.innerHTML = rows.map(dbRow).join("");
  for (const tr of [...tmp.children]) if (keep.has(tr.dataset.id)) tmp.replaceChild(keep.get(tr.dataset.id), tr);
  body.replaceChildren(...tmp.children);
  $("#dbEmpty").hidden = st.resources.length > 0;

  const opts = st.resources.slice().sort((a, b) => a.name.localeCompare(b.name))
    .map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  for (const id of ["#mSource", "#mTarget"]) {
    const sel = $(id), cur = sel.value;
    sel.innerHTML = '<option value="">Choisir…</option>' + opts;
    if (st.resources.some(r => r.id === cur)) sel.value = cur;
  }
  const hr = $("#hRes"), hrCur = hr.value;
  hr.innerHTML = '<option value="">Toutes</option>' + st.resources.slice().sort((a, b) => a.name.localeCompare(b.name)).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  hr.value = hrCur;
  const hw = $("#hWho"), hwCur = hw.value;
  hw.innerHTML = '<option value="">Tous</option>' + Object.values(st.profiles).sort((a, b) => a.pseudo.localeCompare(b.pseudo)).map(p => `<option value="${esc(p.id)}">${esc(p.pseudo)}</option>`).join("");
  hw.value = hwCur;
  updateMerge();
}
$("#dbQ").addEventListener("input", renderDb);
$("#dbBody").addEventListener("input", e => {
  const tr = e.target.closest("tr[data-id]"); if (!tr) return;
  if (e.target.classList.contains("e-color")) e.target.dataset.touched = "1";
  dirty.add(tr.dataset.id); tr.classList.add("dirty");
  tr.querySelector('[data-act="save"]').disabled = false;
});
$("#dbBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const tr = b.closest("tr"), id = tr.dataset.id, r = st.resources.find(x => x.id === id);
  if (!r) return;
  if (b.dataset.act === "noimg") {
    b.disabled = true;
    const k = Number(b.dataset.k);
    try {
      const lib = st.libReady && st.refImages.find(x => x.resource_id === id && x.image === b.dataset.src);
      if (lib) { await rpc("delete_reference_image", { p_id: lib.id }); await Promise.all([loadResources(), loadRefImages()]); renderDb(); return; }
      await rpc("remove_resource_ref", { p_id: id, p_index: k });
      const rest = Array.isArray(r.refs) ? r.refs.slice() : [];
      if (k < 0) { r.image = rest.shift() || ""; r.refs = rest; } else { rest.splice(k, 1); r.refs = rest; }
      renderDb(); renderAllStocks(); setStatus("");
    }
    catch (err) { setStatus(errText(err)); b.disabled = false; }
    return;
  }
  if (b.dataset.act === "del") {
    if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer"; return; }
    b.disabled = true;
    try { dirty.delete(id); await rpc("delete_resource", { p_id: id }); setStatus(""); }
    catch (err) { setStatus(errText(err)); b.disabled = false; }
    return;
  }
  const v = sel => tr.querySelector(sel);
  const name = v(".e-name").value.trim();
  if (!name) { v(".e-name").focus(); return; }
  const color = v(".e-color");
  b.disabled = true;
  try {
    await applyLots(r, "add", {}, "correction", "", {
      name, category: v(".e-cat").value.trim(), unit: v(".e-unit").value.trim(), threshold: num(v(".e-min").value),
      color: color.dataset.touched || color.dataset.had ? color.value : "", color_name: v(".e-colorname").value.trim(),
    });
    const en = v(".e-name-en") ? v(".e-name-en").value.trim() : (r.name_en || "");
    if (en !== (r.name_en || "")) await rpc("set_resource_name_en", { p_id: r.id, p_name: en });
    dirty.delete(id); tr.classList.remove("dirty"); setStatus("");
    await loadResources();
  } catch (err) { setStatus(errText(err)); b.disabled = false; }
});

// Fusion
function updateMerge() {
  const s = st.resources.find(r => r.id === $("#mSource").value), t = st.resources.find(r => r.id === $("#mTarget").value);
  const go = $("#mGo"); go.classList.remove("armed"); go.textContent = "Fusionner";
  go.disabled = !s || !t || s.id === t.id;
  const m = $("#mMsg"); m.className = "formmsg";
  if (s && t && s.id === t.id) m.textContent = "Choisis deux ressources différentes.";
  else if (s && t) {
    const lines = st.stocks.filter(x => x.resource_id === s.id && num(x.quantity) > 0);
    const owners = new Set(lines.map(x => x.user_id)).size;
    m.textContent = `« ${s.name} » sera supprimée. ${lines.length ? `Ses ${lines.length} ligne${lines.length > 1 ? "s" : ""} de stock (${sumsText(unitSums(lines))}, ${owners} membre${owners > 1 ? "s" : ""}) passeront à « ${t.name} », qualité par qualité.` : "Aucun membre n'en possède."} Images de référence et historique rattachés à « ${t.name} ».`;
  } else m.textContent = "";
}
$("#mSource").addEventListener("change", updateMerge);
$("#mTarget").addEventListener("change", updateMerge);
$("#mGo").addEventListener("click", async () => {
  const go = $("#mGo");
  if (!go.classList.contains("armed")) { go.classList.add("armed"); go.textContent = "Confirmer la fusion"; return; }
  go.disabled = true;
  const s = $("#mSource").value, t = $("#mTarget").value;
  try {
    await rpc("merge_resources", { p_source: s, p_target: t });
    $("#mSource").value = ""; await Promise.all([loadResources(), loadStocks()]);
    const m = $("#mMsg"); m.textContent = "Fusion effectuée."; m.className = "formmsg ok";
    loadHistory(true);
  } catch (err) { const m = $("#mMsg"); m.textContent = errText(err); m.className = "formmsg err"; updateMerge(); }
});

// Historique complet, par pages de 100
const hist = { rows: [], page: 0, done: false, loaded: false };
const HPAGE = 100;
function histQuery() {
  let q = sb.from("movements").select("*").order("at", { ascending: false });
  if ($("#hRes").value) q = q.eq("resource_id", $("#hRes").value);
  if ($("#hWho").value) q = q.eq("by", $("#hWho").value);
  if ($("#hFrom").value) q = q.gte("at", new Date($("#hFrom").value + "T00:00:00").toISOString());
  if ($("#hTo").value) q = q.lte("at", new Date($("#hTo").value + "T23:59:59").toISOString());
  return q;
}
async function loadHistory(reset) {
  if (reset) { hist.rows = []; hist.page = 0; hist.done = false; }
  hist.loaded = true;
  const { data, error } = await histQuery().range(hist.page * HPAGE, hist.page * HPAGE + HPAGE - 1);
  if (error) return setStatus(errText(error));
  hist.rows.push(...(data || [])); hist.page++; hist.done = (data || []).length < HPAGE;
  renderHistory();
}
// Les stocks personnels se corrigent par un mouvement « Correction » (l'historique est conservé) :
// l'annulation automatique ne concerne que l'ancien registre, avant les inventaires personnels.
const canUndo = m => !st.v2 && !m.undone_at && m.lots_before && m.lots_after && !["delete", "merge", "undo"].includes(m.mode) && st.resources.some(r => r.id === m.resource_id);
function renderHistory() {
  $("#hBody").innerHTML = hist.rows.map(m => {
    const d = m.delta != null ? num(m.delta) : num(m.after) - num(m.before);
    const author = (st.profiles[m.by] && st.profiles[m.by].pseudo) || "Un membre";
    const when = new Date(m.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    const act = m.undone_at ? '<span class="tag">Annulé</span>' : canUndo(m) ? `<button type="button" data-undo="${m.id}">Annuler</button>` : "";
    return `<tr class="${m.undone_at ? "undone" : ""}">
      <td class="num" style="white-space:nowrap">${when}</td><td>${esc(author)}</td><td><strong>${esc(m.name)}</strong><br><span class="muted" style="font-size:12px">${m.owner_id ? `${esc(who(m.owner_id))} · ${esc(locName(m.location_id))} · ${qLabel(m.quality_key)}` : "Ancien registre"}</span></td>
      <td><span class="tag">${esc(m.kind ? KIND[m.kind] || m.kind : modeLabel[m.mode] || m.mode)}</span>${m.source === "capture" ? '<br><span class="muted" style="font-size:12px">par capture</span>' : ""}</td>
      <td class="num" style="white-space:nowrap">${fmt(m.before)} → ${fmt(m.after)} <span class="${d > 0 ? "up" : d < 0 ? "down" : ""}">(${d > 0 ? "+" : ""}${fmt(d)})</span></td>
      <td class="num" style="font-size:12px">${esc(m.detail)}</td><td style="font-size:13px">${esc(m.note)}</td><td>${act}</td></tr>`;
  }).join("") || '<tr><td colspan="8" class="muted">Aucun mouvement pour ces filtres.</td></tr>';
  $("#hMore").hidden = hist.done;
  $("#hCount").textContent = `${hist.rows.length} mouvement${hist.rows.length > 1 ? "s" : ""} affiché${hist.rows.length > 1 ? "s" : ""}`;
}
$("#hGo").addEventListener("click", () => loadHistory(true));
$("#hMore").addEventListener("click", () => loadHistory(false));
$("#hBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-undo]"); if (!b) return;
  if (!b.classList.contains("armed")) { b.classList.add("armed", "danger"); b.textContent = "Confirmer"; return; }
  b.disabled = true;
  try { await rpc("undo_movement", { p_id: Number(b.dataset.undo) }); setStatus(""); await loadResources(); loadHistory(true); }
  catch (err) { setStatus(errText(err)); b.disabled = false; }
});

// Export : CSV au format Excel français (point-virgule, BOM UTF-8) et sauvegarde JSON
function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = v => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = rows => "﻿" + rows.map(r => r.map(csvCell).join(";")).join("\r\n");
const today = () => new Date().toISOString().slice(0, 10);
const frNum = n => String(Math.round(num(n) * 1000) / 1000).replace(".", ",");
async function allMovements() {
  const out = [];
  for (let p = 0; ; p++) {
    const { data, error } = await sb.from("movements").select("*").order("at").range(p * 1000, p * 1000 + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}
$("#expStock").addEventListener("click", () => exportStocks(st.stocks.filter(x => num(x.quantity) > 0), true));
$("#expLog").addEventListener("click", async e => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const ms = await allMovements();
    const rows = [["Date", "Membre", "Ressource", "Type", "Source", "Avant", "Après", "Écart", "Lots concernés", "Note", "Annulé"]];
    for (const m of ms) rows.push([new Date(m.at).toLocaleString("fr-FR"), (st.profiles[m.by] || {}).pseudo || "", m.name, modeLabel[m.mode] || m.mode, m.source,
      frNum(m.before), frNum(m.after), frNum(num(m.after) - num(m.before)), m.detail, m.note, m.undone_at ? "oui" : ""]);
    download(`journal-${today()}.csv`, csv(rows), "text/csv;charset=utf-8");
  } catch (err) { setStatus(errText(err)); }
  b.disabled = false;
});
async function backupJson() {
  const { data: resources, error } = await sb.from("resources").select("*").order("name");
  if (error) throw error;
  const extra = {};
  if (st.v2) for (const [t, o] of [["locations", "name"], ["user_stocks", "id"], ["legacy_stocks", "id"], ["inventory_scans", "id"], ["scan_items", "id"]])
    extra[t] = await fetchAll(t, "*", o);
  const backup = {
    exported_at: new Date().toISOString(),
    resources, ...extra,
    movements: await allMovements(),
    profiles: Object.values(st.profiles).map(p => ({ id: p.id, pseudo: p.pseudo, role: p.role, org: orgName(p.org_id), created_at: p.created_at })),
    organizations: st.orgs,
  };
  download(`sauvegarde-registre-${today()}.json`, JSON.stringify(backup, null, 2), "application/json");
}
$("#expJson").addEventListener("click", async e => {
  const b = e.currentTarget; b.disabled = true;
  try { await backupJson(); } catch (err) { setStatus(errText(err)); }
  b.disabled = false;
});

// ---------- démarrage ----------
if (!sb) show("configView");
else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { st.recovering = true; return show("recoveryView"); }
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION" || event === "USER_UPDATED") setTimeout(() => enter(session), 0);
  });
}

// ---------- réinitialisation complète (administrateurs) ----------
$("#rstConfirm").addEventListener("input", e => { $("#rstGo").disabled = e.target.value.trim() !== "REINITIALISER"; });
$("#rstGo").addEventListener("click", async () => {
  const b = $("#rstGo"), m = $("#rstMsg");
  if (!b.classList.contains("armed")) { b.classList.add("armed"); b.textContent = "Confirmer : tout effacer"; return; }
  b.disabled = true; m.className = "formmsg"; m.textContent = "Téléchargement de la sauvegarde…";
  try {
    await backupJson();
    await rpc("reset_registre", { p_confirm: "REINITIALISER" });
    dirty.clear(); $("#rstConfirm").value = "";
    m.textContent = "Base réinitialisée. La sauvegarde a été téléchargée."; m.className = "formmsg ok";
    await Promise.all([loadResources(), loadMoves(), loadStocks()]); loadHistory(true);
  } catch (err) { m.textContent = errText(err); m.className = "formmsg err"; b.disabled = false; }
  b.classList.remove("armed"); b.textContent = "Tout effacer"; b.disabled = $("#rstConfirm").value.trim() !== "REINITIALISER";
});
