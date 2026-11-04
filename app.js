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

const st = { me: null, profiles: {}, resources: [], moves: [], image: null, items: [], channel: null, recovering: false };

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
const modeLabel = { add: "Entrée", remove: "Sortie", set: "Inventaire", create: "Création", delete: "Suppression" };
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
function setImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  st.image = file; st.items = []; $("#review").hidden = true;
  const img = $("#preview"); img.src = URL.createObjectURL(file); img.hidden = false;
  $("#dropEmpty").hidden = true; $("#clearCap").hidden = false; $("#analyze").disabled = false;
  capMsg("Capture prête. Choisis ce qu'elle montre, puis lance l'analyse.");
}
drop.addEventListener("click", () => $("#file").click());
drop.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("#file").click(); } });
$("#file").addEventListener("change", e => setImage(e.target.files[0]));
drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); setImage(e.dataTransfer.files[0]); });
document.addEventListener("paste", e => {
  if ($("#appView").hidden) return;
  const f = [...(e.clipboardData?.files || [])].find(f => f.type.startsWith("image/"));
  if (f) { e.preventDefault(); setImage(f); drop.scrollIntoView({ block: "nearest" }); }
});
$("#clearCap").addEventListener("click", e => { e.stopPropagation(); clearCapture(); });
function clearCapture() {
  st.image = null; st.items = []; $("#preview").hidden = true; $("#dropEmpty").hidden = false;
  $("#review").hidden = true; $("#clearCap").hidden = true; $("#analyze").disabled = true; $("#file").value = ""; capMsg("");
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

$("#analyze").addEventListener("click", async () => {
  if (!st.image) return;
  $("#analyze").disabled = true;
  capMsg("Lecture de la capture en cours… (10 à 60 secondes)");
  try {
    const image = await toBase64Jpeg(st.image);
    const { data, error } = await sb.functions.invoke("analyze-capture", { body: { image, media_type: "image/jpeg" } });
    if (error) {
      let msg = "L'analyse a échoué. Réessaie dans un instant.";
      try { msg = (await error.context.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const items = (Array.isArray(data?.items) ? data.items : []).filter(i => i && i.name).map(i => ({
      name: String(i.name).trim(), quality: qKey(i.quality) === "-" ? "" : qKey(i.quality), qty: i.qty == null ? 1 : num(i.qty),
      unit: String(i.unit || "").trim(), color: String(i.color || "").trim(), hex: okHex(String(i.hex || "").trim()), by: String(i.by || ""),
      on: true, target: matchTarget(String(i.name)),
      // Lots lus comme le même caillou (même nom ou même couleur) : renommer l'un renomme les autres.
      group: norm(i.name),
    }));
    st.items = items;
    if (!items.length) { capMsg("Aucune ressource lue sur cette capture. Essaie une capture plus nette ou recadrée sur l'inventaire.", true); $("#review").hidden = true; }
    else {
      const kinds = new Set(items.map(i => norm(i.name))).size;
      capMsg(`${items.length} lot${items.length > 1 ? "s" : ""} lu${items.length > 1 ? "s" : ""}, ${kinds} minerai${kinds > 1 ? "s" : ""}. Vérifie les valeurs avant d'enregistrer.`);
      renderReview();
    }
  } catch (err) { capMsg(errText(err), true); }
  $("#analyze").disabled = !st.image;
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
    const linked = sizes[it.group] > 1 ? `<br>nom partagé par ${sizes[it.group]} lots de cette couleur` : "";
    const r = st.resources.find(x => x.id === it.target);
    if (!r && it.target !== "new") it.target = "new";
    const g = groups.get(r ? r.id : "new:" + norm(it.name));
    const before = r ? num(r.qty) : 0;
    const after = !it.on || !g ? before : r ? sumLots(mergeLots(lotsOf(r), g.lots, mode)) : (mode === "remove" ? 0 : sumLots(g.lots));
    const unit = r ? r.unit : it.unit;
    return `<tr data-i="${i}">
      <td><input type="checkbox" data-f="on" id="rv-on-${i}" ${it.on ? "checked" : ""} aria-label="Inclure cette ligne"></td>
      <td><input type="text" data-f="name" id="rv-name-${i}" value="${esc(it.name)}"></td>
      <td><div style="display:flex;align-items:center;min-width:130px">${swatch(it.hex, it.color)}<span class="colordesc">${esc(it.color || "–")}${it.by === "couleur" ? "<br>reconnu par la couleur" : ""}${linked}</span></div></td>
      <td><input type="number" class="qin" step="1" min="0" max="1000" placeholder="?" data-f="quality" id="rv-q-${i}" value="${esc(it.quality)}" aria-label="Qualité"></td>
      <td><input type="number" step="any" min="0" data-f="qty" id="rv-qty-${i}" value="${it.qty}"></td>
      <td><select data-f="target" id="rv-target-${i}"><option value="new"${it.target === "new" ? " selected" : ""}>Nouvelle ressource</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === it.target ? " selected" : ""}>${esc(o.name)}</option>`).join("")}</select></td>
      <td class="arrow" title="Total de la ressource">${r ? fmt(before) + " → " : "nouveau : "}<strong>${fmt(after)}</strong> ${esc(unit)}</td></tr>`;
  }).join("");
  const n = st.items.filter(i => i.on).length;
  $("#commit").textContent = n ? `Enregistrer ${n} lot${n > 1 ? "s" : ""} (${groups.size} ressource${groups.size > 1 ? "s" : ""})` : "Aucune ligne cochée";
  $("#commit").disabled = !n;
}
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

// ---------- démarrage ----------
if (!sb) show("configView");
else {
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { st.recovering = true; return show("recoveryView"); }
    if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "INITIAL_SESSION" || event === "USER_UPDATED") setTimeout(() => enter(session), 0);
  });
}
