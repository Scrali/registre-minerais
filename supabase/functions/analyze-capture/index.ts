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
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "quality", "qty", "unit", "color", "hex", "by", "box"],
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
        },
      },
    },
  },
};

function buildPrompt(known: string) {
  return `Cette image est une capture d'écran d'un jeu vidéo. Elle montre un inventaire, une soute, un entrepôt ou une liste de ressources (minerais, cailloux, matériaux, marchandises).
Ignore tout ce qui n'est pas une ressource : équipement, armes, armures, outils, consommables, boutons, menus, crédits, noms de joueurs.
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
Pour identifier chaque lot :
1. Si un nom est écrit et correspond à une ressource connue (même avec une orthographe, une casse ou une langue un peu différente), reprends exactement le nom connu. by = "nom".
2. Si aucun nom n'est lisible, compare la couleur observée aux couleurs connues et reprends le nom de la ressource dont la couleur correspond le mieux. by = "couleur".
3. Si ni le nom ni la couleur ne correspondent, mets le nom écrit s'il y en a un, sinon "Caillou <couleur>" (ex. "Caillou vert pâle"). by = "inconnu".
Champs : quality = entier 0-1000 ou null si aucune qualité affichée ; qty = nombre ; unit = chaîne vide si aucune unité visible ; color = description en français de la couleur observée ; hex = son approximation en #rrggbb ; box = rectangle serré autour du dessin du caillou seul, SANS le texte de qualité ni de quantité ni l'icône en coin, en millièmes de la largeur et de la hauteur de l'image : [gauche, haut, droite, bas], chaque valeur de 0 à 1000.
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
    const { data: member } = await sb.rpc("is_member");
    if (!member) return json({ error: "Ton compte n'est pas encore validé par un administrateur." }, 403);

    const { image, media_type } = await req.json();
    if (typeof image !== "string" || !MEDIA_TYPES.includes(media_type)) {
      return json({ error: "Image manquante ou format non pris en charge (PNG, JPEG, WebP, GIF)." }, 400);
    }
    if (image.length > 7_000_000) return json({ error: "Image trop lourde (5 Mo maximum)." }, 413);

    const { data: resources } = await sb.from("resources").select("name, unit, color, color_name").order("name");
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
          { type: "image", source: { type: "base64", media_type: media_type as MediaType, data: image } },
          { type: "text", text: buildPrompt(known) },
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
