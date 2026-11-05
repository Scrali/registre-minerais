-- Registre des minerais : une capture de raffinerie AJOUTE au stock au lieu de le remplacer.
-- À exécuter APRÈS 012, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ne modifie ni ne supprime aucune donnée existante : ajoute une nature de mouvement et un mode à apply_scan.
--
-- Une capture d'inventaire est une observation : le stock prend la valeur lue (écart avec le relevé précédent).
-- Un ordre de raffinerie, lui, est un lot qui s'ajoute : deux ordres au même lieu s'additionnent.
-- Avec p.mode = 'add', apply_scan ajoute chaque quantité lue au stock existant ; la capture est forcément partielle
-- (rien d'autre ne change), jamais « plus ancienne que le dernier état », et un premier lot n'est pas un « stock initial ».

-- 1. Nouvelle nature de mouvement : « refined » (sortie de raffinerie), une entrée.
create or replace function public.kind_sign(k text) returns integer
language sql immutable as $$
  select case
    when k in ('increase', 'deposit', 'production', 'transfer_in', 'purchase', 'refined') then 1
    when k in ('decrease', 'withdrawal', 'sale', 'transfer_out', 'refining', 'consumption', 'loss') then -1
    when k in ('initial', 'correction', 'legacy_attribution') then 0
    else null end
$$;

-- 2. Mode « ajout » dans apply_scan : on modifie seulement quelques lignes de sa définition actuelle.
do $$
declare d text; n int;
  procedure_name constant text := 'public.apply_scan(jsonb, boolean)';
begin
  d := pg_get_functiondef(procedure_name::regprocedure);
  if position('mode_ajout' in d) > 0 then return; end if;   -- déjà fait

  -- a) Couverture forcée à « partielle » en mode ajout.
  n := length(d);
  d := replace(d, $q$v_cov := coalesce(p ->> 'coverage', 'partial');$q$,
    $q$v_cov := coalesce(p ->> 'coverage', 'partial');
  if p ->> 'mode' = 'add' then v_cov := 'partial'; end if;   -- mode_ajout$q$);
  if length(d) = n then raise exception 'apply_scan : ligne de couverture introuvable.'; end if;

  -- b) Un ajout n'est jamais « plus ancien que le dernier état ».
  n := length(d);
  d := replace(d, $q$v_stale := v_last is not null and v_obs < v_last;$q$,
    $q$v_stale := v_last is not null and v_obs < v_last and coalesce(p ->> 'mode', '') <> 'add';$q$);
  if length(d) = n then raise exception 'apply_scan : ligne d''ancienneté introuvable.'; end if;

  -- c) Quantité visée = stock actuel + quantité lue.
  n := length(d);
  d := regexp_replace(d, 'group by 1, 2, 3\s+loop',
    $q$group by 1, 2, 3
  loop
    if p ->> 'mode' = 'add' then
      if it.qty is null or it.qty <= 0 then raise exception 'Quantité invalide.'; end if;
      it.qty := it.qty + coalesce((select s.quantity from public.user_stocks s
        where s.user_id = v_owner and s.location_id = v_loc and s.resource_id = it.res and s.quality_key = it.q and s.unit = it.unit), 0);
    end if;$q$);
  if length(d) = n then raise exception 'apply_scan : boucle des lignes introuvable.'; end if;

  -- d) En mode ajout, un premier lot est une entrée (pas un « stock initial ») ; le mouvement est noté « stock ».
  n := length(d);
  d := replace(d, $q$p -> 'reasons' ->> v_k, 'scan'$q$,
    $q$p -> 'reasons' ->> v_k, case when p ->> 'mode' = 'add' then 'stock' else 'scan' end$q$);
  if length(d) - n <> 2 * (length($q$, case when p ->> 'mode' = 'add' then 'stock' else 'scan' end$q$) - length($q$, 'scan'$q$)) then
    raise exception 'apply_scan : appels de classement introuvables.';
  end if;

  execute d;
end $$;
