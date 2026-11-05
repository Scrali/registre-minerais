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
  $("#resList").innerHTML = st.resources.map(r => `<option value="${esc(r.name)}">`).join("");
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
  correction: "Correction", legacy_attribution: "Ancien stock attribué",
};
const INC_KINDS = ["production", "refined", "deposit", "transfer_in", "purchase"];
const DEC_KINDS = ["sale", "transfer_out", "refining", "consumption", "loss", "withdrawal"];
const qLabel = q => (q === "-" || q == null) ? "Q?" : "Q" + q;
const unitTxt = u => u ? " " + u : "";
const locName = id => (st.locations.find(l => l.id === id) || {}).name || "Lieu inconnu";
const who = id => (st.profiles[id] || {}).pseudo || "Membre";
const resOf = id => st.resources.find(r => r.id === id);
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
  return `${img}<span class="res-name">${esc(r ? r.name : fallback || "Ressource supprimée")}</span>`;
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
    if (q && !(r && (norm(r.name).includes(q) || norm(r.category).includes(q)))) return false;
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
  rs.innerHTML = st.resources.slice().sort(byName).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  if (cur && st.resources.some(r => r.id === cur)) rs.value = cur;
  if (!$("#mvPlace").value) $("#mvPlace").value = loc ? locName(loc) : $("#capPlace").value;
}
$("#mOwner").addEventListener("change", () => { renderMine(); loadMyMoves(); });
$("#mLoc").addEventListener("change", () => { $("#mvPlace").value = $("#mLoc").value ? locName($("#mLoc").value) : $("#mvPlace").value; renderMine(); });
$("#mvKind").innerHTML = `<optgroup label="Entrée">${INC_KINDS.map(k => `<option value="${k}">${KIND[k]}</option>`).join("")}</optgroup>`
  + `<optgroup label="Sortie">${DEC_KINDS.map(k => `<option value="${k}">${KIND[k]}</option>`).join("")}</optgroup>`
  + `<optgroup label="Correction"><option value="correction">Corriger la quantité (valeur exacte)</option></optgroup>`;
oreClicks($("#mineBody"), mOpen, () => renderMine());
$("#mineBody").addEventListener("click", e => {
  const b = e.target.closest("[data-use]"); if (!b) return;
  const s = st.stocks.find(x => String(x.id) === b.dataset.use); if (!s) return;
  $("#mvRes").value = s.resource_id; $("#mvPlace").value = locName(s.location_id);
  $("#mvQ").value = s.quality_key === "-" ? "" : s.quality_key; $("#mvUnit").value = s.unit;
  $("#moveForm").scrollIntoView({ block: "nearest" }); $("#mvQty").focus();
});
$("#moveForm").addEventListener("submit", async e => {
  e.preventDefault();
  const kind = $("#mvKind").value, mode = kind === "correction" ? "set" : INC_KINDS.includes(kind) ? "add" : "remove";
  const owner = mineOwner(), m = $("#mvMsg");
  const p = { owner_id: owner === st.me.id ? null : owner, location: $("#mvPlace").value.trim(), resource_id: $("#mvRes").value,
    quality_key: $("#mvQ").value, unit: $("#mvUnit").value.trim(), mode, quantity: num($("#mvQty").value),
    kind: mode === "set" ? null : kind, note: $("#mvNote").value.trim() };
  $("#mvGo").disabled = true;
  try {
    const r = await rpc("adjust_stock", { p });
    m.textContent = r ? `Mouvement enregistré (${KIND[r.kind] || r.kind}) : ${fmt(r.before)} → ${fmt(r.after)}.` : "Aucun changement : la quantité est déjà celle-ci.";
    m.className = "formmsg ok"; $("#mvQty").value = ""; $("#mvNote").value = "";
    await loadStocks(); loadMyMoves();
  } catch (err) { m.textContent = errText(err); m.className = "formmsg err"; }
  $("#mvGo").disabled = false;
});

// Mouvements du membre affiché ; une hausse ou une baisse d'origine inconnue peut être classée après coup.
let movesReq = 0;
async function loadMyMoves() {
  const owner = mineOwner(); if (!owner || !st.v2) return;
  const req = ++movesReq;
  const { data, error } = await sb.from("movements").select("*").eq("owner_id", owner).order("at", { ascending: false }).limit(50);
  if (error || req !== movesReq) return;
  st.myMoves = data || []; renderMyMoves();
}
function renderMyMoves() {
  const canEdit = canEditOwner(mineOwner());
  $("#myMovesEmpty").hidden = st.myMoves.length > 0;
  $("#myMoves").innerHTML = st.myMoves.map(m => {
    const d = num(m.delta), open = m.kind === "increase" || m.kind === "decrease";
    const opts = (d > 0 ? INC_KINDS : DEC_KINDS).map(k => `<option value="${k}">${KIND[k]}</option>`).join("");
    return `<li><div><span class="d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${fmt(d)}${esc(unitTxt(m.unit))}</span> · <strong>${esc(m.name)}</strong> <span class="muted">${qLabel(m.quality_key)}</span></div>
      <div class="meta">${esc(locName(m.location_id))} · <span class="tag${open ? " warn" : ""}">${esc(KIND[m.kind] || m.kind || "")}</span>${m.note ? " · " + esc(m.note) : ""}</div>
      ${open && canEdit ? `<div class="meta"><select data-classify="${m.id}" aria-label="Préciser la nature du mouvement"><option value="">Préciser la nature…</option>${opts}</select></div>` : ""}
      <div class="meta">${fmt(m.before)} → ${fmt(m.after)} · ${m.by && m.by !== m.owner_id ? "par " + esc(who(m.by)) + " · " : ""}${ago(m.at)}</div></li>`;
  }).join("");
}
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
  out: ["withdrawal", "sale", "transfer_out", "refining", "consumption", "loss"], unknown_out: ["decrease"],
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
  if (!r && st.resources.some(x => norm(x.name) === norm(v.name))) { $("#fName").setCustomValidity("Cette ressource existe déjà."); $("#fName").reportValidity(); $("#fName").setCustomValidity(""); return; }
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
const pendingShots = () => st.shots.filter(s => s.status === "new" || s.status === "error");
const shotPage = id => st.shots.findIndex(s => s.id === id) + 1;
function renderShots() {
  const has = st.shots.length > 0;
  $("#dropEmpty").hidden = has; $("#thumbs").hidden = !has; $("#dropMore").hidden = !has || st.shots.length >= MAX_SHOTS;
  $("#clearCap").hidden = !has;
  $("#thumbs").innerHTML = st.shots.map((s, i) => {
    const state = s.status === "done" ? `<span class="ok">${s.n} lot${s.n > 1 ? "s" : ""}</span>`
      : s.status === "busy" ? "lecture…" : s.status === "error" ? `<span class="bad" title="${esc(s.err)}">échec</span>` : "à analyser";
    return `<div class="thumb"><img src="${s.url}" alt="Page ${i + 1}">
      <div class="tcap"><span>Page ${i + 1}</span>${state}</div>
      <button class="tdel" data-del="${s.id}" title="Retirer cette capture" aria-label="Retirer la page ${i + 1}" ${s.status === "busy" ? "disabled" : ""}>×</button></div>`;
  }).join("");
  const p = pendingShots().length, busy = st.shots.some(s => s.status === "busy");
  $("#analyze").disabled = !p || busy || !can("scan");
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
  URL.revokeObjectURL(s.url);
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
  for (const s of st.shots) URL.revokeObjectURL(s.url);
  st.shots = []; st.items = []; st.reasons = {}; st.scanKey = null;
  st.modeTouched = false; setCapMode($("#capTerminal").value === "raffinerie" ? "add" : "update");
  hideDiff();
  $("#review").hidden = true; $("#file").value = ""; capMsg("");
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
const refPanel = () => $("#capRefPanel").value === "done" ? "done" : "setup";
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
    const qty = i.qty == null ? 1 : num(i.qty), unit = String(i.unit || "").trim();
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
  let r = st.resources.find(x => norm(x.name) === n);
  if (!r) r = st.resources.find(x => { const k = norm(x.name); return k.length > 3 && (k.includes(n) || n.includes(k)); });
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
  st.items.forEach((it, i) => { if (!groups.has(it.group)) groups.set(it.group, []); groups.get(it.group).push(i); });
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
        : swatch(it.hex, it.color);
      const warn = [];
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
      <td><input type="number" step="any" min="0" data-f="qty" id="rv-qty-${i}" value="${it.qty}" aria-label="Quantité"></td>
      <td><input type="text" class="uin" data-f="unit" id="rv-unit-${i}" list="unitList" maxlength="20" placeholder="objets" value="${esc(it.unit)}" aria-label="Unité"></td>
      <td><select data-f="target" id="rv-target-${i}"><option value="new"${it.target === "new" ? " selected" : ""}>Nouvelle ressource (ajoutée au catalogue)</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === it.target ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></td></tr>`);
    }
  }
  $("#reviewBody").innerHTML = rows.join("");
  const n = st.items.filter(i => i.on).length;
  $("#compare").textContent = n ? `Comparer ${n} lot${n > 1 ? "s" : ""} avec le stock enregistré` : "Aucune ligne cochée";
  $("#compare").disabled = !n;
}
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
function hideDiff() { $("#diff").hidden = true; st.diff = null; $("#forceStale").hidden = true; $("#commit").hidden = false; }
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
  $("#compare").disabled = true; setMsg("#compareMsg", "Comparaison avec le dernier relevé…");
  try {
    // Les nouvelles ressources rejoignent d'abord le catalogue (sans aucun stock).
    const fresh = new Map();
    for (const it of st.items) if (it.on && it.target === "new") { const k = norm(it.name); if (!fresh.has(k)) fresh.set(k, it); }
    for (const [k, it] of fresh) {
      const known = st.resources.find(r => norm(r.name) === k);
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
  if (d.stale) notes.push(`Attention : cette capture est plus ancienne que le dernier état enregistré (${dateTxt(d.last_state_at)}). L'appliquer remplacerait un état plus récent.`);
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
async function commitScan(allowStale) {
  if (!st.diff) return;
  const place = $("#capPlace").value.trim();
  $("#commit").disabled = true; $("#forceStale").disabled = true; setMsg("#commitMsg", "Enregistrement…");
  const reasons = {}; for (const [k, v] of Object.entries(st.reasons)) if (v) reasons[k] = v;
  try {
    const res = await rpc("apply_scan", { p: scanPayload({ idempotency_key: st.scanKey, state_token: st.diff.state_token, reasons, allow_stale: !!allowStale }), p_dry_run: false });
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
    } else if (/STALE/.test(m)) {
      st.diff.stale = true; renderDiff(); setMsg("#commitMsg", m.replace(/^STALE:\s*/, ""), true);
    } else setMsg("#commitMsg", m, true);
  }
  $("#commit").disabled = false; $("#forceStale").disabled = false;
}
$("#commit").addEventListener("click", () => commitScan(false));
$("#forceStale").addEventListener("click", () => commitScan(true));

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
  rs.innerHTML = st.resources.slice().sort(byName).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join("");
  if (cur && st.resources.some(r => r.id === cur)) rs.value = cur;
  const list = st.resources.filter(r => !q || norm(r.name).includes(q)).sort(byName);
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
  const res = st.resources.find(r => norm(r.name) === norm(name));
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

// ---------- onglet Base de données (administrateurs) ----------
function showTab(tab) {
  document.querySelectorAll("#appTabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  for (const v of ["mine", "req", "global", "stats", "img", "db"]) $("#" + v + "View").hidden = tab !== v;
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
  const rows = st.resources.filter(r => !q || norm(r.name).includes(q) || norm(r.category).includes(q)).sort((a, b) => a.name.localeCompare(b.name));
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
