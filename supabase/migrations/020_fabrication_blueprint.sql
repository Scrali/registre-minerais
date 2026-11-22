-- 020 : « J'ai fabriqué ×N » — retrait en une seule opération de tous les lots consommés par un blueprint.
-- Non destructive : une contrainte élargie et une fonction ajoutée.

-- Les fabrications sont des opérations idempotentes comme les autres (double clic = un seul retrait).
alter table public.stock_operations drop constraint if exists stock_operations_kind_check;
alter table public.stock_operations add constraint stock_operations_kind_check
  check (kind in ('adjust', 'transfer', 'reverse', 'craft'));

-- p = { operation_id (uuid, obligatoire sauf aperçu), dry_run?, blueprint_id, crafts,
--       lines: [{ location_id, resource_id, quality_key, unit, quantity, expected_before? }] }
-- Chaque ligne est un lot exact du membre connecté (lieu, ressource, qualité, unité) : jamais une autre qualité,
-- jamais le stock d'un autre membre. Tout est retiré dans la même transaction : si un seul lot manque ou a changé
-- depuis l'aperçu, rien n'est retiré. Les mouvements portent la nature « Consommation » et le nom du blueprint.
create or replace function public.craft_blueprint(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid := auth.uid(); v_bp text; v_crafts integer; v_note text; l jsonb; v_loc uuid; v_res uuid; v_q text; v_unit text;
        v_qty numeric; v_cur numeric; v_name text; v_lines jsonb := '[]'::jsonb; v_ch jsonb;
        v_dry boolean := coalesce((p ->> 'dry_run')::boolean, false); v_hash text := public._op_hash(p); v_prev jsonb; k text; seen text[] := '{}';
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select coalesce(nullif(output_name, ''), key) into v_bp from public.sc_blueprints where id = nullif(p ->> 'blueprint_id', '')::bigint;
  if v_bp is null then raise exception 'Blueprint introuvable.'; end if;
  v_crafts := coalesce((p ->> 'crafts')::integer, 0);
  if v_crafts < 1 or v_crafts > 999 then raise exception 'Nombre de fabrications invalide.'; end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then raise exception 'Aucun lot à retirer.'; end if;
  if jsonb_array_length(p -> 'lines') > 200 then raise exception 'Trop de lots dans une seule fabrication.'; end if;
  v_note := left('Fabrication ×' || v_crafts || ' : ' || v_bp, 300);
  if not v_dry then
    v_prev := public._op_replay(p, 'craft', v_hash);
    if v_prev is not null then return v_prev; end if;
    -- Verrous des inventaires concernés, toujours dans le même ordre (pas d'interblocage).
    for k in select distinct v_owner::text || '/' || (x ->> 'location_id') from jsonb_array_elements(p -> 'lines') x order by 1 loop
      perform pg_advisory_xact_lock(hashtextextended(k, 0));
    end loop;
  end if;

  for l in select * from jsonb_array_elements(p -> 'lines') loop
    v_loc := nullif(l ->> 'location_id', '')::uuid;
    v_res := nullif(l ->> 'resource_id', '')::uuid;
    v_q := public._qkey(l ->> 'quality_key');
    v_unit := public._unit(l ->> 'unit');
    v_qty := public._qty(l, 'quantity');
    select name into v_name from public.resources where id = v_res;
    if v_name is null then raise exception 'Ressource introuvable.'; end if;
    if not exists (select 1 from public.locations where id = v_loc) then raise exception 'Lieu introuvable.'; end if;
    k := v_loc::text || '|' || v_res::text || '|' || v_q || '|' || v_unit;
    if k = any(seen) then raise exception 'Le même lot figure deux fois dans la fabrication.'; end if;
    seen := seen || k;
    select quantity into v_cur from public.user_stocks
      where user_id = v_owner and location_id = v_loc and resource_id = v_res and quality_key = v_q and unit = v_unit;
    v_cur := coalesce(v_cur, 0);
    if nullif(l ->> 'expected_before', '') is not null and (l ->> 'expected_before')::numeric <> v_cur then
      raise exception 'STATE_CHANGED: le stock de % (%) vaut maintenant % (et non %). Vérifie l''aperçu avant de confirmer.',
        v_name, case when v_q = '-' then 'qualité inconnue' else 'Q' || v_q end, v_cur, (l ->> 'expected_before')::numeric;
    end if;
    if v_qty > v_cur then
      raise exception 'Stock insuffisant de % (%) : % disponible(s), % demandé(s). Rien n''a été retiré.',
        v_name, case when v_q = '-' then 'qualité inconnue' else 'Q' || v_q end, v_cur, v_qty;
    end if;
    if v_dry then
      v_ch := jsonb_build_object('resource_id', v_res, 'name', v_name, 'quality_key', v_q, 'unit', v_unit,
                                 'before', v_cur, 'after', v_cur - v_qty, 'delta', -v_qty);
    else
      v_ch := public._write_stock(v_owner, v_loc, v_res, v_q, v_unit, v_cur - v_qty, 'consumption', 'stock', v_note, null);
      if v_ch is null or (v_ch ->> 'delta')::numeric <> -v_qty then raise exception 'Fabrication incohérente : rien n''a été enregistré.'; end if;
    end if;
    v_lines := v_lines || jsonb_build_array(v_ch || jsonb_build_object('location_id', v_loc));
  end loop;

  if v_dry then return jsonb_build_object('dry_run', true, 'blueprint', v_bp, 'crafts', v_crafts, 'lines', v_lines); end if;
  return public._op_save(p, 'craft', v_hash, jsonb_build_object('blueprint', v_bp, 'crafts', v_crafts, 'note', v_note, 'lines', v_lines));
end $$;
revoke all on function public.craft_blueprint(jsonb) from public, anon;
grant execute on function public.craft_blueprint(jsonb) to authenticated;
