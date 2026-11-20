/**
 * The database tables. This runs automatically when the server first connects,
 * and is safe to run again: it only creates what is missing.
 *
 * Row level security is switched on for every table with no rules, and the
 * public web roles' permissions are removed, which means only the server can
 * read or write them (Supabase would otherwise expose tables in "public" to
 * anyone holding the project's public key).
 */
export const SCHEMA = `
begin;
-- One server at a time, so two servers starting together cannot collide.
select pg_advisory_xact_lock(727001);

-- One row per account: the plan and how many searches were used.
-- Passwords are kept by Supabase Auth, not here.
create table if not exists profiles (
  user_id uuid primary key,
  email text not null,
  plan text not null default 'free' check (plan in ('free', 'premium')),
  searches_used integer not null default 0,
  upgrade_requested_at timestamptz,
  created_at timestamptz not null default now()
);

-- When a paid premium plan ends (null: it does not end, e.g. set by the owner).
alter table profiles add column if not exists premium_until timestamptz;

-- Card payments through Paymob. Card details are never stored: Paymob keeps them.
create table if not exists payments (
  id uuid primary key,
  user_id uuid not null,
  amount_cents integer not null,
  currency text not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  paymob_order_id bigint unique,
  paymob_transaction_id bigint unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Stores added by pasting a link into the search box.
create table if not exists added_stores (
  url text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

-- Every product of every store. A store's products are replaced as a whole:
-- each refresh writes a new "batch", and store_refresh says which batch is current.
create table if not exists products (
  id bigserial primary key,
  store_url text not null,
  batch text not null,
  name text not null,
  match_text text not null,
  price double precision,
  url text not null,
  image text
);
create index if not exists products_store_batch on products (store_url, batch);

-- When each store was last read, and which server is reading it now.
create table if not exists store_refresh (
  store_url text primary key,
  batch text,
  refreshed_at timestamptz,
  claimed_at timestamptz,
  product_count integer not null default 0,
  error text
);

-- Names and prices read from product pages of stores without a price list (Mazaya, Faces).
create table if not exists page_prices (
  url text primary key,
  name text,
  price double precision,
  currency text,
  image text,
  read_at timestamptz not null default now()
);

-- Amazon answers, kept so the same search is not paid for twice.
create table if not exists amazon_cache (
  key text primary key,
  items jsonb not null,
  fetched_at timestamptz not null default now()
);

-- Things limited per day across all servers (Amazon searches, newly added stores).
create table if not exists daily_counters (
  name text not null,
  day date not null,
  used integer not null,
  primary key (name, day)
);

alter table profiles enable row level security;
alter table added_stores enable row level security;
alter table products enable row level security;
alter table store_refresh enable row level security;
alter table page_prices enable row level security;
alter table amazon_cache enable row level security;
alter table daily_counters enable row level security;
alter table payments enable row level security;

-- Second lock on the same door: Supabase gives its public web roles (anon,
-- authenticated) full permissions on new tables, and only row level security
-- stood in their way. Take the permissions away too, for these tables and any
-- created later, so one mistaken rule can never expose them. The site's
-- server logs in as the database owner and is not affected. (Skipped on the
-- local database, which has no such roles.)
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon')
     and exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on table profiles, added_stores, products, store_refresh, page_prices,
      amazon_cache, daily_counters, payments from anon, authenticated;
    revoke all on sequence products_id_seq from anon, authenticated;
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
  end if;
end
$$;
commit;
`;
