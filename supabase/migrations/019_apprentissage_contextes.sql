-- 019 : apprentissage des chiffres par contexte. Non destructive : une colonne ajoutée, une fonction remplacée.
--   x   : étiquette « X N » d'une gemme (valeur par défaut, celle des exemples déjà appris) ;
--   q   : qualité dans sa case de l'infobulle ;
--   scu : contenu de l'étiquette olive (« 0.115 SCU ») ;
--   ctr : compteur « Sélectionné ».
alter table public.ocr_learning add column if not exists ctx text not null default 'x';
do $$ begin
  alter table public.ocr_learning add constraint ocr_learning_ctx check (ctx in ('x', 'q', 'scu', 'ctr'));
exception when duplicate_object then null; end $$;
drop index if exists public.ocr_learning_kind;
create index if not exists ocr_learning_kind_ctx on public.ocr_learning (kind, ctx, value);

-- Au plus 40 exemples par contexte et par chiffre (les plus anciens sont remplacés).
create or replace function public.learn_ocr(p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare it jsonb; n integer := 0; v text; c text;
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
    elsif it ->> 'kind' = 'glyph' and (it ->> 'value') ~ '^[0-9]$' and jsonb_typeof(it -> 'sample') = 'object'
          and coalesce(it ->> 'ctx', 'x') in ('x', 'q', 'scu', 'ctr') then
      v := it ->> 'value'; c := coalesce(it ->> 'ctx', 'x');
      insert into public.ocr_learning (kind, ctx, value, sample, was_right)
        values ('glyph', c, v, it -> 'sample', coalesce((it ->> 'was_right')::boolean, true));
      delete from public.ocr_learning where id in (
        select id from public.ocr_learning where kind = 'glyph' and ctx = c and value = v order by created_at desc, id desc offset 40);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.learn_ocr(jsonb) from public, anon;
grant execute on function public.learn_ocr(jsonb) to authenticated;
