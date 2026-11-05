-- Registre des minerais : image choisie pour chaque écran du jeu.
-- À exécuter APRÈS 010, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ajoute seulement une colonne et une fonction : aucune donnée existante n'est modifiée ni supprimée.
--
-- Un minerai s'affiche différemment selon l'écran (inventaire, ascenseur de fret, ASOP). Pour chaque écran,
-- on peut choisir l'image de la bibliothèque qui le représente : elle sert de comparaison dans la vérification
-- d'une capture de cet écran, et l'IA la reçoit en premier. Sans choix, c'est la plus récente de cet écran.
-- L'image principale (resources.image), affichée dans le stock, ne change pas.

alter table public.reference_images add column if not exists screen_main boolean not null default false;

-- Choisit (ou retire, si elle l'était déjà) l'image d'un écran pour son minerai. Droit « catalogue ».
create or replace function public.set_screen_image(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare ri public.reference_images;
begin
  perform public._need('catalog');
  select * into ri from public.reference_images where id = p_id for update;
  if not found then raise exception 'Image introuvable.'; end if;
  if ri.terminal_type = 'inconnu' then raise exception 'Précise d''abord l''écran de cette image.'; end if;
  update public.reference_images set screen_main = false
   where resource_id = ri.resource_id and terminal_type = ri.terminal_type and screen_main;
  if not ri.screen_main then
    update public.reference_images set screen_main = true where id = p_id;
  end if;
end $$;

revoke execute on function public.set_screen_image(bigint) from public, anon;
grant execute on function public.set_screen_image(bigint) to authenticated;
