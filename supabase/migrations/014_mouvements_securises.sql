-- Registre des minerais : mouvements sécurisés (retraits, transferts, annulations) et anti-doublons.
-- À exécuter APRÈS 013, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
--
-- Migration ADDITIVE : aucune ligne existante n'est modifiée ni supprimée.
--  * Sauvegarde de user_stocks et movements dans archive.*_avant_014 (une seule fois).
--  * Nouvelles colonnes de traçabilité sur movements (operation_id, transfer_id, reverses_id, reversed_by_id).
--  * Table stock_operations : chaque opération manuelle a une clé d'idempotence vérifiée côté serveur.
--    La même opération envoyée deux fois (double clic, nouvelle tentative réseau) n'est appliquée qu'une fois.
--  * Unités normalisées à l'écriture : « scu » = « SCU », « cscu » = « cSCU », « x » / « objets » = nombre d'objets.
--    Aucune conversion automatique : 100 cSCU et 1 SCU restent deux lignes de stock distinctes.
--  * adjust_stock : clé d'opération obligatoire, aperçu (dry_run), contrôle « quantité avant » attendue,
--    alerte de doublon potentiel, nature « livraison ».
--  * transfer_stock : débit et crédit dans la même transaction, reliés par un identifiant commun.
--  * reverse_movement : annulation par mouvement compensatoire (l'original reste dans l'historique).
--  * apply_scan : unités normalisées, clé d'idempotence liée au contenu, ajout d'une capture déjà enregistrée refusé
--    sans confirmation explicite.
--  * stock_reconciliation : compare chaque stock à la somme de ses mouvements (lecture seule).

-- ---------- 0. Sauvegarde ----------
create schema if not exists archive;
revoke all on schema archive from public, anon, authenticated;
do $$ begin
  if to_regclass('archive.user_stocks_avant_014') is null then
    create table archive.user_stocks_avant_014 as select * from public.user_stocks;
    create table archive.movements_avant_014 as select * from public.movements;
  end if;
end $$;

-- ---------- 1. Natures de mouvement : « livraison » (sortie) ----------
create or replace function public.kind_sign(k text) returns integer
language sql immutable as $$
  select case
    when k in ('increase', 'deposit', 'production', 'transfer_in', 'purchase', 'refined') then 1
    when k in ('decrease', 'withdrawal', 'sale', 'transfer_out', 'refining', 'consumption', 'loss', 'delivery') then -1
    when k in ('initial', 'correction', 'legacy_attribution') then 0
    else null end
$$;

-- ---------- 2. Unités canoniques ----------
-- '' = nombre d'objets (« 20x »). SCU et cSCU gardent leur casse officielle. Autre unité : conservée telle quelle.
create or replace function public._unit(p text) returns text
language sql immutable as $$
  select case
    when lower(trim(coalesce(p, ''))) in ('', 'x', 'objet', 'objets', 'u', 'unite', 'unité', 'unites', 'unités', 'item', 'items', 'pcs') then ''
    when lower(trim(p)) = 'scu' then 'SCU'
    when lower(trim(p)) = 'cscu' then 'cSCU'
    when lower(trim(p)) in ('mscu', 'µscu', 'uscu') then 'µSCU'
    else left(trim(p), 20) end
$$;

-- Quantité saisie : positive, au plus 3 décimales (la base n'arrondit jamais en silence).
create or replace function public._qty(p jsonb, p_field text, p_allow_zero boolean default false) returns numeric
language plpgsql immutable as $$
declare v numeric;
begin
  begin v := nullif(p ->> p_field, '')::numeric; exception when others then raise exception 'Quantité invalide.'; end;
  if v is null or v < 0 or (v = 0 and not p_allow_zero) then raise exception 'La quantité doit être supérieure à zéro.'; end if;
  if v <> round(v, 3) then raise exception 'Quantité invalide : trois décimales au plus.'; end if;
  if v > 1e12 then raise exception 'Quantité invalide.'; end if;
  return v;
end $$;

-- ---------- 3. Traçabilité des mouvements ----------
alter table public.movements add column if not exists operation_id uuid;
alter table public.movements add column if not exists transfer_id uuid;
alter table public.movements add column if not exists reverses_id bigint;
alter table public.movements add column if not exists reversed_by_id bigint;
create index if not exists movements_operation_idx on public.movements (operation_id) where operation_id is not null;
create index if not exists movements_transfer_idx on public.movements (transfer_id) where transfer_id is not null;
create index if not exists movements_key_idx on public.movements (owner_id, location_id, resource_id, quality_key, unit, at desc);

-- Les fonctions d'écriture placent l'identifiant de l'opération dans la transaction ; ce trigger le recopie
-- sur chaque mouvement créé (sans changer la signature de _write_stock, utilisée par les captures).
create or replace function public._movement_tags() returns trigger
language plpgsql as $$
begin
  if new.operation_id is null then new.operation_id := nullif(current_setting('registre.op_id', true), '')::uuid; end if;
  if new.transfer_id is null then new.transfer_id := nullif(current_setting('registre.transfer_id', true), '')::uuid; end if;
  return new;
end $$;
drop trigger if exists movements_tags on public.movements;
create trigger movements_tags before insert on public.movements for each row execute function public._movement_tags();

-- ---------- 4. Opérations idempotentes ----------
create table if not exists public.stock_operations (
  id uuid primary key,                       -- clé d'idempotence générée par le navigateur
  kind text not null check (kind in ('adjust', 'transfer', 'reverse')),
  actor_id uuid references public.profiles (id) on delete set null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.stock_operations enable row level security;   -- aucune lecture ni écriture directe

-- Clé d'opération : UUID obligatoire. Renvoie le résultat déjà enregistré pour cette clé (rejeu), ou NULL.
create or replace function public._op_replay(p jsonb, p_kind text, p_hash text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; o public.stock_operations;
begin
  begin v_id := nullif(trim(p ->> 'operation_id'), '')::uuid;
  exception when others then raise exception 'Identifiant d''opération invalide.'; end;
  if v_id is null then
    raise exception 'Identifiant d''opération manquant : recharge la page (Ctrl+F5) pour utiliser la dernière version du site.';
  end if;
  -- Deux envois simultanés de la même opération passent l'un après l'autre.
  perform pg_advisory_xact_lock(hashtextextended('op/' || v_id::text, 0));
  select * into o from public.stock_operations where id = v_id;
  if not found then
    perform set_config('registre.op_id', v_id::text, true);
    return null;
  end if;
  if o.kind <> p_kind or o.request_hash <> p_hash or o.actor_id is distinct from auth.uid() then
    raise exception 'Cet identifiant d''opération a déjà servi pour une autre opération.';
  end if;
  return o.result || jsonb_build_object('replayed', true);
end $$;

create or replace function public._op_save(p jsonb, p_kind text, p_hash text, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into public.stock_operations (id, kind, actor_id, request_hash, result)
  values ((p ->> 'operation_id')::uuid, p_kind, auth.uid(), p_hash, p_result);
  return p_result || jsonb_build_object('replayed', false, 'operation_id', p ->> 'operation_id');
end $$;

-- Empreinte de la demande (sans les champs de confirmation), pour refuser une clé réutilisée pour autre chose.
create or replace function public._op_hash(p jsonb) returns text
language sql immutable as $$
  select md5((p - 'operation_id' - 'dry_run' - 'expected_before' - 'confirm_similar')::text)
$$;

-- Opérations récentes qui ressemblent à celle-ci (même stock, même sens) : alerte de doublon potentiel.
-- Ne bloque rien : un dépôt réellement distinct reste possible.
create or replace function public._similar_moves(p_owner uuid, p_loc uuid, p_res uuid, p_q text, p_unit text, p_delta numeric)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'at', m.at, 'delta', m.delta, 'kind', m.kind, 'mode', m.mode,
           'source', m.source, 'scan', m.scan_id is not null, 'same_quantity', m.delta = p_delta,
           'unclassified', m.kind in ('increase', 'decrease')) order by m.at desc), '[]'::jsonb)
  from (select * from public.movements m
        where m.owner_id = p_owner and m.location_id = p_loc and m.resource_id = p_res
          and m.quality_key = p_q and m.unit = p_unit and m.undone_at is null and m.reverses_id is null
          and sign(m.delta) = sign(p_delta) and m.kind <> 'initial'
          and m.at > now() - interval '7 days'
          and (m.delta = p_delta or m.kind in ('increase', 'decrease'))
        order by m.at desc limit 5) m
$$;

-- ---------- 5. Mouvement manuel : dépôt, retrait, correction ----------
-- p = { operation_id (uuid, obligatoire sauf aperçu), dry_run?, location, resource_id, quality_key, unit,
--       mode: 'add'|'remove'|'set', quantity, kind?, note?, owner_id?, expected_before? }
-- Le retrait porte uniquement sur la ligne exacte (membre, lieu, minerai, qualité, unité) : jamais une autre qualité.
create or replace function public.adjust_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_loc uuid; v_res uuid; v_q text; v_unit text; v_mode text; v_qty numeric; v_note text;
        v_cur numeric; v_new numeric; v_kind text; v_dry boolean := coalesce((p ->> 'dry_run')::boolean, false);
        v_hash text := public._op_hash(p); v_prev jsonb; v_ch jsonb; v_name text; v_exp numeric;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_owner := public._stock_owner(nullif(p ->> 'owner_id', '')::uuid);
  v_loc := public.ensure_location(p ->> 'location');
  v_res := nullif(p ->> 'resource_id', '')::uuid;
  select name into v_name from public.resources where id = v_res;
  if v_name is null then raise exception 'Ressource introuvable.'; end if;
  v_q := public._qkey(p ->> 'quality_key');
  v_unit := public._unit(p ->> 'unit');
  v_mode := p ->> 'mode';
  if v_mode is null or v_mode not in ('add', 'remove', 'set') then raise exception 'Mode invalide.'; end if;
  v_qty := public._qty(p, 'quantity', v_mode = 'set');
  v_note := left(coalesce(trim(p ->> 'note'), ''), 300);
  if (v_mode = 'set' or v_owner <> auth.uid()) and v_note = '' then
    raise exception 'Indique le motif de la correction.';
  end if;
  if v_mode = 'add' then v_kind := coalesce(nullif(p ->> 'kind', ''), 'deposit');
  elsif v_mode = 'remove' then v_kind := coalesce(nullif(p ->> 'kind', ''), 'withdrawal');
  else v_kind := 'correction';
  end if;
  if public.kind_sign(v_kind) is null then raise exception 'Nature de mouvement inconnue : %', v_kind; end if;
  if v_mode <> 'set' and public.kind_sign(v_kind) <> (case when v_mode = 'add' then 1 else -1 end) then
    raise exception 'Cette nature ne correspond pas au sens du mouvement.';
  end if;
  if v_kind in ('transfer_in', 'transfer_out') and v_note = '' then
    raise exception 'Pour un transfert entre deux lieux ou deux membres, utilise « Transférer » ; pour un transfert hors de l''organisation, indique une note.';
  end if;
  -- Opération déjà enregistrée (double clic, nouvelle tentative réseau) : résultat d'origine, rien n'est réappliqué.
  if not v_dry then
    v_prev := public._op_replay(p, 'adjust', v_hash);
    if v_prev is not null then return v_prev; end if;
  end if;

  if not v_dry then perform pg_advisory_xact_lock(hashtextextended(v_owner::text || '/' || v_loc::text, 0)); end if;
  select quantity into v_cur from public.user_stocks
    where user_id = v_owner and location_id = v_loc and resource_id = v_res and quality_key = v_q and unit = v_unit;
  v_cur := coalesce(v_cur, 0);
  -- L'aperçu affichait une autre quantité : quelqu'un a modifié ce stock entre-temps.
  if nullif(p ->> 'expected_before', '') is not null then
    v_exp := (p ->> 'expected_before')::numeric;
    if v_exp <> v_cur then
      raise exception 'STATE_CHANGED: ce stock vaut maintenant % (et non %). Vérifie l''aperçu avant de confirmer.', v_cur, v_exp;
    end if;
  end if;
  if v_mode = 'add' then v_new := v_cur + v_qty;
  elsif v_mode = 'remove' then
    if v_cur = 0 then
      raise exception 'Aucun stock de % (%, %) à ce lieu : choisis un lot existant.', v_name,
        case when v_q = '-' then 'qualité inconnue' else 'Q' || v_q end, case when v_unit = '' then 'objets' else v_unit end;
    end if;
    if v_qty > v_cur then raise exception 'Stock insuffisant : % disponible(s).', v_cur; end if;
    v_new := v_cur - v_qty;
  else v_new := v_qty;
  end if;

  if v_dry then
    return jsonb_build_object('dry_run', true, 'owner_id', v_owner, 'location_id', v_loc, 'resource_id', v_res, 'name', v_name,
      'quality_key', v_q, 'unit', v_unit, 'kind', v_kind, 'before', v_cur, 'after', v_new, 'delta', v_new - v_cur,
      'similar', case when v_new <> v_cur then public._similar_moves(v_owner, v_loc, v_res, v_q, v_unit, v_new - v_cur) else '[]'::jsonb end);
  end if;
  v_ch := public._write_stock(v_owner, v_loc, v_res, v_q, v_unit, v_new, v_kind,
                              case when v_mode = 'set' then 'correction' else 'stock' end, v_note, null);
  v_ch := coalesce(v_ch, jsonb_build_object('resource_id', v_res, 'name', v_name, 'quality_key', v_q, 'unit', v_unit,
                                            'before', v_cur, 'after', v_new, 'delta', 0, 'kind', v_kind, 'unchanged', true));
  return public._op_save(p, 'adjust', v_hash, v_ch || jsonb_build_object('movement_id',
    (select max(id) from public.movements where operation_id = (p ->> 'operation_id')::uuid)));
end $$;

-- ---------- 6. Transfert : débit et crédit atomiques ----------
-- p = { operation_id, dry_run?, from_owner?, from_location, to_owner?, to_location, resource_id, quality_key, unit,
--       quantity, note?, expected_before? }
-- La ressource, la qualité, l'unité et la quantité sont conservées à l'identique : le stock global ne change pas.
create or replace function public.transfer_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_from uuid; v_to uuid; v_floc uuid; v_tloc uuid; v_res uuid; v_q text; v_unit text; v_qty numeric; v_note text;
        v_scur numeric; v_dcur numeric; v_name text; v_tid uuid; v_out jsonb; v_in jsonb; v_res_json jsonb; a text; b text;
        v_dry boolean := coalesce((p ->> 'dry_run')::boolean, false); v_hash text := public._op_hash(p); v_prev jsonb;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_from := public._stock_owner(nullif(p ->> 'from_owner', '')::uuid);
  v_to := coalesce(nullif(p ->> 'to_owner', '')::uuid, v_from);
  -- Destinataire : un membre validé de la même organisation que le propriétaire du stock source.
  if v_to <> v_from and not exists (
       select 1 from public.profiles d, public.profiles s
       where d.id = v_to and s.id = v_from and d.role in ('member', 'admin') and d.org_id is not null and d.org_id = s.org_id) then
    raise exception 'Le destinataire doit être un membre validé de la même organisation.';
  end if;
  v_floc := public.ensure_location(p ->> 'from_location');
  v_tloc := public.ensure_location(p ->> 'to_location');
  if v_from = v_to and v_floc = v_tloc then raise exception 'La source et la destination sont identiques.'; end if;
  v_res := nullif(p ->> 'resource_id', '')::uuid;
  select name into v_name from public.resources where id = v_res;
  if v_name is null then raise exception 'Ressource introuvable.'; end if;
  v_q := public._qkey(p ->> 'quality_key');
  v_unit := public._unit(p ->> 'unit');
  v_qty := public._qty(p, 'quantity');
  v_note := left(coalesce(trim(p ->> 'note'), ''), 300);
  if not v_dry then
    v_prev := public._op_replay(p, 'transfer', v_hash);
    if v_prev is not null then return v_prev; end if;
  end if;

  if not v_dry then
    -- Verrous des deux inventaires, toujours dans le même ordre (pas d'interblocage).
    a := v_from::text || '/' || v_floc::text; b := v_to::text || '/' || v_tloc::text;
    perform pg_advisory_xact_lock(hashtextextended(least(a, b), 0));
    if a <> b then perform pg_advisory_xact_lock(hashtextextended(greatest(a, b), 0)); end if;
  end if;
  select quantity into v_scur from public.user_stocks
    where user_id = v_from and location_id = v_floc and resource_id = v_res and quality_key = v_q and unit = v_unit;
  v_scur := coalesce(v_scur, 0);
  if nullif(p ->> 'expected_before', '') is not null and (p ->> 'expected_before')::numeric <> v_scur then
    raise exception 'STATE_CHANGED: le stock source vaut maintenant % (et non %). Vérifie l''aperçu avant de confirmer.',
      v_scur, (p ->> 'expected_before')::numeric;
  end if;
  if v_scur = 0 then raise exception 'Aucun stock de ce lot à transférer depuis ce lieu.'; end if;
  if v_qty > v_scur then raise exception 'Stock insuffisant : % disponible(s).', v_scur; end if;
  select quantity into v_dcur from public.user_stocks
    where user_id = v_to and location_id = v_tloc and resource_id = v_res and quality_key = v_q and unit = v_unit;
  v_dcur := coalesce(v_dcur, 0);

  if v_dry then
    return jsonb_build_object('dry_run', true, 'name', v_name, 'quality_key', v_q, 'unit', v_unit, 'quantity', v_qty,
      'from', jsonb_build_object('owner_id', v_from, 'location_id', v_floc, 'before', v_scur, 'after', v_scur - v_qty),
      'to', jsonb_build_object('owner_id', v_to, 'location_id', v_tloc, 'before', v_dcur, 'after', v_dcur + v_qty));
  end if;

  v_tid := gen_random_uuid();
  perform set_config('registre.transfer_id', v_tid::text, true);
  v_out := public._write_stock(v_from, v_floc, v_res, v_q, v_unit, v_scur - v_qty, 'transfer_out', 'transfer', v_note, null);
  v_in := public._write_stock(v_to, v_tloc, v_res, v_q, v_unit, v_dcur + v_qty, 'transfer_in', 'transfer', v_note, null);
  perform set_config('registre.transfer_id', '', true);
  if v_out is null or v_in is null or (v_out ->> 'delta')::numeric <> -v_qty or (v_in ->> 'delta')::numeric <> v_qty then
    raise exception 'Transfert incohérent : rien n''a été enregistré.';
  end if;
  v_res_json := jsonb_build_object('transfer_id', v_tid, 'name', v_name, 'quality_key', v_q, 'unit', v_unit, 'quantity', v_qty,
    'from', v_out || jsonb_build_object('owner_id', v_from, 'location_id', v_floc),
    'to', v_in || jsonb_build_object('owner_id', v_to, 'location_id', v_tloc));
  return public._op_save(p, 'transfer', v_hash, v_res_json);
end $$;

-- ---------- 7. Annulation par mouvement compensatoire ----------
-- p = { operation_id, movement_id, note (obligatoire) }
-- Applique l'écart inverse sur le stock ACTUEL (les mouvements plus récents sont conservés), garde la même nature
-- (une production annulée disparaît des statistiques) et relie les deux mouvements. Rien n'est effacé.
-- Un transfert est annulé en entier (ses deux mouvements). Un relevé par capture « Mettre à jour » ne s'annule pas :
-- on corrige la quantité (motif obligatoire) ou on refait un relevé.
create or replace function public.reverse_movement(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m public.movements; legs public.movements[]; l public.movements; v_cur numeric; v_ch jsonb; v_out jsonb := '[]'::jsonb;
        v_note text := left(coalesce(trim(p ->> 'note'), ''), 300); v_hash text := public._op_hash(p); v_prev jsonb;
        k text; keys text[] := '{}'; v_new_id bigint;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_prev := public._op_replay(p, 'reverse', v_hash);
  if v_prev is not null then return v_prev; end if;
  if v_note = '' then raise exception 'Indique le motif de l''annulation.'; end if;
  select * into m from public.movements where id = nullif(p ->> 'movement_id', '')::bigint;
  if not found or m.owner_id is null then raise exception 'Mouvement introuvable.'; end if;
  if m.transfer_id is not null then
    select array_agg(x order by x.id) into legs from public.movements x where x.transfer_id = m.transfer_id;
  else
    legs := array[m];
  end if;
  -- Droits et contrôles sur chaque mouvement concerné, puis verrous dans un ordre fixe.
  foreach l in array legs loop
    perform public._stock_owner(case when l.owner_id = auth.uid() then null else l.owner_id end);
    if l.undone_at is not null or l.reversed_by_id is not null then raise exception 'Ce mouvement a déjà été annulé.'; end if;
    if l.reverses_id is not null then raise exception 'Une annulation ne s''annule pas : déclare un nouveau mouvement.'; end if;
    if l.mode not in ('stock', 'correction', 'transfer') or l.kind in ('initial', 'legacy_attribution') or coalesce(l.delta, 0) = 0 then
      raise exception 'Ce mouvement ne peut pas être annulé : corrige plutôt la quantité (motif obligatoire) ou refais un relevé.';
    end if;
    keys := keys || (l.owner_id::text || '/' || l.location_id::text);
  end loop;
  for k in select distinct x from unnest(keys) x order by 1 loop
    perform pg_advisory_xact_lock(hashtextextended(k, 0));
  end loop;
  if legs[1].transfer_id is not null then perform set_config('registre.transfer_id', gen_random_uuid()::text, true); end if;
  foreach l in array legs loop
    select * into l from public.movements where id = l.id for update;
    if l.undone_at is not null then raise exception 'Ce mouvement a déjà été annulé.'; end if;
    select quantity into v_cur from public.user_stocks
      where user_id = l.owner_id and location_id = l.location_id and resource_id = l.resource_id
        and quality_key = l.quality_key and unit = l.unit;
    v_cur := coalesce(v_cur, 0);
    if v_cur - l.delta < 0 then
      raise exception 'Annulation impossible : il ne reste que % de ce lot (le mouvement avait ajouté %).', v_cur, l.delta;
    end if;
    v_ch := public._write_stock(l.owner_id, l.location_id, l.resource_id, l.quality_key, l.unit, v_cur - l.delta,
                                'correction', 'reversal', 'Annulation : ' || v_note, null);
    select max(id) into v_new_id from public.movements where operation_id = (p ->> 'operation_id')::uuid;
    -- Même nature que l'original (écart opposé) : les statistiques se compensent exactement.
    update public.movements set kind = l.kind, reverses_id = l.id where id = v_new_id;
    update public.movements set undone_at = now(), undone_by = auth.uid(), reversed_by_id = v_new_id where id = l.id;
    v_out := v_out || jsonb_build_array(v_ch || jsonb_build_object('movement_id', v_new_id, 'reverses_id', l.id));
  end loop;
  perform set_config('registre.transfer_id', '', true);
  return public._op_save(p, 'reverse', v_hash, jsonb_build_object('reversals', v_out));
end $$;

-- Classer après coup : seulement une hausse ou une baisse ordinaire (pas une annulation, un mouvement annulé
-- ni un transfert interne, dont la nature doit rester cohérente avec son mouvement lié).
create or replace function public.classify_movement(p_id bigint, p_kind text) returns void
language plpgsql security definer set search_path = public as $$
declare m public.movements;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  select * into m from public.movements where id = p_id for update;
  if not found or m.owner_id is null then raise exception 'Mouvement introuvable.'; end if;
  if m.owner_id <> auth.uid() then perform public._stock_owner(m.owner_id); end if;
  if public.kind_sign(m.kind) = 0 then raise exception 'Ce mouvement n''est pas à classer.'; end if;
  if m.reverses_id is not null or m.undone_at is not null or m.transfer_id is not null then
    raise exception 'Ce mouvement est lié à une annulation ou à un transfert : sa nature ne peut pas changer.';
  end if;
  if public.kind_sign(p_kind) is null or public.kind_sign(p_kind) <> sign(m.delta) then
    raise exception 'Cette nature ne correspond pas au sens du mouvement.';
  end if;
  update public.movements set kind = p_kind, classified_by = auth.uid(), classified_at = now() where id = p_id;
end $$;

-- ---------- 8. Captures : unités normalisées, clé liée au contenu, ajout en double refusé ----------
alter table public.inventory_scans add column if not exists request_hash text;

create or replace function public._scan_hash(p jsonb) returns text
language sql immutable as $$
  select md5(jsonb_build_object('owner', coalesce(p ->> 'owner_id', ''), 'location', public.place_slug(p ->> 'location'),
    'mode', coalesce(p ->> 'mode', ''), 'coverage', coalesce(p ->> 'coverage', ''), 'items', coalesce(p -> 'items', '[]'::jsonb))::text)
$$;

-- p = { idempotency_key, location, owner_id?, terminal_type, observed_at, coverage, mode?: 'add', fingerprints, page_count,
--       note, allow_stale?, allow_duplicate?, state_token?, items: [...], reasons: {...}, absent_reason? }
create or replace function public.apply_scan(p jsonb, p_dry_run boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid; v_loc uuid; v_obs timestamptz; v_cov text; v_term text; v_key text; v_last timestamptz;
  v_stale boolean; v_old public.inventory_scans; v_token text; v_scan bigint; v_dup boolean; v_add boolean;
  it record; v_prev numeric; v_exists boolean; v_kind text; v_k text; v_ch jsonb; v_hash text := public._scan_hash(p);
  v_changes jsonb := '[]'::jsonb; v_seen text[] := '{}'; v_same integer := 0; v_result jsonb; v_name text;
  v_similar jsonb := '[]'::jsonb; v_s jsonb;
begin
  if not public.is_member() then raise exception 'Accès refusé : compte non validé.'; end if;
  v_owner := public._stock_owner(nullif(p ->> 'owner_id', '')::uuid);
  v_loc := public.ensure_location(p ->> 'location');
  v_key := nullif(trim(p ->> 'idempotency_key'), '');
  if v_key is null and not p_dry_run then raise exception 'Clé d''idempotence manquante.'; end if;
  v_obs := coalesce(nullif(p ->> 'observed_at', '')::timestamptz, now());
  if v_obs > now() + interval '5 minutes' then raise exception 'La date de la capture est dans le futur.'; end if;
  v_add := coalesce(p ->> 'mode', '') = 'add';
  v_cov := coalesce(p ->> 'coverage', 'partial');
  if v_add then v_cov := 'partial'; end if;   -- mode_ajout : rien d'autre ne change
  if v_cov not in ('partial', 'complete') then raise exception 'Couverture invalide.'; end if;
  v_term := coalesce(nullif(p ->> 'terminal_type', ''), 'inconnu');
  if v_term not in ('inventaire', 'ascenseur_fret', 'asop', 'raffinerie', 'autre', 'inconnu') then v_term := 'inconnu'; end if;

  -- Un seul enregistrement à la fois pour un même joueur dans un même lieu.
  if not p_dry_run then
    perform pg_advisory_xact_lock(hashtextextended(v_owner::text || '/' || v_loc::text, 0));
  end if;

  -- Même opération déjà enregistrée : on renvoie le résultat d'origine sans rien réappliquer.
  if v_key is not null then
    select * into v_old from public.inventory_scans where idempotency_key = v_key;
    if found then
      if v_old.user_id <> v_owner or v_old.location_id <> v_loc
         or (v_old.request_hash is not null and v_old.request_hash <> v_hash) then
        raise exception 'Clé d''idempotence déjà utilisée pour un autre relevé : relance la comparaison.';
      end if;
      return coalesce(v_old.result, '{}'::jsonb) || jsonb_build_object('replayed', true, 'scan_id', v_old.id);
    end if;
  end if;

  -- Capture plus ancienne que le dernier état connu de cet inventaire ?
  select greatest(
    (select max(observed_at) from public.inventory_scans
      where user_id = v_owner and location_id = v_loc and validation_status = 'applied'),
    (select max(at) from public.movements
      where owner_id = v_owner and location_id = v_loc and mode <> 'scan'))
  into v_last;
  v_stale := v_last is not null and v_obs < v_last and not v_add;
  if v_stale and not p_dry_run and not coalesce((p ->> 'allow_stale')::boolean, false) then
    raise exception 'STALE: cette capture est plus ancienne que le dernier état enregistré pour ce lieu (%). Confirme pour l''appliquer quand même.',
      to_char(v_last at time zone 'Europe/Paris', 'DD/MM/YYYY HH24:MI');
  end if;

  -- L'inventaire a-t-il changé depuis l'aperçu ?
  v_token := public._stock_token(v_owner, v_loc);
  if not p_dry_run and nullif(p ->> 'state_token', '') is not null and p ->> 'state_token' <> v_token then
    raise exception 'STATE_CHANGED: l''inventaire de ce lieu a changé depuis l''aperçu. Relance l''aperçu avant d''enregistrer.';
  end if;

  select exists (select 1 from public.inventory_scans s
    where s.user_id = v_owner and s.location_id = v_loc and s.validation_status = 'applied'
      and s.image_fingerprint && array(select jsonb_array_elements_text(coalesce(p -> 'fingerprints', '[]'::jsonb))))
  into v_dup;
  -- En mode ajout, enregistrer deux fois la même image ajouterait deux fois les mêmes lots : confirmation explicite.
  if v_add and v_dup and not p_dry_run and not coalesce((p ->> 'allow_duplicate')::boolean, false) then
    raise exception 'DUPLICATE: cette capture a déjà été ajoutée au stock de ce lieu. Confirme seulement s''il s''agit d''un nouveau lot.';
  end if;

  if not p_dry_run then
    insert into public.inventory_scans (user_id, author_id, location_id, terminal_type, observed_at, coverage_status,
                                        validation_status, idempotency_key, image_fingerprint, page_count, note, request_hash)
    values (v_owner, auth.uid(), v_loc, v_term, v_obs, v_cov, 'applied', v_key,
            array(select jsonb_array_elements_text(coalesce(p -> 'fingerprints', '[]'::jsonb))),
            greatest(1, coalesce((p ->> 'page_count')::int, 1)), left(coalesce(p ->> 'note', ''), 300), v_hash)
    returning id into v_scan;

    insert into public.scan_items (scan_id, resource_id, quality_key, quantity, unit, confidence, image_reference, validation_status)
    select v_scan, nullif(x ->> 'resource_id', '')::uuid, public._qkey(x ->> 'quality_key'), (x ->> 'quantity')::numeric,
           public._unit(x ->> 'unit'), nullif(x ->> 'confidence', '')::numeric,
           case when length(x ->> 'image_reference') <= 20000 then x ->> 'image_reference' end,
           coalesce(nullif(x ->> 'validation_status', ''), 'accepted')
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x;
  end if;

  -- Lignes observées, regroupées par ressource + qualité + unité (plusieurs cases d'un même lot s'additionnent).
  for it in
    select (x ->> 'resource_id')::uuid as res, public._qkey(x ->> 'quality_key') as q,
           public._unit(x ->> 'unit') as unit, sum((x ->> 'quantity')::numeric) as qty
    from jsonb_array_elements(coalesce(p -> 'items', '[]'::jsonb)) x
    where coalesce(x ->> 'validation_status', 'accepted') <> 'rejected'
    group by 1, 2, 3
  loop
    if it.res is null then raise exception 'Chaque ligne doit être rattachée à une ressource du catalogue.'; end if;
    if it.qty is null or it.qty < 0 or it.qty <> round(it.qty, 3) then raise exception 'Quantité invalide.'; end if;
    v_k := it.res || '|' || it.q || '|' || it.unit;
    if v_add then
      if it.qty = 0 then raise exception 'Quantité invalide.'; end if;
      if p_dry_run then
        v_s := public._similar_moves(v_owner, v_loc, it.res, it.q, it.unit, it.qty);
        if jsonb_array_length(v_s) > 0 then v_similar := v_similar || jsonb_build_array(jsonb_build_object('key', v_k, 'moves', v_s)); end if;
      end if;
      it.qty := it.qty + coalesce((select s.quantity from public.user_stocks s
        where s.user_id = v_owner and s.location_id = v_loc and s.resource_id = it.res and s.quality_key = it.q and s.unit = it.unit), 0);
    end if;
    v_seen := v_seen || v_k;
    if p_dry_run then
      select quantity into v_prev from public.user_stocks
        where user_id = v_owner and location_id = v_loc and resource_id = it.res and quality_key = it.q and unit = it.unit;
      v_exists := found;
      select name into v_name from public.resources where id = it.res;
      if v_name is null then raise exception 'Ressource introuvable.'; end if;
      if (v_exists and v_prev = it.qty) or (not v_exists and it.qty = 0) then v_same := v_same + 1; continue; end if;
      v_kind := public._classify(v_exists, it.qty - coalesce(v_prev, 0), p -> 'reasons' ->> v_k, case when v_add then 'stock' else 'scan' end);
      v_ch := jsonb_build_object('resource_id', it.res, 'name', v_name, 'quality_key', it.q, 'unit', it.unit,
        'before', coalesce(v_prev, 0), 'after', it.qty, 'delta', it.qty - coalesce(v_prev, 0), 'kind', v_kind,
        'initial', v_kind = 'initial');
    else
      v_ch := public._write_stock(v_owner, v_loc, it.res, it.q, it.unit, it.qty, p -> 'reasons' ->> v_k,
                                  case when v_add then 'stock' else 'scan' end, left(coalesce(p ->> 'note', ''), 300), v_scan);
      if v_ch is null then v_same := v_same + 1; continue; end if;
    end if;
    v_changes := v_changes || jsonb_build_array(v_ch);
  end loop;

  -- Inventaire complet validé : ce qui n'apparaît plus est à 0. Capture partielle : on ne touche à rien d'autre.
  if v_cov = 'complete' then
    for it in
      select s.resource_id as res, s.quality_key as q, s.unit, s.quantity as qty, r.name
      from public.user_stocks s join public.resources r on r.id = s.resource_id
      where s.user_id = v_owner and s.location_id = v_loc and s.quantity > 0
        and not ((s.resource_id || '|' || s.quality_key || '|' || s.unit) = any (v_seen))
    loop
      v_k := it.res || '|' || it.q || '|' || it.unit;
      if p_dry_run then
        v_kind := public._classify(true, -it.qty, coalesce(p -> 'reasons' ->> v_k, p ->> 'absent_reason'), 'scan');
        v_ch := jsonb_build_object('resource_id', it.res, 'name', it.name, 'quality_key', it.q, 'unit', it.unit,
          'before', it.qty, 'after', 0, 'delta', -it.qty, 'kind', v_kind, 'initial', false);
      else
        v_ch := public._write_stock(v_owner, v_loc, it.res, it.q, it.unit, 0,
                  coalesce(p -> 'reasons' ->> v_k, p ->> 'absent_reason'), 'scan', left(coalesce(p ->> 'note', ''), 300), v_scan);
      end if;
      v_changes := v_changes || jsonb_build_array(v_ch || jsonb_build_object('absent', true));
    end loop;
  end if;

  v_result := jsonb_build_object(
    'scan_id', v_scan, 'owner_id', v_owner, 'location_id', v_loc, 'coverage', v_cov, 'terminal_type', v_term,
    'stale', v_stale, 'last_state_at', v_last, 'duplicate_images', coalesce(v_dup, false), 'similar', v_similar,
    'state_token', case when p_dry_run then v_token else public._stock_token(v_owner, v_loc) end,
    'unchanged', v_same, 'changes', v_changes, 'dry_run', p_dry_run);
  if not p_dry_run then update public.inventory_scans set result = v_result where id = v_scan; end if;
  return v_result;
end $$;

-- ---------- 9. Réconciliation (lecture seule) ----------
-- Pour chaque ligne de stock personnel : quantité enregistrée et somme des écarts de ses mouvements.
-- Un écart signale une ligne à vérifier (ex. stock modifié hors des fonctions prévues). Rien n'est corrigé ici.
-- Administrateur : son organisation ; propriétaire du site : toutes. Renvoie aussi les unités non canoniques.
create or replace function public.stock_reconciliation() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_all boolean := public.is_owner(); v_org uuid := public.my_org(); v jsonb; u jsonb;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs.'; end if;
  with keys as (
    select s.user_id, s.location_id, s.resource_id, s.quality_key, s.unit, s.quantity from public.user_stocks s
    union
    select m.owner_id, m.location_id, m.resource_id, m.quality_key, m.unit, null from public.movements m
    where m.owner_id is not null and m.location_id is not null and m.resource_id is not null and m.quality_key is not null
  ), k as (
    select user_id, location_id, resource_id, quality_key, unit, max(quantity) as quantity from keys group by 1, 2, 3, 4, 5
  ), rows as (
    select k.*, coalesce(k.quantity, 0) as stock,
      coalesce((select sum(m.delta) from public.movements m
        where m.owner_id = k.user_id and m.location_id = k.location_id and m.resource_id = k.resource_id
          and m.quality_key = k.quality_key and m.unit = k.unit), 0) as from_moves
    from k join public.profiles pr on pr.id = k.user_id
    where v_all or pr.org_id = v_org
  )
  select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'location_id', location_id, 'resource_id', resource_id,
           'quality_key', quality_key, 'unit', unit, 'stock', stock, 'from_movements', from_moves, 'gap', stock - from_moves)), '[]'::jsonb)
  into v from rows where stock <> from_moves;
  select coalesce(jsonb_agg(distinct s.unit), '[]'::jsonb) into u
  from public.user_stocks s join public.profiles pr on pr.id = s.user_id
  where (v_all or pr.org_id = v_org) and s.unit <> public._unit(s.unit);
  return jsonb_build_object('checked_at', now(), 'mismatches', v, 'non_canonical_units', u);
end $$;

-- ---------- 10. Droits ----------
revoke execute on function public._unit(text) from public, anon;
revoke execute on function public._qty(jsonb, text, boolean) from public, anon, authenticated;
revoke execute on function public._op_replay(jsonb, text, text) from public, anon, authenticated;
revoke execute on function public._op_save(jsonb, text, text, jsonb) from public, anon, authenticated;
revoke execute on function public._op_hash(jsonb) from public, anon, authenticated;
revoke execute on function public._scan_hash(jsonb) from public, anon, authenticated;
revoke execute on function public._similar_moves(uuid, uuid, uuid, text, text, numeric) from public, anon, authenticated;
revoke execute on function public._movement_tags() from public, anon, authenticated;
revoke execute on function public.adjust_stock(jsonb) from public, anon;
revoke execute on function public.transfer_stock(jsonb) from public, anon;
revoke execute on function public.reverse_movement(jsonb) from public, anon;
revoke execute on function public.classify_movement(bigint, text) from public, anon;
revoke execute on function public.apply_scan(jsonb, boolean) from public, anon;
revoke execute on function public.stock_reconciliation() from public, anon;
grant execute on function public._unit(text) to authenticated;
grant execute on function public.adjust_stock(jsonb) to authenticated;
grant execute on function public.transfer_stock(jsonb) to authenticated;
grant execute on function public.reverse_movement(jsonb) to authenticated;
grant execute on function public.classify_movement(bigint, text) to authenticated;
grant execute on function public.apply_scan(jsonb, boolean) to authenticated;
grant execute on function public.stock_reconciliation() to authenticated;
