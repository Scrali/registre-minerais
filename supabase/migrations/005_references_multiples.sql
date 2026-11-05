-- Registre des minerais : plusieurs images de référence par ressource
-- (le même caillou peut s'afficher un peu différemment selon l'écran : inventaire, ascenseur de fret…).
-- À exécuter APRÈS 004, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.

-- resources.image reste l'image principale (affichée dans le stock) ; resources.refs = images supplémentaires.
alter table public.resources add column if not exists refs jsonb not null default '[]'::jsonb;

-- Ajoute une référence. Sans image principale, elle devient l'image principale. 6 références supplémentaires au plus :
-- la plus ancienne est retirée.
create or replace function public.add_resource_ref(p_id uuid, p_image text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p_image is null or p_image not like 'data:image/jpeg;base64,%' or length(p_image) > 80000 then
    raise exception 'Image invalide ou trop lourde.';
  end if;
  select * into r from public.resources where id = p_id for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  if r.image = '' then
    update public.resources set image = p_image where id = p_id;
  elsif r.image <> p_image and not r.refs @> jsonb_build_array(p_image) then
    update public.resources
      set refs = (case when jsonb_array_length(refs) >= 6 then refs - 0 else refs end) || jsonb_build_array(p_image)
      where id = p_id;
  end if;
end $$;

-- Retire une référence. p_index = -1 : l'image principale (la première référence supplémentaire la remplace).
create or replace function public.remove_resource_ref(p_id uuid, p_index int) returns void
language plpgsql security definer set search_path = public as $$
declare r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into r from public.resources where id = p_id for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  if p_index < 0 then
    update public.resources set image = coalesce(r.refs ->> 0, ''), refs = r.refs - 0 where id = p_id;
  else
    update public.resources set refs = r.refs - p_index where id = p_id;
  end if;
end $$;

-- Fusion : les références de la source sont gardées par la cible.
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.resources; t public.resources; np jsonb; k text; v jsonb; new_lots jsonb; nr jsonb;
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
  nr := t.refs || case when s.image <> '' and t.image <> '' then jsonb_build_array(s.image) else '[]'::jsonb end || s.refs;
  while jsonb_array_length(nr) > 6 loop nr := nr - 0; end loop;
  update public.resources set
    lots = new_lots, places = np, qty = public.sum_lots(new_lots),
    color = case when color = '' then s.color else color end,
    color_name = case when color_name = '' then s.color_name else color_name end,
    image = case when image = '' then s.image else image end,
    refs = nr,
    updated_at = now(), updated_by = auth.uid()
  where id = p_target;
  update public.movements set resource_id = p_target where resource_id = p_source;
  delete from public.resources where id = p_source;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                lots_before, lots_after, places_before, places_after)
  values (p_target, t.name, t.unit, t.qty, public.sum_lots(new_lots), public.lots_text(s.lots), 'merge', 'admin',
          'Fusion de « ' || s.name || ' »', auth.uid(), t.lots, new_lots, t.places, np);
end $$;

revoke execute on function public.add_resource_ref(uuid, text) from public, anon;
revoke execute on function public.remove_resource_ref(uuid, int) from public, anon;
grant execute on function public.add_resource_ref(uuid, text) to authenticated;
grant execute on function public.remove_resource_ref(uuid, int) to authenticated;
