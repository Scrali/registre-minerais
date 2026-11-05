-- Registre des minerais : demandes des membres (« j'ai besoin de 200 SCU de Quantanium Q700+ à Levski »).
-- À exécuter APRÈS 008, dans Supabase > SQL Editor > New query, puis Run. Peut être relancé sans risque.
-- Ajoute seulement une table et des fonctions : aucune donnée existante n'est modifiée ni supprimée.
--
-- * Une demande appartient à l'organisation de son auteur : les autres organisations ne la voient pas.
-- * Statuts : open (ouverte) → in_progress (un membre s'en occupe) → done (livrée) ; ou cancelled (annulée).
-- * L'auteur modifie ou annule sa demande ; n'importe quel membre de l'organisation peut la prendre en charge ;
--   l'auteur, celui qui s'en occupe ou un administrateur la marquent livrée. Rien n'est jamais supprimé.
-- * Les clients n'écrivent jamais directement dans la table : tout passe par les fonctions ci-dessous.

create table if not exists public.requests (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete restrict,
  requester_id uuid not null references public.profiles (id) on delete restrict,
  resource_id uuid references public.resources (id) on delete set null,
  resource_name text not null check (length(trim(resource_name)) between 1 and 80),   -- copie du nom (reste lisible si la ressource disparaît)
  quantity numeric(16, 3) not null check (quantity > 0),
  unit text not null default '' check (length(unit) <= 20),
  min_quality integer check (min_quality between 0 and 1000),
  location text not null default '' check (length(location) <= 80),                 -- où livrer
  needed_by date,
  priority text not null default 'normal' check (priority in ('normal', 'urgent')),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  taken_by uuid references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists requests_org_idx on public.requests (org_id, status, created_at desc);

alter table public.requests enable row level security;
drop policy if exists "demandes lisibles" on public.requests;
create policy "demandes lisibles" on public.requests for select to authenticated
  using (public.is_member() and (org_id = public.my_org() or public.is_owner()));
-- Pas de politique insert / update / delete : écriture uniquement par les fonctions.

-- Valeurs d'une demande à partir du JSON envoyé par le site (création ou modification).
create or replace function public._request_fields(p jsonb, out r_id uuid, out r_name text, out qty numeric,
  out u text, out q integer, out loc text, out by_date date, out prio text, out n text)
language plpgsql stable security definer set search_path = public as $$
begin
  r_id := nullif(p->>'resource_id', '')::uuid;
  if r_id is not null then
    select name into r_name from public.resources where id = r_id;
    if r_name is null then raise exception 'Ressource introuvable.'; end if;
  else
    r_name := trim(coalesce(p->>'resource_name', ''));
    if r_name = '' then raise exception 'Indique la ressource demandée.'; end if;
  end if;
  qty := nullif(p->>'quantity', '')::numeric;
  if qty is null or qty <= 0 then raise exception 'Indique une quantité supérieure à zéro.'; end if;
  u := trim(coalesce(p->>'unit', ''));
  q := nullif(p->>'min_quality', '')::integer;
  if q is not null and (q < 0 or q > 1000) then raise exception 'La qualité minimale va de 0 à 1000.'; end if;
  loc := trim(coalesce(p->>'location', ''));
  by_date := nullif(p->>'needed_by', '')::date;
  prio := coalesce(nullif(p->>'priority', ''), 'normal');
  if prio not in ('normal', 'urgent') then raise exception 'Priorité inconnue.'; end if;
  n := trim(coalesce(p->>'note', ''));
end $$;

create or replace function public.create_request(p jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare f record; v bigint; o uuid := public.my_org();
begin
  if not public.is_member() or o is null then raise exception 'Compte non validé : rejoins une organisation d''abord.'; end if;
  select * into f from public._request_fields(p);
  insert into public.requests (org_id, requester_id, resource_id, resource_name, quantity, unit, min_quality, location, needed_by, priority, note)
  values (o, auth.uid(), f.r_id, f.r_name, f.qty, f.u, f.q, f.loc, f.by_date, f.prio, f.n)
  returning id into v;
  return v;
end $$;

-- L'auteur modifie sa demande tant qu'elle n'est pas livrée ni annulée.
create or replace function public.update_request(p_id bigint, p jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests; f record;
begin
  select * into r from public.requests where id = p_id for update;
  if r.id is null or not (r.org_id = public.my_org() or public.is_owner()) then raise exception 'Demande introuvable.'; end if;
  if r.requester_id <> auth.uid() then raise exception 'Seul l''auteur de la demande peut la modifier.'; end if;
  if r.status in ('done', 'cancelled') then raise exception 'Cette demande est close.'; end if;
  select * into f from public._request_fields(p);
  update public.requests set resource_id = f.r_id, resource_name = f.r_name, quantity = f.qty, unit = f.u, min_quality = f.q,
    location = f.loc, needed_by = f.by_date, priority = f.prio, note = f.n, updated_at = now()
  where id = p_id;
end $$;

-- Changement de statut :
--   in_progress  « Je m'en occupe » : tout membre de l'organisation, sur une demande ouverte
--   open         rendre la demande (celui qui s'en occupe, l'auteur ou un admin) ou la rouvrir (l'auteur ou un admin)
--   done         livrée : l'auteur, celui qui s'en occupe ou un admin
--   cancelled    annulée : l'auteur ou un admin
create or replace function public.set_request_status(p_id bigint, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.requests; me uuid := auth.uid(); mine boolean; adm boolean; taker boolean;
begin
  if not public.is_member() then raise exception 'Compte non validé.'; end if;
  select * into r from public.requests where id = p_id for update;
  if r.id is null or not (r.org_id = public.my_org() or public.is_owner()) then raise exception 'Demande introuvable.'; end if;
  mine := r.requester_id = me;
  taker := coalesce(r.taken_by = me, false);
  adm := public.is_owner() or (public.is_admin() and r.org_id = public.my_org());
  if p_status = 'in_progress' then
    if r.status <> 'open' then raise exception 'Cette demande n''est plus ouverte.'; end if;
    update public.requests set status = 'in_progress', taken_by = me, updated_at = now() where id = p_id;
  elsif p_status = 'open' then
    if r.status = 'in_progress' and not (taker or mine or adm) then
      raise exception 'Seul celui qui s''en occupe, l''auteur ou un administrateur peut la rendre.';
    elsif r.status in ('done', 'cancelled') and not (mine or adm) then
      raise exception 'Seul l''auteur ou un administrateur peut rouvrir la demande.';
    end if;
    update public.requests set status = 'open', taken_by = null, closed_at = null, updated_at = now() where id = p_id;
  elsif p_status = 'done' then
    if r.status in ('done', 'cancelled') then raise exception 'Cette demande est déjà close.'; end if;
    if not (mine or adm or taker) then
      raise exception 'Seul l''auteur, celui qui s''en occupe ou un administrateur peut la marquer livrée.';
    end if;
    update public.requests set status = 'done', taken_by = coalesce(taken_by, case when mine then null else me end),
      closed_at = now(), updated_at = now() where id = p_id;
  elsif p_status = 'cancelled' then
    if r.status in ('done', 'cancelled') then raise exception 'Cette demande est déjà close.'; end if;
    if not (mine or adm) then raise exception 'Seul l''auteur ou un administrateur peut annuler la demande.'; end if;
    update public.requests set status = 'cancelled', closed_at = now(), updated_at = now() where id = p_id;
  else
    raise exception 'Statut inconnu.';
  end if;
end $$;

revoke execute on function public._request_fields(jsonb) from public, anon, authenticated;
revoke execute on function public.create_request(jsonb) from public, anon;
revoke execute on function public.update_request(bigint, jsonb) from public, anon;
revoke execute on function public.set_request_status(bigint, text) from public, anon;
grant execute on function public.create_request(jsonb) to authenticated;
grant execute on function public.update_request(bigint, jsonb) to authenticated;
grant execute on function public.set_request_status(bigint, text) to authenticated;
grant select on public.requests to authenticated;

do $$ begin
  begin alter publication supabase_realtime add table public.requests; exception when duplicate_object then null; end;
end $$;
