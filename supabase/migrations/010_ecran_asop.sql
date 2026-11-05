-- Registre des minerais : nouvel écran « Terminal ASOP » pour les captures et les images de référence.
-- À exécuter APRÈS 009, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ajoute seulement une valeur autorisée : aucune donnée existante n'est modifiée ni supprimée.

-- 1. Contraintes des colonnes terminal_type (captures et bibliothèque d'images).
do $$
declare t text; c text;
begin
  foreach t in array array['inventory_scans', 'reference_images'] loop
    for c in select conname from pg_constraint
             where conrelid = ('public.' || t)::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%terminal_type%'
    loop
      execute format('alter table public.%I drop constraint %I', t, c);
    end loop;
    execute format($f$alter table public.%I add constraint %I
      check (terminal_type in ('inventaire', 'ascenseur_fret', 'asop', 'autre', 'inconnu'))$f$, t, t || '_terminal_type_check');
  end loop;
end $$;

-- 2. Les fonctions qui ramènent un écran inconnu à « inconnu » acceptent maintenant « asop ».
--    On réécrit seulement la liste des écrans dans leur définition actuelle (droits d'exécution conservés).
do $$
declare f text; d text;
begin
  foreach f in array array['public.apply_scan(jsonb, boolean)', 'public.add_reference_image(uuid, text, text, text, text)'] loop
    d := pg_get_functiondef(f::regprocedure);
    if position('''asop''' in d) = 0 then
      d := replace(d, $q$('inventaire', 'ascenseur_fret', 'autre', 'inconnu')$q$, $q$('inventaire', 'ascenseur_fret', 'asop', 'autre', 'inconnu')$q$);
      if position('''asop''' in d) = 0 then raise exception 'Liste des écrans introuvable dans %', f; end if;
      execute d;
    end if;
  end loop;
end $$;
