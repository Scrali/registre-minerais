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
    terminal_type: { type: "string", enum: ["inventaire", "ascenseur_fret", "asop", "raffinerie", "autre", "inconnu"] },
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

function buildPrompt(known: string, refs: number, panel: "setup" | "running" | "done") {
  return `La capture d'écran à analyser (la dernière image, juste avant ce texte) vient d'un jeu vidéo. Elle montre un inventaire, une soute, un entrepôt ou une liste de ressources (minerais, cailloux, matériaux, marchandises).
LANGUE : le jeu peut être en FRANÇAIS ou en ANGLAIS. Les termes anglais équivalents sont donnés entre crochets ci-dessous ; un libellé un peu différent mais de même sens compte aussi. Les noms de minerais peuvent être en anglais (Gold = Or, Iron = Fer, Copper = Cuivre, Aluminum = Aluminium, Tin = Étain, Titanium = Titane, Tungsten = Tungstène, Corundum = Corindon, Quartz, Beryl = Béryl, Diamond = Diamant, Inert Materials = Matériaux inertes…) : reprends toujours le nom tel qu'il est écrit dans la liste des ressources connues, quelle que soit la langue de la capture.
Ignore tout ce qui n'est pas une ressource : équipement, armes, armures, outils, consommables, boutons, menus, crédits, noms de joueurs.
ÉCRAN : indique dans terminal_type l'écran capturé : "inventaire" pour l'inventaire personnel ou local du personnage (panneaux « Personnel », « Local », vue d'équipement) [Personal, Local Inventory], "ascenseur_fret" pour l'interface d'un ascenseur de fret ou d'un terminal d'entrepôt [Freight Elevator, Cargo, Warehouse] (liste de marchandises et de caisses, chargement et déchargement), "asop" pour un terminal ASOP (gestion des vaisseaux, avec le contenu de la soute d'un vaisseau), "raffinerie" pour un terminal de raffinerie (titre « RAFFINERIE » [REFINERY], ordres de travail [WORK ORDER]), "autre" pour un autre écran, "inconnu" si tu ne sais pas.
RAFFINERIE : si l'écran est une raffinerie, ${panel === "running"
  ? `relève UNIQUEMENT les « matières produites » [MATERIALS PRODUCED / OUTPUT] des ordres de travail EN COURS (panneaux marqués « TRAITEMENT EN COURS » [PROCESSING / IN PROGRESS], colonnes QUALITÉ [QUALITY], RENDEMENT [YIELD], À FAIRE [TO DO / REMAINING], FINI [DONE / FINISHED]). S'il y a plusieurs ordres en cours, relève les lignes de chacun. Prends la colonne RENDEMENT (quantité totale que l'ordre produira), jamais « À FAIRE » ni « FINI ». Ignore les panneaux « MISE EN PLACE » et « TERMINÉ », et le temps restant.`
  : panel === "done"
  ? `relève UNIQUEMENT les « matières produites » de l'ordre de travail TERMINÉ (panneau marqué « TERMINÉ » [COMPLETE / COMPLETED], colonnes QUALITÉ [QUALITY] et RENDEMENT [YIELD]). Ignore complètement les panneaux « MISE EN PLACE » et « TRAITEMENT EN COURS ».`
  : `relève UNIQUEMENT les lignes de l'ordre de travail en préparation (panneau « MISE EN PLACE » [SETUP], tableau « matériaux sélectionnés » [SELECTED MATERIALS] avec les colonnes QUALITÉ [QUALITY], QTÉ [QTY / QUANTITY], RENDEMENT [YIELD], RAFFINER [REFINE]). Ne relève pas les lignes dont le rendement est vide ou « -- », ni celles dont la case RAFFINER n'est pas cochée. Ignore complètement les panneaux « TERMINÉ » et « TRAITEMENT EN COURS ».`}
Chaque ligne relevée est un lot : name = le minerai, quality = la colonne QUALITÉ, qty = la colonne RENDEMENT, unit = "cSCU". N'utilise JAMAIS la colonne « QTÉ » [QTY] (minerai brut avant raffinage). Ignore les spécialisations de la station, le coût, le délai, la capacité, les totaux « dans le manifeste », « à raffiner » et « RENDEMENT » de l'ordre, et le contenu du vaisseau. Les suffixes « (M) », « [M] », « (Ore) » ou « (Raw) » ne font pas partie du nom. Les icônes de lingot sont toutes identiques : identifie par le nom écrit (by = "nom"), et box = l'icône de la ligne.
FORMAT DES CASES (inventaire, soute, entrepôt) : chaque case de minerai est un LOT.
- Le nombre suivi de « Q » (ex. « 258Q ») est la QUALITÉ du lot, de 0 à 1000. Ce n'est PAS une quantité.
- Le nombre suivi de « x » (ex. « 20x ») est la QUANTITÉ d'unités dans le lot. S'il n'y a pas de « x », la quantité est 1.
- Exemple : une case « 258Q 20x » = 20 unités de qualité 258 ; une case « 274Q » seule = 1 unité de qualité 274.
Relève chaque case une par une : un élément de la liste par case, même si deux cases ont le même minerai et la même qualité. Ne fusionne jamais deux cases.
Si une infobulle affiche le nom d'un minerai pour une case, utilise ce nom pour cette case et pour toutes les cases de même couleur et de même forme.
Dans ce jeu, la COULEUR et la FORME du caillou indiquent quel minerai c'est. Pour chaque lot, observe attentivement sa couleur dominante (teinte, clarté, transparence, reflets) et sa forme (cristaux, roche).
Attention aux teintes proches : par exemple une roche brun-gris foncé et une roche brun-rouge sont deux minerais DIFFÉRENTS. Compare les cases entre elles et donne un nom différent à chaque type de caillou distinct ; ne regroupe sous un même nom que les cases dont le caillou est vraiment identique.
Ressources connues du registre, avec leur couleur quand elle est renseignée :
${known}
${refs ? `IMAGES DE RÉFÉRENCE : avant la capture, tu as reçu ${refs} image(s) de référence, chacune précédée du nom de sa ressource et de l'écran du jeu où elle a été prise. Ce sont des vignettes du caillou tel qu'il apparaît dans le jeu. Une même ressource peut avoir plusieurs vues : le caillou s'affiche un peu différemment selon l'écran (inventaire personnel, interface d'un ascenseur de fret, terminal ASOP, entrepôt…), avec un éclairage, un angle ou un fond différents ; une case correspond à une ressource si elle ressemble à N'IMPORTE LAQUELLE de ses vues. C'est la source la plus fiable pour reconnaître un caillou : compare chaque case de la capture à TOUTES les références (teinte exacte, taches et reflets, rugosité, silhouette). Plusieurs minerais se ressemblent beaucoup (par exemple deux roches brun-rouge) : départage-les sur les détails, et choisis la référence la plus proche, pas la première qui convient à peu près.
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

    const { image, media_type, terminal_hint, refinery_panel } = await req.json();
    const panel = refinery_panel === "done" || refinery_panel === "running" ? refinery_panel : "setup";
    if (typeof image !== "string" || !MEDIA_TYPES.includes(media_type)) {
      return json({ error: "Image manquante ou format non pris en charge (PNG, JPEG, WebP, GIF)." }, 400);
    }
    if (image.length > 7_000_000) return json({ error: "Image trop lourde (5 Mo maximum)." }, 413);

    const { data: resources } = await sb.from("resources").select("id, name, unit, color, color_name, image, refs").order("name");
    // Bibliothèque d'images classées par écran. Si la table n'existe pas encore, on reprend image + refs.
    // screen_main (image choisie pour un écran, migration 011) : si la colonne manque, on relit sans elle.
    const readLib = (cols: string) => sb.from("reference_images").select(cols).order("created_at", { ascending: false });
    let libRes = await readLib("resource_id, terminal_type, image, screen_main");
    if (libRes.error) libRes = await readLib("resource_id, terminal_type, image");
    const lib = libRes.data as unknown as { resource_id: string; terminal_type: string; image: string; screen_main?: boolean }[] | null;
    const libErr = libRes.error;
    const PREFIX = "data:image/jpeg;base64,";
    const isImg = (s: unknown): s is string => typeof s === "string" && s.startsWith(PREFIX);
    const TERM_LABEL: Record<string, string> = { inventaire: "inventaire personnel", ascenseur_fret: "ascenseur de fret", asop: "terminal ASOP", raffinerie: "raffinerie", autre: "autre écran", inconnu: "écran non précisé" };
    const hint = typeof terminal_hint === "string" && terminal_hint in TERM_LABEL && terminal_hint !== "inconnu" ? terminal_hint : null;
    type View = { img: string; term: string; main?: boolean };
    const views = new Map<string, View[]>();
    for (const r of resources ?? []) {
      const own = libErr ? [r.image, ...(Array.isArray(r.refs) ? r.refs : [])].filter(isImg).map((img) => ({ img, term: "inconnu" }))
        : (lib ?? []).filter((x) => x.resource_id === r.id && isImg(x.image)).map((x) => ({ img: x.image as string, term: x.terminal_type as string, main: !!x.screen_main }));
      if (own.length) views.set(r.id, own);
    }
    // 80 images au plus : jusqu'à 4 par ressource. On privilégie l'écran de la capture s'il est connu,
    // sinon on alterne les écrans pour que chacun soit représenté ; l'image principale passe en premier.
    const MAX_REFS = 80;
    const per = Math.max(1, Math.min(4, Math.floor(MAX_REFS / Math.max(1, views.size))));
    function pick(r: { image: string }, list: View[]): View[] {
      const groups = new Map<string, View[]>();
      for (const v of list) { if (!groups.has(v.term)) groups.set(v.term, []); groups.get(v.term)!.push(v); }
      for (const g of groups.values()) g.sort((a, b) => Number(!!b.main) - Number(!!a.main) || Number(b.img === r.image) - Number(a.img === r.image));
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
    // Raffinerie : les noms sont écrits et les icônes identiques, les images de référence ne servent à rien.
    const refBlocks = hint === "raffinerie" ? [] : (resources ?? []).flatMap((r) => {
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
          { type: "text", text: buildPrompt(known, refs, panel) },
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
