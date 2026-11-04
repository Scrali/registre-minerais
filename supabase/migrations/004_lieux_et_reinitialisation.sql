-- Registre des minerais : stock par lieu de stockage (station, ville…) et réinitialisation complète.
-- À exécuter APRÈS 003, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
--
-- resources.places = { "Lorville": { "258": 20 }, "Port Tressler": { "300": 4 }, "": { … } }
-- La clé "" = lieu non précisé. resources.lots reste le total de tous les lieux.

alter table public.resources add column if not exists places jsonb not null default '{}'::jsonb;
-- Le stock existant va dans « lieu non précisé ».
update public.resources set places = jsonb_build_object('', lots)
  where places = '{}'::jsonb and public.sum_lots(lots) > 0;

alter table public.movements add column if not exists place text not null default '';
alter table public.movements add column if not exists places_before jsonb;
alter table public.movements add column if not exists places_after jsonb;

-- Total de tous les lieux.
create or replace function public.places_total(p jsonb) returns jsonb
language plpgsql immutable as $$
declare o jsonb := '{}'::jsonb; v jsonb;
begin
  for v in select value from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    o := public.merge_lots(o, v, 'add');
  end loop;
  return o;
end $$;

-- Nettoie un objet de lieux : noms rognés, qualités vérifiées, lieux vides retirés.
create or replace function public.clean_places(p jsonb) returns jsonb
language plpgsql immutable as $$
declare o jsonb := '{}'::jsonb; k text; v jsonb; l jsonb; pl text;
begin
  for k, v in select key, value from jsonb_each(coalesce(p, '{}'::jsonb)) loop
    pl := left(trim(k), 80);
    l := public.merge_lots(coalesce(o -> pl, '{}'::jsonb), v, 'add');
    if l <> '{}'::jsonb then o := jsonb_set(o, array[pl], l); end if;
  end loop;
  return o;
end $$;

-- Applique un mouvement à un lieu. p_mode 'places' remplace tous les lieux par p_delta (correction complète).
drop function if exists public.apply_lots(uuid, text, jsonb, text, text, jsonb);
create or replace function public.apply_lots(
  p_id uuid, p_mode text, p_delta jsonb,
  p_source text default 'manuel', p_note text default '', p_patch jsonb default null, p_place text default ''
) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources; pl text := left(trim(coalesce(p_place, '')), 80);
        nl jsonb; np jsonb; new_lots jsonb; new_name text; new_unit text; det text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p_mode not in ('set', 'add', 'remove', 'places') then raise exception 'Mode invalide.'; end if;
  select * into r from public.resources where id = p_id for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  if p_mode = 'places' then
    np := public.clean_places(p_delta); pl := ''; det := 'Correction des lieux';
  else
    nl := public.merge_lots(coalesce(r.places -> pl, '{}'::jsonb), p_delta, p_mode);
    np := case when nl = '{}'::jsonb then r.places - pl else jsonb_set(r.places, array[pl], nl) end;
    det := public.lots_text(p_delta);
  end if;
  new_lots := public.places_total(np);
  new_name := coalesce(nullif(trim(p_patch ->> 'name'), ''), r.name);
  new_unit := coalesce(p_patch ->> 'unit', r.unit);
  update public.resources set
    lots = new_lots, places = np,
    qty = public.sum_lots(new_lots),
    name = new_name,
    unit = new_unit,
    category = coalesce(p_patch ->> 'category', category),
    color = coalesce(p_patch ->> 'color', color),
    color_name = coalesce(p_patch ->> 'color_name', color_name),
    threshold = coalesce((p_patch ->> 'threshold')::numeric, threshold),
    updated_at = now(), updated_by = auth.uid()
  where id = p_id;
  if np is distinct from r.places then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                  lots_before, lots_after, place, places_before, places_after)
    values (p_id, new_name, new_unit, r.qty, public.sum_lots(new_lots), det,
            case when p_mode = 'places' then 'set' else p_mode end, coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid(),
            r.lots, new_lots, pl, r.places, np);
  end if;
exception when unique_violation then
  raise exception 'Une ressource porte déjà ce nom.';
end $$;

-- Création : p.places (tous les lieux) ou p.lots + p.place (un seul lieu).
create or replace function public.create_resource(p jsonb, p_source text default 'manuel', p_note text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare np jsonb; l jsonb; pl text := left(trim(coalesce(p ->> 'place', '')), 80); new_id uuid;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p ? 'places' then np := public.clean_places(p -> 'places');
  else
    l := public.merge_lots('{}'::jsonb, p -> 'lots', 'set');
    np := case when l = '{}'::jsonb then '{}'::jsonb else jsonb_build_object(pl, l) end;
  end if;
  l := public.places_total(np);
  insert into public.resources (name, category, unit, color, color_name, threshold, lots, places, qty, updated_by)
  values (trim(p ->> 'name'), coalesce(p ->> 'category', ''), coalesce(p ->> 'unit', ''),
          coalesce(p ->> 'color', ''), coalesce(p ->> 'color_name', ''),
          coalesce((p ->> 'threshold')::numeric, 0), l, np, public.sum_lots(l), auth.uid())
  returning id into new_id;
  if public.sum_lots(l) > 0 then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                  lots_before, lots_after, place, places_before, places_after)
    values (new_id, trim(p ->> 'name'), coalesce(p ->> 'unit', ''), 0, public.sum_lots(l), public.lots_text(l),
            'create', coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid(), '{}'::jsonb, l,
            case when p ? 'places' then '' else pl end, '{}'::jsonb, np);
  end if;
  return new_id;
exception when unique_violation then
  raise exception 'Une ressource porte déjà ce nom.';
end $$;

-- Fusion : les lots de la source s'ajoutent à la cible, lieu par lieu.
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.resources; t public.resources; np jsonb; k text; v jsonb; new_lots jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_source = p_target then raise exception 'Choisis deux ressources différentes.'; end if;
  select * into t from public.resources where id = p_target for update;
  select * into s from public.resources where id = p_source for update;
  if t.id is null or s.id is null then raise exception 'Ressource introuvable.'; end if;
  np := t.places;
  for k, v in select key, value from jsonb_each(s.places) loop
    np := jsonb_set(np, array[k], public.merge_lots(coalesce(np -> k, '{}'::jsonb), v, 'add'));
  end loop;
  np := public.clean_places(np);
  new_lots := public.places_total(np);
  update public.resources set
    lots = new_lots, places = np, qty = public.sum_lots(new_lots),
    color = case when color = '' then s.color else color end,
    color_name = case when color_name = '' then s.color_name else color_name end,
    image = case when image = '' then s.image else image end,
    updated_at = now(), updated_by = auth.uid()
  where id = p_target;
  update public.movements set resource_id = p_target where resource_id = p_source;
  delete from public.resources where id = p_source;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                lots_before, lots_after, places_before, places_after)
  values (p_target, t.name, t.unit, t.qty, public.sum_lots(new_lots), public.lots_text(s.lots), 'merge', 'admin',
          'Fusion de « ' || s.name || ' »', auth.uid(), t.lots, new_lots, t.places, np);
end $$;

-- Annulation : on retire l'écart que le mouvement avait apporté, lieu par lieu et lot par lot.
-- Les mouvements d'avant cette mise à jour sont rapportés au « lieu non précisé ».
create or replace function public.undo_movement(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare m public.movements; r public.resources; pb jsonb; pa jsonb; np jsonb; pl text; k text; d numeric; o jsonb; new_lots jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  select * into m from public.movements where id = p_id for update;
  if not found then raise exception 'Mouvement introuvable.'; end if;
  if m.undone_at is not null then raise exception 'Ce mouvement a déjà été annulé.'; end if;
  if m.mode in ('delete', 'merge', 'undo') or m.lots_before is null or m.lots_after is null then
    raise exception 'Ce mouvement ne peut pas être annulé.';
  end if;
  select * into r from public.resources where id = m.resource_id for update;
  if not found then raise exception 'La ressource n''existe plus.'; end if;
  pb := coalesce(m.places_before, jsonb_build_object('', m.lots_before));
  pa := coalesce(m.places_after, jsonb_build_object('', m.lots_after));
  np := r.places;
  for pl in select key from jsonb_each(pb) union select key from jsonb_each(pa) loop
    o := coalesce(np -> pl, '{}'::jsonb);
    for k in select key from jsonb_each(coalesce(pb -> pl, '{}'::jsonb)) union select key from jsonb_each(coalesce(pa -> pl, '{}'::jsonb)) loop
      d := coalesce((pa -> pl ->> k)::numeric, 0) - coalesce((pb -> pl ->> k)::numeric, 0);
      if d <> 0 then o := jsonb_set(o, array[k], to_jsonb(greatest(0, coalesce((o ->> k)::numeric, 0) - d))); end if;
    end loop;
    np := jsonb_set(np, array[pl], o);
  end loop;
  np := public.clean_places(np);
  new_lots := public.places_total(np);
  update public.resources set lots = new_lots, places = np, qty = public.sum_lots(new_lots), updated_at = now(), updated_by = auth.uid()
    where id = r.id;
  update public.movements set undone_at = now(), undone_by = auth.uid() where id = p_id;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                lots_before, lots_after, undo_of, place, places_before, places_after)
  values (r.id, r.name, r.unit, r.qty, public.sum_lots(new_lots), m.detail, 'undo', 'admin',
          'Annulation du mouvement du ' || to_char(m.at at time zone 'Europe/Paris', 'DD/MM à HH24:MI'),
          auth.uid(), r.lots, new_lots, p_id, m.place, r.places, np);
end $$;

-- Réinitialisation complète : efface toutes les ressources et tout le journal. Les comptes sont conservés.
create or replace function public.reset_registre(p_confirm text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_confirm is distinct from 'REINITIALISER' then raise exception 'Confirmation incorrecte.'; end if;
  delete from public.movements where true;
  delete from public.resources where true;
end $$;

revoke execute on function public.apply_lots(uuid, text, jsonb, text, text, jsonb, text) from public, anon;
revoke execute on function public.reset_registre(text) from public, anon;
grant execute on function public.apply_lots(uuid, text, jsonb, text, text, jsonb, text) to authenticated;
grant execute on function public.reset_registre(text) to authenticated;
