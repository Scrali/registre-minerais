-- Registre des minerais : bibliothèque d'images de référence des minerais.
-- À exécuter APRÈS 006, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
--
-- Autant d'images que nécessaire par ressource (50 au plus), chacune classée par écran d'origine
-- (inventaire personnel, ascenseur de fret…). resources.image reste l'image principale affichée dans le site.
-- Les images déjà enregistrées (resources.image et resources.refs) sont recopiées ; rien n'est supprimé.

create table if not exists public.reference_images (
  id bigint generated always as identity primary key,
  resource_id uuid not null references public.resources (id) on delete cascade,
  terminal_type text not null default 'inconnu'
    check (terminal_type in ('inventaire', 'ascenseur_fret', 'autre', 'inconnu')),
  image text not null check (image like 'data:image/jpeg;base64,%' and length(image) <= 80000),
  image_hash text generated always as (md5(image)) stored,
  source text not null default 'capture' check (source in ('capture', 'import', 'reprise')),
  note text not null default '',
  added_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint reference_images_unique unique (resource_id, image_hash)
);
create index if not exists reference_images_res_idx on public.reference_images (resource_id, terminal_type);

-- Reprise des images existantes (écran inconnu).
insert into public.reference_images (resource_id, image, source, created_at)
select r.id, img, 'reprise', r.updated_at
from public.resources r
cross join lateral (
  select r.image as img where r.image like 'data:image/jpeg;base64,%'
  union all
  select x from jsonb_array_elements_text(coalesce(r.refs, '[]'::jsonb)) x where x like 'data:image/jpeg;base64,%'
) t
where length(img) <= 80000
on conflict on constraint reference_images_unique do nothing;

alter table public.reference_images enable row level security;
drop policy if exists "images lisibles" on public.reference_images;
create policy "images lisibles" on public.reference_images for select to authenticated using (public.is_member());

-- Ajoute une image. Sans image principale, elle devient l'image principale de la ressource.
create or replace function public.add_reference_image(p_resource uuid, p_image text, p_terminal text default 'inconnu',
                                                      p_source text default 'capture', p_note text default '')
returns bigint
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_term text := coalesce(nullif(p_terminal, ''), 'inconnu');
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  if p_image is null or p_image not like 'data:image/jpeg;base64,%' or length(p_image) > 80000 then
    raise exception 'Image invalide ou trop lourde.';
  end if;
  if v_term not in ('inventaire', 'ascenseur_fret', 'autre', 'inconnu') then v_term := 'inconnu'; end if;
  perform 1 from public.resources where id = p_resource for update;
  if not found then raise exception 'Ressource introuvable.'; end if;
  select id into v_id from public.reference_images where resource_id = p_resource and image_hash = md5(p_image);
  if v_id is not null then
    -- Déjà présente : on précise seulement l'écran s'il était inconnu.
    update public.reference_images set terminal_type = v_term where id = v_id and terminal_type = 'inconnu';
    return v_id;
  end if;
  if (select count(*) from public.reference_images where resource_id = p_resource) >= 50 then
    raise exception 'Cette ressource a déjà 50 images : retires-en avant d''en ajouter.';
  end if;
  insert into public.reference_images (resource_id, terminal_type, image, source, note, added_by)
  values (p_resource, v_term, p_image, coalesce(nullif(p_source, ''), 'capture'), left(coalesce(p_note, ''), 200), auth.uid())
  returning id into v_id;
  update public.resources set image = p_image where id = p_resource and image = '';
  return v_id;
end $$;

-- Retire une image (son auteur ou un administrateur). Si c'était l'image principale, la plus récente la remplace.
create or replace function public.delete_reference_image(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare ri public.reference_images; r public.resources;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into ri from public.reference_images where id = p_id for update;
  if not found then raise exception 'Image introuvable.'; end if;
  if ri.added_by is distinct from auth.uid() and not public.is_admin() then
    raise exception 'Seul l''auteur de l''image ou un administrateur peut la retirer.';
  end if;
  delete from public.reference_images where id = p_id;
  select * into r from public.resources where id = ri.resource_id for update;
  if r.image = ri.image then
    update public.resources set image = coalesce(
      (select image from public.reference_images where resource_id = r.id order by created_at desc limit 1), '')
    where id = r.id;
  end if;
end $$;

-- Choisit l'image principale (affichée dans le stock) parmi la bibliothèque.
create or replace function public.set_primary_image(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare ri public.reference_images;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into ri from public.reference_images where id = p_id;
  if not found then raise exception 'Image introuvable.'; end if;
  update public.resources set image = ri.image where id = ri.resource_id;
end $$;

-- Fusion : la bibliothèque d'images suit la ressource conservée (version de 006 + images).
create or replace function public.merge_resources(p_source uuid, p_target uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.resources; t public.resources; np jsonb; k text; v jsonb; new_lots jsonb; nr jsonb; us record;
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
    refs = nr, updated_at = now(), updated_by = auth.uid()
  where id = p_target;
  -- Stocks personnels : même clé chez la cible -> quantités additionnées, sinon la ligne change de ressource.
  for us in select * from public.user_stocks where resource_id = p_source for update loop
    update public.user_stocks set quantity = quantity + us.quantity, version = version + 1, updated_at = now()
      where user_id = us.user_id and location_id = us.location_id and resource_id = p_target
        and quality_key = us.quality_key and unit = us.unit;
    if found then delete from public.user_stocks where id = us.id;
    else update public.user_stocks set resource_id = p_target, version = version + 1 where id = us.id;
    end if;
  end loop;
  -- Images : les doublons exacts sont retirés, les autres rejoignent la cible.
  delete from public.reference_images src_img where src_img.resource_id = p_source
    and exists (select 1 from public.reference_images tgt_img where tgt_img.resource_id = p_target and tgt_img.image_hash = src_img.image_hash);
  update public.reference_images set resource_id = p_target where resource_id = p_source;
  update public.scan_items set resource_id = p_target where resource_id = p_source;
  update public.legacy_stocks set resource_id = p_target, resource_name = t.name where resource_id = p_source;
  update public.movements set resource_id = p_target where resource_id = p_source;
  delete from public.resources where id = p_source;
  insert into public.movements (resource_id, name, unit, before, after, detail, mode, source, note, by,
                                lots_before, lots_after, places_before, places_after)
  values (p_target, t.name, t.unit, t.qty, public.sum_lots(new_lots), public.lots_text(s.lots), 'merge', 'admin',
          'Fusion de « ' || s.name || ' »', auth.uid(), t.lots, new_lots, t.places, np);
end $$;

revoke execute on function public.add_reference_image(uuid, text, text, text, text) from public, anon;
revoke execute on function public.delete_reference_image(bigint) from public, anon;
revoke execute on function public.set_primary_image(bigint) from public, anon;
grant execute on function public.add_reference_image(uuid, text, text, text, text) to authenticated;
grant execute on function public.delete_reference_image(bigint) to authenticated;
grant execute on function public.set_primary_image(bigint) to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.reference_images; exception when duplicate_object then null; end;
end $$;
