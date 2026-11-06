// Synchronise le catalogue des blueprints depuis l'API Star Citizen Wiki (https://api.star-citizen.wiki).
// Ne lit et n'écrit QUE les tables du catalogue (sc_*) : les inventaires ne sont jamais touchés.
//
// Déclenchement :
//  * manuel  : bouton « Synchroniser » (administrateur) ; la fonction vérifie elle-même le rôle avec le jeton de l'utilisateur.
//  * automatique : tâche planifiée Supabase (pg_cron) qui envoie l'en-tête x-sync-secret (voir supabase/cron/sync-blueprints.sql).
// Secrets (Supabase > Edge Functions > Secrets) : SYNC_SECRET (pour la tâche planifiée). SUPABASE_URL, SUPABASE_ANON_KEY et
// SUPABASE_SERVICE_ROLE_KEY sont fournis automatiquement par Supabase.
// Réglage : « Verify JWT with legacy secret » désactivé (comme analyze-capture).
//
// Fonctionnement : la liste complète (pagination page[size]=200) donne une empreinte par blueprint ; seuls les blueprints
// nouveaux ou modifiés sont relus en détail (qualité minimale par emplacement). Chaque invocation travaille au plus
// ~100 s puis rend la main : l'appel suivant reprend où la précédente s'est arrêtée.

export const API = "https://api.star-citizen.wiki";
const PAGE_SIZE = 200;          // maximum autorisé par l'API
const MIN_GAP_MS = 250;         // au plus 4 requêtes par seconde vers l'API (aucune n'est en parallèle)
const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const BATCH = 15;               // recettes envoyées à la base par lot
const MAX_PAGES = 50;           // garde-fou : 10 000 blueprints au plus

type Json = any;
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<Json>;
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class ApiError extends Error {
  status: number; permanent: boolean;
  constructor(message: string, status = 0, permanent = false) { super(message); this.status = status; this.permanent = permanent; }
}

// Client HTTP poli : une requête à la fois, délai minimal, nouvelles tentatives (429 / 5xx / réseau) avec attente croissante.
export function makeClient(fetchFn: Fetch, opts: { gapMs?: number; sleepFn?: (ms: number) => Promise<unknown> } = {}) {
  const gap = opts.gapMs ?? MIN_GAP_MS, wait = opts.sleepFn ?? sleep;
  let last = 0, requests = 0;
  async function getJson(path: string): Promise<Json> {
    for (let attempt = 1; ; attempt++) {
      const d = last + gap - Date.now();
      if (d > 0) await wait(d);
      last = Date.now(); requests++;
      let res: Response;
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        res = await fetchFn(API + path, { headers: { Accept: "application/json", "User-Agent": "registre-minerais (sync-blueprints)" }, signal: ctl.signal });
      } catch (e) {
        clearTimeout(t);
        if (attempt >= MAX_ATTEMPTS) throw new ApiError(`API injoignable (${path}) : ${(e as Error).message}`);
        await wait(1000 * 2 ** (attempt - 1));
        continue;
      }
      clearTimeout(t);
      if (res.ok) {
        const ct = res.headers.get("content-type") || "";
        if (!ct.includes("json")) throw new ApiError(`Réponse inattendue (${ct || "sans type"}) pour ${path}`, res.status, true);
        return await res.json();
      }
      if (res.status === 404) throw new ApiError(`Introuvable dans l'API : ${path}`, 404, true);
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
        const ra = Number(res.headers.get("retry-after"));
        await wait(Math.min(60_000, isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt));
        continue;
      }
      throw new ApiError(`Erreur ${res.status} de l'API pour ${path}`, res.status, res.status < 500 && res.status !== 429);
    }
  }
  return { getJson, get requests() { return requests; } };
}

// Empreinte stable d'une ligne de liste (SHA-256 du JSON reçu).
export async function hashOf(v: unknown): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(v)));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

// Ligne de liste réduite aux champs du catalogue.
export async function listItem(b: Json) {
  if (!b || typeof b.uuid !== "string" || typeof b.key !== "string") throw new ApiError("Blueprint sans uuid ni clé dans la liste.");
  const o = b.output || {};
  return {
    uuid: b.uuid, key: b.key, hash: await hashOf(b),
    output_name: b.output_name ?? o.name ?? "", output_uuid: b.output_item_uuid ?? o.uuid ?? null, output_class: b.output_class ?? o.class ?? null,
    output_type: o.type ?? null, output_type_label: o.type_label ?? null, output_grade: o.grade ?? null,
    category_uuid: b.category_uuid ?? null, craft_time_seconds: b.craft_time_seconds ?? null,
    is_available_by_default: b.is_available_by_default ?? null, web_url: b.web_url ?? null, game_version: b.game_version ?? null,
  };
}

// Détail réduit : seules les parties utiles à la recette sont envoyées à la base (qui les interprète).
export function detailItem(d: Json, uuid: string) {
  if (!d || d.uuid !== uuid) throw new ApiError(`Détail incohérent pour ${uuid}.`, 0, true);
  if (!Array.isArray(d.requirement_groups) && !Array.isArray(d.tiers)) throw new ApiError(`Recette absente pour ${uuid}.`, 0, true);
  return { uuid: d.uuid, key: d.key, game_version: d.game_version ?? null, craft_time_seconds: d.craft_time_seconds ?? null,
           requirement_groups: d.requirement_groups ?? null, tiers: d.tiers ?? null };
}

// Une étape de synchronisation, dans la limite de temps. Renvoie l'état pour l'interface.
export async function runSync(o: {
  rpc: Rpc; fetchFn: Fetch; trigger: "manual" | "cron"; user?: string | null; force?: boolean;
  budgetMs?: number; gapMs?: number; sleepFn?: (ms: number) => Promise<unknown>;
}): Promise<Json> {
  const t0 = Date.now(), budget = o.budgetMs ?? 100_000, api = makeClient(o.fetchFn, { gapMs: o.gapMs, sleepFn: o.sleepFn });
  const begun = await o.rpc("sc_sync_begin", { p_trigger: o.trigger, p_user: o.user ?? null, p_force: !!o.force });
  if (begun.nothing_to_do) return { status: "up_to_date", last_success: begun.last_success };
  if (begun.busy) return { status: "busy", run_id: begun.run_id, pending: begun.pending };
  const run: number = begun.run_id;
  let pending: string[] = begun.pending || [], version: string | null = begun.game_version ?? null;
  try {
    if (begun.phase === "list") {
      const vers = await api.getJson("/api/game-versions?page%5Bsize%5D=200");
      const versions = Array.isArray(vers?.data) ? vers.data : [];
      const def = versions.find((v: Json) => v.is_default) || (await api.getJson("/api/game-versions/default"))?.data;
      if (!def?.code) throw new ApiError("Version du jeu par défaut introuvable.");
      version = def.code;
      const items: Json[] = [];
      let total: number | null = null;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await api.getJson(`/api/blueprints?page%5Bsize%5D=${PAGE_SIZE}&page%5Bnumber%5D=${page}&version=${encodeURIComponent(version!)}`);
        if (!Array.isArray(r?.data) || !r.meta) throw new ApiError(`Page ${page} de la liste mal formée.`);
        total = Number(r.meta.total);
        for (const b of r.data) items.push(await listItem(b));
        if (!r.links?.next || page >= Number(r.meta.last_page) || r.data.length === 0) break;
      }
      const res = await o.rpc("sc_sync_list", { p_run: run, p: { game_version: version, versions, total, items } });
      pending = res.pending || [];
    }
    while (pending.length && Date.now() - t0 < budget) {
      const details: Json[] = [], failed: Json[] = [];
      for (const uuid of pending.slice(0, BATCH)) {
        if (Date.now() - t0 >= budget) break;
        try {
          const r = await api.getJson(`/api/blueprints/${encodeURIComponent(uuid)}${version ? `?version=${encodeURIComponent(version)}` : ""}`);
          details.push(detailItem(r?.data, uuid));
        } catch (e) {
          // Erreur durable (404, réponse incohérente) : journalisée, on passe au suivant. Sinon on s'arrête là pour reprendre plus tard.
          if (e instanceof ApiError && e.permanent) failed.push({ uuid, message: e.message });
          else { if (details.length || failed.length) await o.rpc("sc_sync_details", { p_run: run, p: { details, failed } }); throw e; }
        }
      }
      if (!details.length && !failed.length) break;
      const res = await o.rpc("sc_sync_details", { p_run: run, p: { details, failed } });
      pending = res.pending || [];
    }
    if (pending.length) {
      await o.rpc("sc_sync_release", { p_run: run });
      return { status: "continue", run_id: run, pending: pending.length, requests: api.requests };
    }
    const fin = await o.rpc("sc_sync_finish", { p_run: run, p_error: null });
    return { status: fin.status, run_id: run, stats: fin.stats, requests: api.requests };
  } catch (e) {
    const msg = (e as Error).message || String(e);
    // Erreur passagère pendant les détails : la synchronisation reste ouverte et reprendra au prochain appel.
    if (begun.phase !== "list" || pending.length) {
      try { await o.rpc("sc_sync_release", { p_run: run }); } catch (_) { /* rien */ }
      return { status: "continue", run_id: run, pending: pending.length, error: msg };
    }
    try { await o.rpc("sc_sync_finish", { p_run: run, p_error: msg }); } catch (_) { /* rien */ }
    return { status: "error", run_id: run, error: msg };
  }
}

// ---------- Point d'entrée Supabase (Deno) ----------
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Comparaison à temps constant (le secret ne fuit pas par le temps de réponse).
function sameSecret(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const D = (globalThis as Json).Deno;
if (D?.serve) {
  D.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);
    const { createClient } = await import("npm:@supabase/supabase-js@2");
    const url = D.env.get("SUPABASE_URL"), service = D.env.get("SUPABASE_SERVICE_ROLE_KEY"), anon = D.env.get("SUPABASE_ANON_KEY");
    if (!url || !service || !anon) return json({ error: "Configuration Supabase incomplète." }, 500);
    let body: Json = {};
    try { body = await req.json(); } catch (_) { /* corps vide */ }

    let trigger: "manual" | "cron", user: string | null = null;
    const secret = D.env.get("SYNC_SECRET") || "";
    if (sameSecret(req.headers.get("x-sync-secret") || "", secret)) {
      trigger = "cron";
    } else {
      const auth = req.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Connexion requise." }, 401);
      const asUser = createClient(url, anon, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
      const { data: u } = await asUser.auth.getUser(auth.slice(7));
      const { data: ok, error } = await asUser.rpc("sc_can_sync");
      if (error || ok !== true || !u?.user) return json({ error: "Réservé aux administrateurs." }, 403);
      trigger = "manual"; user = u.user.id;
    }
    const admin = createClient(url, service, { auth: { persistSession: false } });
    const rpc: Rpc = async (fn, args) => {
      const { data, error } = await admin.rpc(fn, args);
      if (error) throw new Error(error.message);
      return data;
    };
    try {
      const out = await runSync({ rpc, fetchFn: fetch, trigger, user, force: trigger === "manual" && body.force === true });
      return json(out, out.status === "error" ? 502 : 200);
    } catch (e) {
      return json({ status: "error", error: (e as Error).message }, 500);
    }
  });
}
