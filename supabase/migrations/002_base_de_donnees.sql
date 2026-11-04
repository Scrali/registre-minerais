-- Registre des minerais : onglet « Base de données » (fusion de ressources, annulation de mouvements).
-- À exécuter APRÈS schema.sql, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.

-- Chaque mouvement garde l'état des lots avant et après, pour pouvoir l'annuler.
alter table public.movements add column if not exists lots_before jsonb;
alter table public.movements add column if not exists lots_after jsonb;
alter table public.movements add column if not exists undone_at timestamptz;
alter table public.movements add column if not exists undone_by uuid references public.profiles (id) on delete set null;
alter table public.movements add column if not exists undo_of bigint;
create index if not exists movements_resource_idx on public.movements (resource_id, at desc);

-- ---------- Actions existantes, qui enregistrent maintenant les lots avant/après ----------
create or replace function public.apply_lots(
  p_id uuid, p_mode text, p_delta jsonb,
  p_source text default 'manuel', p_note text default '', p_patch jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources; new_lots jsonb; new_name text; new_unit text;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p_mode not in ('set', 'add', 'remove') then raise exception 'Mode invalide.'; end if;
  select * into r from public.resources where id = p_id for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  new_lots := public.merge_lots(r.lots, p_delta, p_mode);
  new_name := coalesce(nullif(trim(p_patch ->> 'name'), ''), r.name);
  new_unit := coalesce(p_patch ->> 'unit', r.unit);
  update public.resources set
    lots = new_lots,
    qty = public.sum_lots(new_lots),
    name = new_name,
    unit = new_unit,
    category = coalesce(p_patch ->> 'category', category),
    color = coalesce(p_patch ->> 'color', color),
    color_name = coalesce(p_patch ->> 'color_name', color_name),
    threshold = coalesce((p_patch ->> 'threshold')::numeric, threshold),
    updated_at = now(), updated_by = auth.uid()
  where id = p_id;
  if new_lots is distinct from r.lots then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by, lots_before, lots_after)
    values (p_id, new_name, new_unit, r.qty, public.sum_lots(new_lots), public.lots_text(p_delta),
            p_mode, coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid(), r.lots, new_lots);
  end if;
exception when unique_violation then
  raise exception 'Une ressource porte déjà ce nom.';
end $$;

create or replace function public.create_resource(p jsonb, p_source text default 'manuel', p_note text default '')
returns uuid
language plpgsql security definer set search_path = public as $$
declare l jsonb; new_id uuid;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  l := public.merge_lots('{}'::jsonb, p -> 'lots', 'set');
  insert into public.resources (name, category, unit, color, color_name, threshold, lots, qty, updated_by)
  values (trim(p ->> 'name'), coalesce(p ->> 'category', ''), coalesce(p ->> 'unit', ''),
          coalesce(p ->> 'color', ''), coalesce(p ->> 'color_name', ''),
          coalesce((p ->> 'threshold')::numeric, 0), l, public.sum_lots(l), auth.uid())
  returning id into new_id;
  if public.sum_lots(l) > 0 then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by, lots_before, lots_after)
    values (new_id, trim(p ->> 'name'), coalesce(p ->> 'unit', ''), 0, public.sum_lots(l), public.lots_text(l),
            'create', coalesce(p_source, 'manuel'), coalesce(p_note, ''), auth.uid(), '{}'::jsonb, l);
  end if;
  return new_id;
exception when unique_violation then
  raise exception 'Une ressource porte déjà ce nom.';
end $$;

create or replace function public.delete_resource(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  delete from public.resources where id = p_id returning * into r;
  if found then
    insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, by, lots_before, lots_after)
    values (r.id, r.name, r.unit, r.qty, 0, public.lots_text(r.lots), 'delete', 'manuel', auth.uid(), r.lots, '{}'::jsonb);
  end if;
end $$;

-- ---------- Fusion : les lots de la source s'ajoutent à la cible, puis la source disparaît ----------
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.resources; t public.resources; new_lots jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  if p_source = p_target then raise exception 'Choisis deux ressources différentes.'; end if;
  select * into t from public.resources where id = p_target for update;
  select * into s from public.resources where id = p_source for update;
  if t.id is null or s.id is null then raise exception 'Ressource introuvable.'; end if;
  new_lots := public.merge_lots(t.lots, s.lots, 'add');
  update public.resources set
    lots = new_lots, qty = public.sum_lots(new_lots),
    color = case when color = '' then s.color else color end,
    color_name = case when color_name = '' then s.color_name else color_name end,
    updated_at = now(), updated_by = auth.uid()
  where id = p_target;
  -- L'historique de la source est rattaché à la cible.
  update public.movements set resource_id = p_target where resource_id = p_source;
  delete from public.resources where id = p_source;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by, lots_before, lots_after)
  values (p_target, t.name, t.unit, t.qty, public.sum_lots(new_lots), public.lots_text(s.lots), 'merge', 'admin',
          'Fusion de « ' || s.name || ' »', auth.uid(), t.lots, new_lots);
end $$;

-- ---------- Annulation : on retire l'écart que le mouvement avait apporté, lot par lot ----------
-- Les mouvements arrivés depuis sont conservés. Impossible pour les suppressions, fusions et annulations.
create or replace function public.undo_movement(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare m public.movements; r public.resources; k text; d numeric; o jsonb; new_lots jsonb;
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
  o := r.lots;
  for k in select key from jsonb_each(m.lots_before) union select key from jsonb_each(m.lots_after) loop
    d := coalesce((m.lots_after ->> k)::numeric, 0) - coalesce((m.lots_before ->> k)::numeric, 0);
    if d <> 0 then
      o := jsonb_set(o, array[k], to_jsonb(greatest(0, coalesce((o ->> k)::numeric, 0) - d)));
    end if;
  end loop;
  select coalesce(jsonb_object_agg(key, value::numeric), '{}'::jsonb) into new_lots
    from jsonb_each_text(o) where value::numeric > 0;
  update public.resources set lots = new_lots, qty = public.sum_lots(new_lots), updated_at = now(), updated_by = auth.uid()
    where id = r.id;
  update public.movements set undone_at = now(), undone_by = auth.uid() where id = p_id;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by, lots_before, lots_after, undo_of)
  values (r.id, r.name, r.unit, r.qty, public.sum_lots(new_lots), m.detail, 'undo', 'admin',
          'Annulation du mouvement du ' || to_char(m.at at time zone 'Europe/Paris', 'DD/MM à HH24:MI'),
          auth.uid(), r.lots, new_lots, p_id);
end $$;

revoke execute on function public.merge_resources(uuid, uuid) from public, anon;
revoke execute on function public.undo_movement(bigint) from public, anon;
grant execute on function public.merge_resources(uuid, uuid) to authenticated;
grant execute on function public.undo_movement(bigint) to authenticated;
