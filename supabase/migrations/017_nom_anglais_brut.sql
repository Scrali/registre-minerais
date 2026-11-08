-- Registre des minerais : le nom anglais d'un minerai brut (« Agricium (Ore) ») ne se confond plus avec la ressource
-- raffinée (« Agricium »). À exécuter APRÈS 016. Peut être relancé sans risque. Ne modifie aucune donnée.
-- La comparaison des noms garde désormais les suffixes « (Ore) », « (brut) »… (place_slug au lieu de _sc_norm).
create or replace function public.set_resource_name_en(p_id uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v text := left(trim(coalesce(p_name, '')), 80);
begin
  perform public._need('catalog');
  if not exists (select 1 from public.resources where id = p_id) then raise exception 'Ressource introuvable.'; end if;
  if v <> '' and exists (select 1 from public.resources where id <> p_id
       and (public.place_slug(name) = public.place_slug(v) or (name_en <> '' and public.place_slug(name_en) = public.place_slug(v)))) then
    raise exception 'Ce nom anglais correspond déjà à une autre ressource.';
  end if;
  update public.resources set name_en = v, updated_at = now(), updated_by = auth.uid() where id = p_id;
end $$;
revoke execute on function public.set_resource_name_en(uuid, text) from public, anon;
grant execute on function public.set_resource_name_en(uuid, text) to authenticated;
