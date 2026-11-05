// Base Postgres en mémoire (PGlite) qui imite ce que fournit Supabase :
// schéma auth, auth.uid() lu dans le jeton simulé, rôles anon/authenticated, publication temps réel.
// Puis on y joue schema.sql et toutes les migrations, dans l'ordre, comme en production.
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase");

const SUPABASE_STUB = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public, auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
do $$ begin create publication supabase_realtime; exception when others then null; end $$;
`;

// pgcrypto n'existe pas dans PGlite ; gen_random_uuid() est natif depuis Postgres 13.
const sqlOf = f => readFileSync(f, "utf8").replace(/create extension if not exists pgcrypto;/i, "");

export function migrationFiles() {
  const dir = join(root, "migrations");
  return [join(root, "schema.sql"), ...readdirSync(dir).filter(f => f.endsWith(".sql")).sort().map(f => join(dir, f))];
}

// upTo : nom de fichier de migration (exclu) pour s'arrêter avant, ex. "006".
export async function freshDb({ upTo } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_STUB);
  for (const f of migrationFiles()) {
    if (upTo && f.includes(`${upTo}_`)) break;
    await db.exec(sqlOf(f));
  }
  // Comme Supabase : tous les droits de table sont accordés, seule la RLS protège les données.
  await db.exec(`grant all on all tables in schema public to anon, authenticated;`);
  return db;
}

export async function runRemaining(db, from) {
  let on = false;
  for (const f of migrationFiles()) {
    if (f.includes(`${from}_`)) on = true;
    if (on) await db.exec(sqlOf(f));
  }
  await db.exec(`grant all on all tables in schema public to anon, authenticated;`);
}

// Crée un compte (le premier devient admin via le trigger), puis fixe son rôle.
export async function addUser(db, pseudo, role = "member") {
  const id = randomUUID();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`,
    [id, `${pseudo}@test.local`, JSON.stringify({ pseudo })]);
  await db.query(`update public.profiles set role = $2 where id = $1`, [id, role]);
  return id;
}

// Exécute fn en tant qu'utilisateur connecté (rôle authenticated, RLS active), dans une transaction.
export async function as(db, userId, sql, params = []) {
  return db.transaction(async tx => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId || ""]);
    await tx.query(`set local role authenticated`);
    return tx.query(sql, params);
  });
}

export async function rpc(db, userId, fn, args) {
  const res = await as(db, userId, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args);
  return res.rows[0].r;
}
