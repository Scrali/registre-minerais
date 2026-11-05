// Lit une capture d'écran d'inventaire avec Claude et renvoie les lots détectés.
// Secret requis : ANTHROPIC_API_KEY (Supabase > Edge Functions > Secrets).
import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["terminal_type", "items"],
  properties: {
    // Écran du jeu : l'inventaire affiché est le même quel que soit l'écran ; c'est une simple information.
    terminal_type: { type: "string", enum: ["inventaire", "ascenseur_fret", "autre", "inconnu"] },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quality", "qty", "unit", "color", "hex", "by", "box", "confidence"],
        properties: {
          name: { type: "string" },
          quality: { type: ["integer", "null"] },
          qty: { type: "number" },
          unit: { type: "string" },
          color: { type: "string" },
          hex: { type: "string" },
          by: { type: "string", enum: ["nom", "couleur", "inconnu"] },
          // Position du caillou dans l'image, en millièmes : [gauche, haut, droite, bas].
          box: { type: "array", items: { type: "integer" } },
          // Confiance de 0 à 1 dans l'identification ET dans les nombres lus.
          confidence: { type: "number" },
        },
      },
    },
  },
};

function buildPrompt(known: string, refs: number) {
  return `La capture d'écran à analyser (la dernière image, juste avant ce texte) vient d'un jeu vidéo. Elle montre un inventaire, une soute, un entrepôt ou une liste de ressources (minerais, cailloux, matériaux, marchandises).
Ignore tout ce qui n'est pas une ressource : équipement, armes, armures, outils, consommables, boutons, menus, crédits, noms de joueurs.
ÉCRAN : indique dans terminal_type l'écran capturé : "inventaire" pour l'inventaire personnel ou local du personnage (panneaux « Personnel », « Local », vue d'équipement), "ascenseur_fret" pour l'interface d'un ascenseur de fret ou d'un terminal d'entrepôt (liste de marchandises et de caisses, chargement et déchargement), "autre" pour un autre écran, "inconnu" si tu ne sais pas.
FORMAT DES CASES : chaque case de minerai est un LOT.
- Le nombre suivi de « Q » (ex. « 258Q ») est la QUALITÉ du lot, de 0 à 1000. Ce n'est PAS une quantité.
- Le nombre suivi de « x » (ex. « 20x ») est la QUANTITÉ d'unités dans le lot. S'il n'y a pas de « x », la quantité est 1.
- Exemple : une case « 258Q 20x » = 20 unités de qualité 258 ; une case « 274Q » seule = 1 unité de qualité 274.
Relève chaque case une par une : un élément de la liste par case, même si deux cases ont le même minerai et la même qualité. Ne fusionne jamais deux cases.
Si une infobulle affiche le nom d'un minerai pour une case, utilise ce nom pour cette case et pour toutes les cases de même couleur et de même forme.
Dans ce jeu, la COULEUR et la FORME du caillou indiquent quel minerai c'est. Pour chaque lot, observe attentivement sa couleur dominante (teinte, clarté, transparence, reflets) et sa forme (cristaux, roche).
Attention aux teintes proches : par exemple une roche brun-gris foncé et une roche brun-rouge sont deux minerais DIFFÉRENTS. Compare les cases entre elles et donne un nom différent à chaque type de caillou distinct ; ne regroupe sous un même nom que les cases dont le caillou est vraiment identique.
Ressources connues du registre, avec leur couleur quand elle est renseignée :
${known}
${refs ? `IMAGES DE RÉFÉRENCE : avant la capture, tu as reçu ${refs} image(s) de référence, chacune précédée du nom de sa ressource et de l'écran du jeu où elle a été prise. Ce sont des vignettes du caillou tel qu'il apparaît dans le jeu. Une même ressource peut avoir plusieurs vues : le caillou s'affiche un peu différemment selon l'écran (inventaire personnel, interface d'un ascenseur de fret, entrepôt…), avec un éclairage, un angle ou un fond différents ; une case correspond à une ressource si elle ressemble à N'IMPORTE LAQUELLE de ses vues. C'est la source la plus fiable pour reconnaître un caillou : compare chaque case de la capture à TOUTES les références (teinte exacte, taches et reflets, rugosité, silhouette). Plusieurs minerais se ressemblent beaucoup (par exemple deux roches brun-rouge) : départage-les sur les détails, et choisis la référence la plus proche, pas la première qui convient à peu près.
` : ""}Pour identifier chaque lot :
1. Si un nom est écrit et correspond à une ressource connue (même avec une orthographe, une casse ou une langue un peu différente), reprends exactement le nom connu. by = "nom".
2. Si aucun nom n'est lisible, compare le caillou aux images de référence et aux couleurs connues, et reprends le nom de la ressource qui correspond le mieux. by = "couleur".
3. Si ni le nom ni la couleur ne correspondent, mets le nom écrit s'il y en a un, sinon "Caillou <couleur>" (ex. "Caillou vert pâle"). by = "inconnu".
UNITÉS : recopie l'unité exactement comme le jeu l'affiche (« SCU », « cSCU », « µSCU »…). Pour une quantité affichée « 20x » (nombre d'objets), unit = chaîne vide : ne convertis JAMAIS des objets en SCU ni l'inverse.
Champs : quality = entier 0-1000 ou null si aucune qualité affichée ; qty = nombre ; unit = unité affichée, chaîne vide pour un nombre d'objets ; confidence = ta confiance de 0 à 1 dans l'identification du minerai ET dans les nombres lus (baisse-la si le texte est flou, coupé, masqué, ou si deux références se ressemblent) ; color = description en français de la couleur observée ; hex = son approximation en #rrggbb ; box = rectangle serré autour du dessin du caillou seul, SANS le texte de qualité ni de quantité ni l'icône en coin, en millièmes de la largeur et de la hauteur de la capture : [gauche, haut, droite, bas], chaque valeur de 0 à 1000.
Si tu ne vois aucune ressource, renvoie une liste vide.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Méthode non autorisée." }, 405);

  try {
    // Agit avec le jeton de la personne connectée : les règles RLS s'appliquent.
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    // Droit « analyser des captures » (migration 008) ; avant elle, tout membre validé.
    const { data: allowed, error: permErr } = await sb.rpc("has_perm", { p: "scan" });
    let ok = allowed === true;
    if (permErr) { const { data: member } = await sb.rpc("is_member"); ok = !!member; }
    if (!ok) return json({ error: "Tu n'as pas le droit d'analyser des captures, ou ton compte n'est pas encore validé : demande-le à un administrateur de ton organisation." }, 403);

    const { image, media_type, terminal_hint } = await req.json();
    if (typeof image !== "string" || !MEDIA_TYPES.includes(media_type)) {
      return json({ error: "Image manquante ou format non pris en charge (PNG, JPEG, WebP, GIF)." }, 400);
    }
    if (image.length > 7_000_000) return json({ error: "Image trop lourde (5 Mo maximum)." }, 413);

    const { data: resources } = await sb.from("resources").select("id, name, unit, color, color_name, image, refs").order("name");
    // Bibliothèque d'images classées par écran. Si la table n'existe pas encore, on reprend image + refs.
    const { data: lib, error: libErr } = await sb.from("reference_images")
      .select("resource_id, terminal_type, image").order("created_at", { ascending: false });
    const PREFIX = "data:image/jpeg;base64,";
    const isImg = (s: unknown): s is string => typeof s === "string" && s.startsWith(PREFIX);
    const TERM_LABEL: Record<string, string> = { inventaire: "inventaire personnel", ascenseur_fret: "ascenseur de fret", autre: "autre écran", inconnu: "écran non précisé" };
    const hint = typeof terminal_hint === "string" && terminal_hint in TERM_LABEL && terminal_hint !== "inconnu" ? terminal_hint : null;
    type View = { img: string; term: string };
    const views = new Map<string, View[]>();
    for (const r of resources ?? []) {
      const own = libErr ? [r.image, ...(Array.isArray(r.refs) ? r.refs : [])].filter(isImg).map((img) => ({ img, term: "inconnu" }))
        : (lib ?? []).filter((x) => x.resource_id === r.id && isImg(x.image)).map((x) => ({ img: x.image as string, term: x.terminal_type as string }));
      if (own.length) views.set(r.id, own);
    }
    // 80 images au plus : jusqu'à 4 par ressource. On privilégie l'écran de la capture s'il est connu,
    // sinon on alterne les écrans pour que chacun soit représenté ; l'image principale passe en premier.
    const MAX_REFS = 80;
    const per = Math.max(1, Math.min(4, Math.floor(MAX_REFS / Math.max(1, views.size))));
    function pick(r: { image: string }, list: View[]): View[] {
      const groups = new Map<string, View[]>();
      for (const v of list) { if (!groups.has(v.term)) groups.set(v.term, []); groups.get(v.term)!.push(v); }
      for (const g of groups.values()) g.sort((a, b) => Number(b.img === r.image) - Number(a.img === r.image));
      const order = [...groups.keys()].sort((a, b) =>
        Number(b === hint) - Number(a === hint) || Number(groups.get(b)!.some((v) => v.img === r.image)) - Number(groups.get(a)!.some((v) => v.img === r.image)));
      const out: View[] = [];
      if (hint && groups.has(hint)) out.push(...groups.get(hint)!.slice(0, Math.max(1, per - 1)));
      for (let i = 0; out.length < per; i++) {
        let added = false;
        for (const t of order) { const v = groups.get(t)![i]; if (v && !out.includes(v) && out.length < per) { out.push(v); added = true; } }
        if (!added) break;
      }
      return out;
    }
    const refBlocks = (resources ?? []).flatMap((r) => {
      const chosen = pick(r, views.get(r.id) ?? []);
      return chosen.flatMap((v, i) => [
        { type: "text" as const, text: `Référence : ${r.name} (${TERM_LABEL[v.term] ?? v.term}${chosen.length > 1 ? `, vue ${i + 1}/${chosen.length}` : ""})` },
        { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: v.img.slice(PREFIX.length) } },
      ]);
    }).slice(0, MAX_REFS * 2);
    const refs = refBlocks.length / 2;
    const known = (resources ?? [])
      .map((r) => {
        const c = [r.color_name, r.color].filter(Boolean).join(", ");
        return `- ${r.name}${r.unit ? ` (${r.unit})` : ""}${c ? ` — couleur : ${c}` : ""}`;
      })
      .join("\n") || "aucune pour l'instant";

    const client = new Anthropic();
    const msg = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          ...refBlocks,
          { type: "text", text: refs ? "Capture d'écran à analyser :" : "Capture d'écran :" },
          { type: "image", source: { type: "base64", media_type: media_type as MediaType, data: image } },
          { type: "text", text: buildPrompt(known, refs) },
        ],
      }],
    });

    if (msg.stop_reason === "refusal") return json({ error: "Cette image n'a pas pu être analysée." }, 422);
    if (msg.stop_reason === "max_tokens") return json({ error: "Trop de lots sur une seule capture. Recadre l'inventaire en plusieurs captures." }, 422);
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return json(JSON.parse(text));
  } catch (e) {
    console.error(e);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Trop de demandes pour le moment. Réessaie dans une minute." }, 429);
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "Clé API Anthropic invalide : vérifie le secret ANTHROPIC_API_KEY." }, 500);
    return json({ error: "L'analyse a échoué. Réessaie dans un instant." }, 500);
  }
});
