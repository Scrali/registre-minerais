-- Registre des minerais : nom anglais des ressources, et relevé complet protégé contre les changements d'unité.
-- À exécuter APRÈS 015, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ne supprime rien. Ajoute une colonne (remplie à partir des correspondances validées avec le jeu) et une fonction,
-- et ajuste apply_scan.
--
-- 1. resources.name_en : nom du jeu en anglais (« fer » -> « Iron »). Aide à reconnaître les captures du jeu en anglais
--    et s'affiche à côté du nom du registre.
-- 2. Relevé « inventaire complet » : une ligne absente de la capture passait à 0. Si la même ressource et la même qualité
--    ont été lues dans une AUTRE unité (ex. 0,5 SCU au registre, « ×1 » objet sur l'ascenseur de fret), c'est très
--    probablement le même lot vu autrement : la ligne n'est plus mise à 0, elle est signalée (unit_conflicts).

-- ---------- 1. Nom anglais ----------
alter table public.resources add column if not exists name_en text not null default '' check (length(name_en) <= 80);

-- Pré-remplissage depuis les correspondances validées (ressource raffinée ou objet), seulement si le nom diffère.
update public.resources r set name_en = m.name
from public.sc_material_map mm join public.sc_materials m using (api_uuid)
where mm.status = 'confirmed' and mm.resource_id = r.id and m.kind in ('resource', 'item')
  and r.name_en = '' and public._sc_norm(m.name) <> public._sc_norm(r.name);

create or replace function public.set_resource_name_en(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := left(trim(coalesce(p_name, '')), 80);
begin
  perform public._need('catalog');
  if not exists (select 1 from public.resources where id = p_id) then raise exception 'Ressource introuvable.'; end if;
  if v <> '' and exists (select 1 from public.resources where id <> p_id
       and (public._sc_norm(name) = public._sc_norm(v) or (name_en <> '' and public._sc_norm(name_en) = public._sc_norm(v)))) then
    raise exception 'Ce nom anglais correspond déjà à une autre ressource.';
  end if;
  update public.resources set name_en = v, updated_at = now(), updated_by = auth.uid() where id = p_id;
end $$;
revoke execute on function public.set_resource_name_en(uuid, text) from public, anon;
grant execute on function public.set_resource_name_en(uuid, text) to authenticated;

-- ---------- 2. Relevé complet : pas de mise à 0 d'un lot vu dans une autre unité ----------
do $$
declare d text; n int;
begin
  d := pg_get_functiondef('public.apply_scan(jsonb, boolean)'::regprocedure);
  if position('unit_conflicts' in d) > 0 then return; end if;   -- déjà fait

  n := length(d);
  d := replace(d, $q$v_similar jsonb := '[]'::jsonb; v_s jsonb;$q$, $q$v_similar jsonb := '[]'::jsonb; v_s jsonb; v_conf jsonb := '[]'::jsonb;$q$);
  if length(d) = n then raise exception 'apply_scan : déclarations introuvables.'; end if;

  -- Lignes absentes de la capture : on écarte celles dont la ressource et la qualité ont été lues dans une autre unité.
  n := length(d);
  d := replace(d, $q$        and not ((s.resource_id || '|' || s.quality_key || '|' || s.unit) = any (v_seen))
    loop$q$, $q$        and not ((s.resource_id || '|' || s.quality_key || '|' || s.unit) = any (v_seen))
        and not exists (select 1 from unnest(v_seen) x
                        where split_part(x, '|', 1) = s.resource_id::text and split_part(x, '|', 2) = s.quality_key)
    loop$q$);
  if length(d) = n then raise exception 'apply_scan : boucle des lignes absentes introuvable.'; end if;

  -- Ces lignes conservées sont renvoyées pour que l'aperçu les signale.
  n := length(d);
  d := replace(d, $q$  v_result := jsonb_build_object($q$, $q$  if v_cov = 'complete' then
    select coalesce(jsonb_agg(jsonb_build_object('resource_id', s.resource_id, 'name', r.name, 'quality_key', s.quality_key,
             'unit', s.unit, 'quantity', s.quantity) order by r.name, s.quality_key), '[]'::jsonb)
    into v_conf
    from public.user_stocks s join public.resources r on r.id = s.resource_id
    where s.user_id = v_owner and s.location_id = v_loc and s.quantity > 0
      and not ((s.resource_id || '|' || s.quality_key || '|' || s.unit) = any (v_seen))
      and exists (select 1 from unnest(v_seen) x
                  where split_part(x, '|', 1) = s.resource_id::text and split_part(x, '|', 2) = s.quality_key);
  end if;
  v_result := jsonb_build_object('unit_conflicts', v_conf,$q$);
  if length(d) = n then raise exception 'apply_scan : résultat introuvable.'; end if;

  execute d;
end $$;
