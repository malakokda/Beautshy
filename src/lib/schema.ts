/**
 * The database tables. This runs automatically when the server first connects,
 * and is safe to run again: it only creates what is missing.
 *
 * Row level security is switched on for every table with no rules, which means
 * only the server can read or write them (Supabase would otherwise expose
 * tables in "public" to anyone holding the project's public key).
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
commit;
`;
