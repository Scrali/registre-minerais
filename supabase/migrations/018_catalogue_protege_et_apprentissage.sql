-- 018 : catalogue protégé, catalogue du jeu (minerais, gemmes, armes, composants de vaisseau) et apprentissage
-- de la lecture des infobulles.
-- Non destructive : aucune donnée existante n'est supprimée ; seules des colonnes, une table et des fonctions
-- sont ajoutées ou remplacées.

-- 1. Ressources protégées : une ressource du catalogue (locked) ne peut être ni supprimée ni fusionnée dans une
--    autre, et sa protection ne peut pas être retirée depuis le site.
alter table public.resources add column if not exists locked boolean not null default false;

create or replace function public._resources_protect() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.locked then raise exception 'Ressource du catalogue protégée : « % » ne peut pas être supprimée.', old.name; end if;
    return old;
  end if;
  if old.locked and not new.locked then
    raise exception 'Ressource du catalogue protégée : « % » le reste.', old.name;
  end if;
  return new;
end $$;

drop trigger if exists resources_protect on public.resources;
create trigger resources_protect before delete or update of locked on public.resources
  for each row execute function public._resources_protect();

-- La réinitialisation du registre vide les stocks et l'historique mais garde le catalogue protégé (quantités à zéro).
create or replace function public._impl_reset_registre(p_confirm text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_confirm is distinct from 'REINITIALISER' then raise exception 'Confirmation incorrecte.'; end if;
  delete from public.scan_items where true;
  delete from public.inventory_scans where true;
  delete from public.user_stocks where true;
  delete from public.legacy_stocks where true;
  delete from public.movements where true;
  delete from public.resources where not locked;
  update public.resources set lots = '{}'::jsonb, places = '{}'::jsonb, qty = 0, updated_at = now() where locked;
end $$;

-- 2. Catalogue du jeu. Ressource existante du même nom (ex. « Hadanite ») : complétée et protégée, rien n'est dupliqué.
create or replace function public._catalog_add(p_name text, p_en text, p_cat text, p_unit text)
returns uuid language plpgsql set search_path = public as $$
declare rid uuid;
begin
  select id into rid from public.resources where lower(name) = lower(p_name)
    or (p_en <> '' and lower(name) = lower(p_en)) or (p_en <> '' and lower(coalesce(name_en, '')) = lower(p_en)) limit 1;
  if rid is null then
    insert into public.resources (name, name_en, category, unit, locked) values (p_name, p_en, p_cat, p_unit, true) returning id into rid;
  else
    update public.resources set locked = true,
      name_en = case when coalesce(name_en, '') = '' then p_en else name_en end,
      category = case when coalesce(category, '') = '' then p_cat else category end
    where id = rid;
  end if;
  return rid;
end $$;

-- Le remplissage est une fonction appelée une fois en production (pas à chaque migration : les bases de test
-- partent vides). Relançable : rien n'est dupliqué.
create or replace function public.seed_game_catalog()
returns integer language plpgsql security definer set search_path = public as $$
declare m record; before integer;
begin
  if auth.uid() is not null and not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  select count(*) into before from public.resources;
  -- Matières (français, anglais, catégorie, unité). Les minerais bruts : « X (brut) » / « X (Ore) ».
  for m in select * from (values
    ('Agricium','Agricium','Minerai raffiné','SCU'), ('Aluminium','Aluminum','Minerai raffiné','SCU'),
    ('Aslarite','Aslarite','Minerai raffiné','SCU'), ('Béryl','Beryl','Minerai raffiné','SCU'),
    ('Bexalite','Bexalite','Minerai raffiné','SCU'), ('Borase','Borase','Minerai raffiné','SCU'),
    ('Cuivre','Copper','Minerai raffiné','SCU'), ('Corindon','Corundum','Minerai raffiné','SCU'),
    ('Or','Gold','Minerai raffiné','SCU'), ('Hephaestanite','Hephaestanite','Minerai raffiné','SCU'),
    ('Fer','Iron','Minerai raffiné','SCU'), ('Laranite','Laranite','Minerai raffiné','SCU'),
    ('Lindinium','Lindinium','Minerai raffiné','SCU'), ('Ouratite','Ouratite','Minerai raffiné','SCU'),
    ('Glace','Pressurized Ice','Minerai raffiné','SCU'), ('Quantainium','Quantainium','Minerai raffiné','SCU'),
    ('Quartz','Quartz','Minerai raffiné','SCU'), ('Riccite','Riccite','Minerai raffiné','SCU'),
    ('Savrilium','Savrilium','Minerai raffiné','SCU'), ('Silicium','Silicon','Minerai raffiné','SCU'),
    ('Stileron','Stileron','Minerai raffiné','SCU'), ('Taranite','Taranite','Minerai raffiné','SCU'),
    ('Étain','Tin','Minerai raffiné','SCU'), ('Titane','Titanium','Minerai raffiné','SCU'),
    ('Torite','Torite','Minerai raffiné','SCU'), ('Tungstène','Tungsten','Minerai raffiné','SCU'),
    ('Agricium (brut)','Agricium (Ore)','Minerai brut','SCU'), ('Aluminium (brut)','Aluminum (Ore)','Minerai brut','SCU'),
    ('Aslarite (brut)','Aslarite (Ore)','Minerai brut','SCU'), ('Béryl (brut)','Beryl (Ore)','Minerai brut','SCU'),
    ('Bexalite (brut)','Bexalite (Ore)','Minerai brut','SCU'), ('Borase (brut)','Borase (Ore)','Minerai brut','SCU'),
    ('Cuivre (brut)','Copper (Ore)','Minerai brut','SCU'), ('Corindon (brut)','Corundum (Ore)','Minerai brut','SCU'),
    ('Or (brut)','Gold (Ore)','Minerai brut','SCU'), ('Hephaestanite (brut)','Hephaestanite (Ore)','Minerai brut','SCU'),
    ('Fer (brut)','Iron (Ore)','Minerai brut','SCU'), ('Laranite (brut)','Laranite (Ore)','Minerai brut','SCU'),
    ('Lindinium (brut)','Lindinium (Ore)','Minerai brut','SCU'), ('Ouratite (brut)','Ouratite (Ore)','Minerai brut','SCU'),
    ('Glace (brut)','Pressurized Ice (Ore)','Minerai brut','SCU'), ('Quantainium (brut)','Quantainium (Ore)','Minerai brut','SCU'),
    ('Quartz (brut)','Quartz (Ore)','Minerai brut','SCU'), ('Riccite (brut)','Riccite (Ore)','Minerai brut','SCU'),
    ('Savrilium (brut)','Savrilium (Ore)','Minerai brut','SCU'), ('Silicium (brut)','Silicon (Ore)','Minerai brut','SCU'),
    ('Stileron (brut)','Stileron (Ore)','Minerai brut','SCU'), ('Taranite (brut)','Taranite (Ore)','Minerai brut','SCU'),
    ('Étain (brut)','Tin (Ore)','Minerai brut','SCU'), ('Titane (brut)','Titanium (Ore)','Minerai brut','SCU'),
    ('Torite (brut)','Torite (Ore)','Minerai brut','SCU'), ('Tungstène (brut)','Tungsten (Ore)','Minerai brut','SCU'),
    ('Aphorite','Aphorite','Gemme',''), ('Beradom','Beradom','Gemme',''), ('Carinite','Carinite','Gemme',''),
    ('Dolivine','Dolivine','Gemme',''), ('Feynmaline','Feynmaline','Gemme',''), ('Glacosite','Glacosite','Gemme',''),
    ('Hadanite','Hadanite','Gemme',''), ('Janalite','Janalite','Gemme',''), ('Sadaryx','Sadaryx','Gemme',''),
    ('Saldynium (brut)','Saldynium (Ore)','Gemme',''), ('Œil de Yormandi','Yormandi Eye','Gemme','')
  ) as t(fr, en, cat, unit) loop
    perform public._catalog_add(m.fr, m.en, m.cat, m.unit);
  end loop;

  -- Armes et composants de vaisseau : les objets fabricables connus par la synchronisation des blueprints
  -- (nom anglais du jeu). Rien n'est inventé : seules les sorties de blueprints réelles sont ajoutées.
  for m in select distinct on (lower(b.output_name)) b.output_name as n,
      case b.output_type when 'WeaponPersonal' then 'Arme FPS' when 'WeaponGun' then 'Arme de vaisseau'
                         else 'Composant de vaisseau' end as cat
    from public.sc_blueprints b
    where b.missing_since is null and trim(coalesce(b.output_name, '')) <> '' and b.output_name not like '%PLACEHOLDER%'
      and b.output_type in ('WeaponPersonal', 'WeaponGun', 'PowerPlant', 'Cooler', 'Shield', 'Radar', 'QuantumDrive',
                            'WeaponMining', 'MiningModifier', 'TractorBeam', 'SalvageHead', 'SalvageModifier')
    order by lower(b.output_name), b.output_type
  loop
    perform public._catalog_add(trim(m.n), trim(m.n), m.cat, '');
  end loop;

  -- Correspondances des blueprints : chaque matière du jeu retrouve sa ressource (par le nom anglais).
  update public.sc_material_map mm set resource_id = r.id
    from public.sc_materials sm, public.resources r
    where mm.api_uuid = sm.api_uuid and mm.resource_id is null and lower(r.name_en) = lower(sm.name);
  return (select count(*) from public.resources) - before;
end $$;

-- 3. Apprentissage de la lecture des infobulles, à partir des lignes enregistrées (corrigées ou confirmées).
--    kind = 'name'  : texte lu (seen, normalisé) -> ressource enregistrée ;
--    kind = 'glyph' : forme d'un chiffre d'étiquette « X N » (sample) -> chiffre enregistré (value).
create table if not exists public.ocr_learning (
  id bigserial primary key,
  kind text not null check (kind in ('name', 'glyph')),
  seen text not null default '',
  value text not null,
  resource_id uuid references public.resources(id) on delete set null,
  sample jsonb,
  was_right boolean not null default true,
  hits integer not null default 1,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ocr_learning_name_key on public.ocr_learning (seen, resource_id) where kind = 'name';
create index if not exists ocr_learning_kind on public.ocr_learning (kind, value);
alter table public.ocr_learning enable row level security;
drop policy if exists ocr_learning_read on public.ocr_learning;
create policy ocr_learning_read on public.ocr_learning for select to authenticated using (public.is_member());

-- Enregistre ce que le site a appris d'un relevé. Noms : compteur incrémenté ; chiffres : au plus 40 exemples
-- par chiffre (les plus anciens sont remplacés).
create or replace function public.learn_ocr(p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare it jsonb; n integer := 0; v text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if it ->> 'kind' = 'name' and coalesce(it ->> 'seen', '') <> '' and (it ->> 'resource_id') is not null then
      insert into public.ocr_learning (kind, seen, value, resource_id, was_right)
      select 'name', left(it ->> 'seen', 80), r.name, r.id, coalesce((it ->> 'was_right')::boolean, true)
        from public.resources r where r.id = (it ->> 'resource_id')::uuid
      on conflict (seen, resource_id) where kind = 'name'
        do update set hits = ocr_learning.hits + 1, updated_at = now();
      n := n + 1;
    elsif it ->> 'kind' = 'glyph' and (it ->> 'value') ~ '^[0-9]$' and jsonb_typeof(it -> 'sample') = 'object' then
      v := it ->> 'value';
      insert into public.ocr_learning (kind, value, sample, was_right)
        values ('glyph', v, it -> 'sample', coalesce((it ->> 'was_right')::boolean, true));
      delete from public.ocr_learning where id in (
        select id from public.ocr_learning where kind = 'glyph' and value = v order by created_at desc, id desc offset 40);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Oublie un élément appris (administrateurs).
create or replace function public.forget_ocr(p_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  delete from public.ocr_learning where id = p_id;
end $$;

revoke all on function public.learn_ocr(jsonb) from public, anon;
revoke all on function public.forget_ocr(bigint) from public, anon;
grant execute on function public.learn_ocr(jsonb) to authenticated;
grant execute on function public.forget_ocr(bigint) to authenticated;
revoke all on function public._catalog_add(text, text, text, text) from public, anon, authenticated;
revoke all on function public.seed_game_catalog() from public, anon;
grant execute on function public.seed_game_catalog() to authenticated;
