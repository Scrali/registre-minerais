-- Registre des minerais : image du caillou pour chaque ressource (vignette découpée dans une capture).
-- À exécuter APRÈS 002, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.

alter table public.resources add column if not exists image text not null default '';

-- Enregistre la vignette d'une ressource. Par défaut, ne remplace pas une image déjà présente.
-- p_image vide (avec p_replace) efface l'image.
create or replace function public.set_resource_image(p_id uuid, p_image text, p_replace boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  p_image := coalesce(p_image, '');
  if p_image <> '' and (p_image not like 'data:image/jpeg;base64,%' or length(p_image) > 80000) then
    raise exception 'Image invalide ou trop lourde.';
  end if;
  update public.resources set image = p_image
  where id = p_id and (p_replace or image = '');
end $$;

revoke execute on function public.set_resource_image(uuid, text, boolean) from public, anon;
grant execute on function public.set_resource_image(uuid, text, boolean) to authenticated;
