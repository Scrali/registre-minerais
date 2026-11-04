const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => Number(n || 0).toLocaleString("fr-FR", { maximumFractionDigits: 2 });
const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
const num = v => { const n = parseFloat(String(v).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : 0; };
const okHex = h => /^#[0-9a-f]{6}$/i.test(String(h || "")) ? h : "";
const swatch = (h, title) => okHex(h) ? `<span class="sw" style="background:${okHex(h)}"${title ? ` title="${esc(title)}"` : ""}></span>` : '<span class="sw none" title="Pas de couleur"></span>';

const cfg = window.REGISTRE_CONFIG || {};
const configured = /^https:\/\/.+/.test(cfg.supabaseUrl || "") && cfg.supabaseKey && !/TON-PROJET|TA-CLE/.test(cfg.supabaseUrl + cfg.supabaseKey);
const sb = configured ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey) : null;

const st = { me: null, profiles: {}, resources: [], moves: [], shots: [], items: [], channel: null, recovering: false };

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
  if (me.role === "pending") { $("#pendingName").textContent = me.pseudo; return show("pendingView"); }
  $("#meName").textContent = me.pseudo;
  $("#meRole").textContent = me.role === "admin" ? "Administrateur" : "Membre";
  $("#meRole").className = "role" + (me.role === "admin" ? " admin" : "");
  $("#openMembers").hidden = me.role !== "admin";
  $("#appTabs").hidden = me.role !== "admin";
  if (me.role !== "admin") showTab("stocks");
  show("appView");
  await Promise.all([loadProfiles(), loadResources(), loadMoves()]);
}

// ---------- données ----------
async function loadProfiles() {
  const { data } = await sb.from("profiles").select("id, pseudo, role, created_at").order("created_at");
  st.profiles = Object.fromEntries((data || []).map(p => [p.id, p]));
  const pend = (data || []).filter(p => p.role === "pending").length;
  $("#pendingCount").textContent = pend; $("#pendingCount").hidden = !pend;
  if ($("#members").open) renderMembers();
  renderLog();
}
async function loadResources() {
  const { data, error } = await sb.from("resources").select("*").order("name");
  if (error) return setStatus("Impossible de charger les stocks : " + errText(error));
  setStatus("");
  st.resources = data || [];
  renderStock();
  if (!$("#dbView").hidden) renderDb();
}
async function loadMoves() {
  const { data } = await sb.from("movements").select("*").order("at", { ascending: false }).limit(40);
  st.moves = data || [];
  renderLog();
}

// Temps réel : on recharge la table concernée (quelques centaines de lignes au plus).
const debounce = (fn, ms) => { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; };
const reloadRes = debounce(loadResources, 250), reloadMoves = debounce(loadMoves, 250);
function startRealtime() {
  if (st.channel) return;
  st.channel = sb.channel("registre")
    .on("postgres_changes", { event: "*", schema: "public", table: "resources" }, reloadRes)
    .on("postgres_changes", { event: "*", schema: "public", table: "movements" }, reloadMoves)
    .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, payload => {
      if (st.me && payload.new && payload.new.id === st.me.id && payload.new.role !== st.me.role) return sb.auth.getSession().then(r => enter(r.data.session));
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
const applyLots = (r, mode, delta, source, note, patch) =>
  rpc("apply_lots", { p_id: r.id, p_mode: mode, p_delta: delta, p_source: source, p_note: note || "", p_patch: patch || null });
const createResource = (v, source, note) =>
  rpc("create_resource", { p: { name: v.name, category: v.category || "", unit: v.unit || "", color: okHex(v.color), color_name: v.color_name || "", threshold: v.threshold || 0, lots: clean({ ...(v.lots || {}) }) }, p_source: source, p_note: note || "" });

// ---------- stock ----------
const isLow = r => r.threshold > 0 && num(r.qty) < r.threshold;
function filtered() {
  const q = norm($("#q").value), c = $("#cat").value;
  return st.resources
    .filter(r => (!q || norm(r.name).includes(q) || norm(r.category).includes(q)) && (!c || r.category === c))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "") || a.name.localeCompare(b.name));
}

function renderStock() {
  const rows = filtered();
  $("#stockEmpty").hidden = st.resources.length > 0;
  $("#stCount").textContent = st.resources.length;
  $("#stTotal").textContent = fmt(st.resources.reduce((s, r) => s + num(r.qty), 0));
  const low = st.resources.filter(isLow).length;
  $("#stLow").textContent = low;
  $("#stLowBox").classList.toggle("alert", low > 0);

  const cats = [...new Set(st.resources.map(r => r.category).filter(Boolean))].sort();
  const sel = $("#cat"), cur = sel.value;
  sel.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c => `<option${c === cur ? " selected" : ""}>${esc(c)}</option>`).join("");
  $("#catList").innerHTML = cats.map(c => `<option value="${esc(c)}">`).join("");

  $("#stockBody").innerHTML = rows.map(r => {
    const low = isLow(r), q = num(r.qty), l = lotsOf(r), aq = avgQ(l);
    const qs = Object.keys(l).filter(k => k !== "-").map(Number);
    const nl = Object.keys(l).length;
    const qual = aq == null ? '<span class="muted">–</span>'
      : `<div class="qual">Q moy. ${aq}<small>${qs.length > 1 ? Math.min(...qs) + " à " + Math.max(...qs) + " · " : ""}${nl} lot${nl > 1 ? "s" : ""}</small></div>`;
    const pct = r.threshold > 0 ? Math.min(100, q / (r.threshold * 2) * 100) : 100;
    const pill = r.threshold > 0 ? (low ? '<span class="pill low">Bas</span>' : '<span class="pill ok">OK</span>') : '<span class="pill none">Sans seuil</span>';
    return `<tr class="${low ? "low" : ""}" data-id="${esc(r.id)}">
      <td>${swatch(r.color)}<span class="res-name">${esc(r.name)}</span>${r.category ? `<span class="chip">${esc(r.category)}</span>` : ""}${r.color_name ? `<div class="colordesc">${esc(r.color_name)}</div>` : ""}</td>
      <td><div class="qty">${fmt(q)}<small>${esc(r.unit)}</small></div>${r.threshold > 0 ? `<div class="gauge" title="Seuil : ${fmt(r.threshold)}"><i style="width:${pct}%"></i></div>` : ""}</td>
      <td>${qual}${lotChips(l)}</td>
      <td>${pill}</td>
      <td><div class="quick"><input type="number" class="qin" step="1" min="0" max="1000" placeholder="Q" id="qq-${esc(r.id)}" aria-label="Qualité (facultatif)"><input type="number" step="any" min="0" placeholder="qté" id="qk-${esc(r.id)}" aria-label="Quantité à ajouter ou retirer">
        <button data-act="add" title="Ajouter">+</button><button data-act="remove" title="Retirer">−</button></div></td>
      <td><button data-act="edit">Modifier</button></td></tr>`;
  }).join("");
  if (st.resources.length && !rows.length) $("#stockBody").innerHTML = '<tr><td colspan="6" class="muted">Aucune ressource ne correspond au filtre.</td></tr>';
  if (st.items.length) renderReview();
}

$("#stockBody").addEventListener("click", async e => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest("tr").dataset.id, r = st.resources.find(x => x.id === id); if (!r) return;
  if (b.dataset.act === "edit") return openDialog(r);
  const inp = document.getElementById("qk-" + id), qin = document.getElementById("qq-" + id), amt = num(inp.value);
  if (amt <= 0) { inp.focus(); return; }
  b.disabled = true;
  try { await applyLots(r, b.dataset.act, { [qKey(qin.value)]: amt }, "manuel", ""); inp.value = ""; qin.value = ""; }
  catch (err) { setStatus(errText(err)); }
  b.disabled = false;
});
$("#q").addEventListener("input", renderStock);
$("#cat").addEventListener("change", renderStock);

// ---------- fiche ressource ----------
const dlg = $("#dlg");
let editing = null;
function openDialog(r) {
  editing = r || null;
  $("#dlgTitle").textContent = r ? "Modifier " + r.name : "Nouvelle ressource";
  $("#fName").value = r ? r.name : "";
  $("#fCat").value = r ? r.category || "" : "";
  $("#fUnit").value = r ? r.unit || "" : "";
  $("#fLots").value = r ? lotsToLines(lotsOf(r)) : "";
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
    name: $("#fName").value.trim(), category: $("#fCat").value.trim(), unit: $("#fUnit").value.trim(),
    lots: parseLots($("#fLots").value), threshold: num($("#fMin").value),
    color: $("#fColor").dataset.touched ? $("#fColor").value : "", color_name: $("#fColorName").value.trim(),
  };
  if (!v.name) return;
  const r = editing;
  if (!r && st.resources.some(x => norm(x.name) === norm(v.name))) { $("#fName").setCustomValidity("Cette ressource existe déjà."); $("#fName").reportValidity(); $("#fName").setCustomValidity(""); return; }
  $("#fSave").disabled = true;
  try {
    if (r) await applyLots(r, "set", v.lots, "correction", "", { name: v.name, category: v.category, unit: v.unit, threshold: v.threshold, color: okHex(v.color), color_name: v.color_name });
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
const modeLabel = { add: "Entrée", remove: "Sortie", set: "Inventaire", create: "Création", delete: "Suppression", merge: "Fusion", undo: "Annulation" };
function renderLog() {
  $("#logEmpty").hidden = st.moves.length > 0;
  $("#log").innerHTML = st.moves.map(m => {
    const d = num(m.after) - num(m.before);
    const cls = d > 0 ? "up" : d < 0 ? "down" : "";
    const who = (st.profiles[m.by] && st.profiles[m.by].pseudo) || "Un membre";
    return `<li><div><span class="d ${cls}">${d > 0 ? "+" : ""}${fmt(d)} ${esc(m.unit)}</span> · <strong>${esc(m.name)}</strong></div>
      <div class="meta"><span class="num">${fmt(m.before)} → ${fmt(m.after)}</span> · ${modeLabel[m.mode] || esc(m.mode)}${m.source === "capture" ? " par capture" : ""}${m.note ? " · " + esc(m.note) : ""}</div>
      ${m.detail ? `<div class="meta num">${esc(m.detail)}</div>` : ""}
      <div class="meta">${esc(who)} · ${ago(m.at)}</div></li>`;
  }).join("");
}

// ---------- membres (admin) ----------
const roleLabel = { pending: "En attente", member: "Membre", admin: "Administrateur" };
function renderMembers() {
  const list = Object.values(st.profiles).sort((a, b) => (a.role === "pending" ? -1 : 0) - (b.role === "pending" ? -1 : 0) || a.pseudo.localeCompare(b.pseudo));
  $("#membList").innerHTML = list.map(p => {
    const self = p.id === st.me.id;
    return `<div class="memb-row" data-id="${esc(p.id)}">
      <div class="who"><strong>${esc(p.pseudo)}${self ? " (toi)" : ""}</strong><span>Inscrit le ${new Date(p.created_at).toLocaleDateString("fr-FR")}</span></div>
      ${self ? `<span class="role admin">${roleLabel[p.role]}</span>` : `<div class="row">
        ${p.role === "pending" ? '<button class="primary" data-role="member">Valider</button>' : ""}
        <select data-f="role" id="role-${esc(p.id)}" aria-label="Rôle de ${esc(p.pseudo)}">${Object.entries(roleLabel).map(([k, v]) => `<option value="${k}"${k === p.role ? " selected" : ""}>${v}</option>`).join("")}</select>
      </div>`}
    </div>`;
  }).join("");
}
async function setRole(id, role) {
  const { error } = await sb.from("profiles").update({ role }).eq("id", id);
  const m = $("#membMsg");
  if (error) { m.textContent = errText(error); m.className = "formmsg err"; }
  else { m.textContent = "Rôle mis à jour."; m.className = "formmsg ok"; await loadProfiles(); }
}
$("#openMembers").addEventListener("click", () => { $("#membMsg").textContent = ""; renderMembers(); $("#members").showModal(); });
$("#closeMembers").addEventListener("click", () => $("#members").close());
$("#membList").addEventListener("click", e => { const b = e.target.closest("button[data-role]"); if (b) setRole(b.closest(".memb-row").dataset.id, b.dataset.role); });
$("#membList").addEventListener("change", e => { if (e.target.dataset.f === "role") setRole(e.target.closest(".memb-row").dataset.id, e.target.value); });

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
  for (const f of imgs.slice(0, Math.max(0, room))) st.shots.push({ id: ++shotSeq, file: f, url: URL.createObjectURL(f), status: "new", n: 0, err: "" });
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
  $("#analyze").disabled = !p || busy;
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
  if ($("#appView").hidden || $("#stocksView").hidden) return;
  const fs = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith("image/"));
  if (fs.length) { e.preventDefault(); addImages(fs); drop.scrollIntoView({ block: "nearest" }); }
});
$("#clearCap").addEventListener("click", e => { e.stopPropagation(); clearCapture(); });
function clearCapture() {
  for (const s of st.shots) URL.revokeObjectURL(s.url);
  st.shots = []; st.items = [];
  $("#review").hidden = true; $("#file").value = ""; capMsg("");
  renderShots();
}
const capMode = () => document.querySelector("input[name=capMode]:checked").value;
document.querySelectorAll("input[name=capMode]").forEach(r => r.addEventListener("change", () => st.items.length && renderReview()));

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
  const { data, error } = await sb.functions.invoke("analyze-capture", { body: { image, media_type: "image/jpeg" } });
  if (error) {
    let msg = "L'analyse a échoué. Réessaie dans un instant.";
    try { msg = (await error.context.json()).error || msg; } catch (_) {}
    throw new Error(msg);
  }
  const raw = (Array.isArray(data?.items) ? data.items : []).filter(i => i && i.name);
  const crops = await cropTiles(s.file, raw.map(i => i.box));
  return raw.map((i, k) => ({
    name: String(i.name).trim(), quality: qKey(i.quality) === "-" ? "" : qKey(i.quality), qty: i.qty == null ? 1 : num(i.qty),
    unit: String(i.unit || "").trim(), color: String(i.color || "").trim(), hex: okHex(String(i.hex || "").trim()), by: String(i.by || ""),
    on: true, target: matchTarget(String(i.name)), shot: s.id, crop: crops[k],
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
    const pad = 8; // marge en millièmes, la position lue est approximative
    l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(1000, r + pad); d = Math.min(1000, d + pad);
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
      if (st.items.length) { st.items.sort((a, b) => shotPage(a.shot) - shotPage(b.shot)); renderReview(); }
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

// Regroupe les lignes cochées par ressource cible : un lot par qualité.
function groupItems() {
  const g = new Map();
  for (const it of st.items) {
    if (!it.on || !it.name) continue;
    const r = st.resources.find(x => x.id === it.target) || st.resources.find(x => norm(x.name) === norm(it.name));
    const key = r ? r.id : "new:" + norm(it.name);
    if (!g.has(key)) g.set(key, { r, it, lots: {} });
    const e = g.get(key), k = qKey(it.quality);
    e.lots[k] = num(e.lots[k]) + num(it.qty);
  }
  return g;
}
function renderReview() {
  $("#review").hidden = false;
  const mode = capMode();
  const opts = st.resources.slice().sort((a, b) => a.name.localeCompare(b.name));
  const groups = groupItems();
  const sizes = {};
  for (const it of st.items) sizes[it.group] = (sizes[it.group] || 0) + 1;
  $("#reviewBody").innerHTML = st.items.map((it, i) => {
    const linked = sizes[it.group] > 1 ? `<br>${sizes[it.group]} lots de ce type · <button type="button" class="linkbtn" data-split="${i}" title="Ce caillou n'est pas le même minerai : le nommer à part">Séparer</button>` : "";
    const pic = it.crop ? `<img class="crop" src="${it.crop}" alt="Case lue sur la capture">` : swatch(it.hex, it.color);
    const r = st.resources.find(x => x.id === it.target);
    if (!r && it.target !== "new") it.target = "new";
    const g = groups.get(r ? r.id : "new:" + norm(it.name));
    const before = r ? num(r.qty) : 0;
    const after = !it.on || !g ? before : r ? sumLots(mergeLots(lotsOf(r), g.lots, mode)) : (mode === "remove" ? 0 : sumLots(g.lots));
    const unit = r ? r.unit : it.unit;
    return `<tr data-i="${i}">
      <td><input type="checkbox" data-f="on" id="rv-on-${i}" ${it.on ? "checked" : ""} aria-label="Inclure cette ligne"></td>
      <td class="pg">p. ${shotPage(it.shot) || "–"}</td>
      <td><input type="text" data-f="name" id="rv-name-${i}" value="${esc(it.name)}"></td>
      <td><div style="display:flex;align-items:center;min-width:130px">${pic}<span class="colordesc">${esc(it.color || "–")}${it.by === "couleur" ? "<br>reconnu par la couleur" : ""}${linked}</span></div></td>
      <td><input type="number" class="qin" step="1" min="0" max="1000" placeholder="?" data-f="quality" id="rv-q-${i}" value="${esc(it.quality)}" aria-label="Qualité"></td>
      <td><input type="number" step="any" min="0" data-f="qty" id="rv-qty-${i}" value="${it.qty}"></td>
      <td><select data-f="target" id="rv-target-${i}"><option value="new"${it.target === "new" ? " selected" : ""}>Nouvelle ressource</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === it.target ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></td>
      <td class="arrow" title="Total de la ressource">${r ? fmt(before) + " → " : "nouveau : "}<strong>${fmt(after)}</strong> ${esc(unit)}</td></tr>`;
  }).join("");
  const n = st.items.filter(i => i.on).length;
  $("#commit").textContent = n ? `Enregistrer ${n} lot${n > 1 ? "s" : ""} (${groups.size} ressource${groups.size > 1 ? "s" : ""})` : "Aucune ligne cochée";
  $("#commit").disabled = !n;
}
// « Séparer » : ce lot quitte son groupe de couleur et prend un nom à lui.
let splitSeq = 0;
$("#reviewBody").addEventListener("click", e => {
  const b = e.target.closest("[data-split]"); if (!b) return;
  const it = st.items[+b.dataset.split];
  // Emmène aussi les lots du groupe dont la couleur décrite est la même (même type de caillou).
  const same = st.items.filter(x => x.group === it.group);
  let moved = same.filter(x => norm(x.color) === norm(it.color));
  if (moved.length === same.length) moved = [it];
  const g = "split:" + (++splitSeq), name = `${it.name} (autre)`;
  for (const x of moved) { x.group = g; x.name = name; x.target = "new"; }
  renderReview();
  const inp = $(`#rv-name-${b.dataset.split}`); if (inp) { inp.focus(); inp.select(); }
});
$("#reviewBody").addEventListener("change", e => {
  const f = e.target.dataset.f; if (!f) return;
  const it = st.items[+e.target.closest("tr").dataset.i];
  if (f === "on") it.on = e.target.checked;
  else if (f === "qty") it.qty = num(e.target.value);
  else if (f === "quality") it.quality = qKey(e.target.value) === "-" ? "" : qKey(e.target.value);
  else if (f === "name" || f === "target") {
    const v = f === "name" ? e.target.value.trim() : e.target.value;
    for (const x of st.items.filter(x => x.group === it.group)) {
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
  renderReview();
});

$("#commit").addEventListener("click", async () => {
  const mode = capMode(), note = $("#capNote").value.trim();
  const todo = [...groupItems().values()];
  $("#commit").disabled = true;
  let done = 0;
  try {
    for (const { r, it, lots } of todo) {
      if (r) await applyLots(r, mode, lots, "capture", note);
      else await createResource({ name: it.name, unit: it.unit, lots: mode === "remove" ? {} : lots, color: it.hex, color_name: it.color }, "capture", note);
      done++; $("#commitMsg").textContent = `${done} / ${todo.length}`;
    }
    $("#commitMsg").textContent = "";
    clearCapture(); $("#capNote").value = "";
    capMsg(`${done} ressource${done > 1 ? "s mises" : " mise"} à jour dans le registre.`);
  } catch (err) {
    setStatus(errText(err));
    $("#commitMsg").textContent = `${done} / ${todo.length} enregistrées avant l'erreur.`;
    $("#commit").disabled = false;
  }
});

// ---------- onglet Base de données (administrateurs) ----------
function showTab(tab) {
  document.querySelectorAll("#appTabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#stocksView").hidden = tab !== "stocks";
  $("#dbView").hidden = tab !== "db";
  if (tab === "db") { renderDb(); if (!hist.loaded) loadHistory(true); }
}
$("#appTabs").addEventListener("click", e => { const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab); });

// Édition directe des ressources. Une ligne modifiée et pas encore enregistrée n'est pas
// écrasée par les mises à jour en temps réel des autres membres.
const dirty = new Set();
function dbRow(r) {
  const l = lotsOf(r);
  return `<tr data-id="${esc(r.id)}">
    <td><input type="color" class="e-color" id="e-color-${esc(r.id)}" value="${okHex(r.color) || "#888888"}" data-had="${okHex(r.color) ? 1 : ""}" aria-label="Couleur de ${esc(r.name)}"></td>
    <td><input type="text" class="e-name" id="e-name-${esc(r.id)}" value="${esc(r.name)}" maxlength="80" aria-label="Nom">
        <input type="text" class="e-colorname" id="e-cn-${esc(r.id)}" value="${esc(r.color_name)}" placeholder="Description de la couleur" aria-label="Description de la couleur"></td>
    <td><input type="text" class="e-cat" id="e-cat-${esc(r.id)}" value="${esc(r.category)}" list="catList" aria-label="Catégorie"></td>
    <td><input type="text" class="e-unit" id="e-unit-${esc(r.id)}" value="${esc(r.unit)}" aria-label="Unité" style="max-width:80px"></td>
    <td><input type="number" class="e-min" id="e-min-${esc(r.id)}" value="${r.threshold > 0 ? r.threshold : ""}" min="0" step="any" placeholder="aucun" aria-label="Seuil"></td>
    <td><textarea class="e-lots" id="e-lots-${esc(r.id)}" rows="${Math.min(6, Math.max(2, Object.keys(l).length))}" aria-label="Lots">${esc(lotsToLines(l))}</textarea></td>
    <td class="num">${fmt(r.qty)}</td>
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
    .map(r => `<option value="${esc(r.id)}">${esc(r.name)} (${fmt(r.qty)})</option>`).join("");
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
    await applyLots(r, "set", parseLots(v(".e-lots").value), "correction", "", {
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
    const after = mergeLots(lotsOf(t), lotsOf(s), "add");
    m.textContent = `« ${t.name} » passera de ${fmt(t.qty)} à ${fmt(sumLots(after))} unités (${lotsText(after) || "aucun lot"}). « ${s.name} » sera supprimée.`;
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
    $("#mSource").value = ""; await loadResources();
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
const canUndo = m => !m.undone_at && m.lots_before && m.lots_after && !["delete", "merge", "undo"].includes(m.mode) && st.resources.some(r => r.id === m.resource_id);
function renderHistory() {
  $("#hBody").innerHTML = hist.rows.map(m => {
    const d = num(m.after) - num(m.before);
    const who = (st.profiles[m.by] && st.profiles[m.by].pseudo) || "Un membre";
    const when = new Date(m.at).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" });
    const act = m.undone_at ? '<span class="tag">Annulé</span>' : canUndo(m) ? `<button type="button" data-undo="${m.id}">Annuler</button>` : "";
    return `<tr class="${m.undone_at ? "undone" : ""}">
      <td class="num" style="white-space:nowrap">${when}</td><td>${esc(who)}</td><td><strong>${esc(m.name)}</strong></td>
      <td><span class="tag">${modeLabel[m.mode] || esc(m.mode)}</span>${m.source === "capture" ? '<br><span class="muted" style="font-size:12px">par capture</span>' : ""}</td>
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
$("#expStock").addEventListener("click", () => {
  const rows = [["Ressource", "Catégorie", "Unité", "Quantité", "Qualité moyenne", "Lots", "Seuil", "Couleur", "Description couleur"]];
  for (const r of st.resources.slice().sort((a, b) => a.name.localeCompare(b.name))) {
    const l = lotsOf(r);
    rows.push([r.name, r.category, r.unit, frNum(r.qty), avgQ(l) ?? "", lotsText(l), r.threshold ? frNum(r.threshold) : "", r.color, r.color_name]);
  }
  download(`stocks-${today()}.csv`, csv(rows), "text/csv;charset=utf-8");
});
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
$("#expJson").addEventListener("click", async e => {
  const b = e.currentTarget; b.disabled = true;
  try {
    const backup = {
      exported_at: new Date().toISOString(),
      resources: st.resources,
      movements: await allMovements(),
      profiles: Object.values(st.profiles).map(p => ({ id: p.id, pseudo: p.pseudo, role: p.role, created_at: p.created_at })),
    };
    download(`sauvegarde-registre-${today()}.json`, JSON.stringify(backup, null, 2), "application/json");
  } catch (err) { setStatus(errText(err)); }
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
