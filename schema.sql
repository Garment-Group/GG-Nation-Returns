-- ============================================================
-- Returns Portal — Supabase Schema v2
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Receipt flags
create table if not exists receipts_flags (
  id               uuid primary key default gen_random_uuid(),
  receiver_id      integer unique not null,
  reference_num    text,
  po_num           text,
  dash_status      text not null default 'Open',
  discrepancy_type text,   -- Damaged | Extra item | Missing item | Wrong item
  extra_sku        text,   -- for Extra item: the unexpected SKU received
  upc              text,   -- UPC of the item with issue
  item_desc        text,   -- description of the item with issue
  expected_qty     numeric,-- for Extra/Missing: what was expected
  received_qty     numeric,-- for Extra/Missing: what was actually received
  request_943      boolean default false,
  notes            text default '',
  notified_at      timestamptz,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists receipts_flags_updated_at on receipts_flags;
create trigger receipts_flags_updated_at
  before update on receipts_flags
  for each row execute function update_updated_at();

-- 2. Notification log
create table if not exists notification_log (
  id          uuid primary key default gen_random_uuid(),
  message     text not null,
  created_by  text,
  created_at  timestamptz default now()
);

-- 3. Contacts (admin only)
create table if not exists contacts (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text not null unique,
  role       text not null default 'Viewer',
  created_at timestamptz default now()
);

insert into contacts (name, email, role)
values ('Nation.LA Returns', 'returns@nation.la', 'Returns lead')
on conflict (email) do nothing;

-- ── RLS ──────────────────────────────────────────────────────
alter table receipts_flags   enable row level security;
alter table notification_log enable row level security;
alter table contacts         enable row level security;

-- All authenticated users can read/write receipts_flags and notification_log
create policy "auth_all" on receipts_flags
  for all to authenticated using (true) with check (true);

create policy "auth_all" on notification_log
  for all to authenticated using (true) with check (true);

-- Contacts table: admin only
-- Admin is identified by raw_user_meta_data->>'role' = 'admin'
create policy "admin_only" on contacts
  for all to authenticated
  using (auth.jwt() ->> 'role' = 'admin' OR (auth.jwt()->'user_metadata'->>'role') = 'admin')
  with check (auth.jwt() ->> 'role' = 'admin' OR (auth.jwt()->'user_metadata'->>'role') = 'admin');

-- ============================================================
-- Cache tables — add these via SQL Editor
-- ============================================================

-- Receiver cache — fast reads for dashboard
create table if not exists receivers_cache (
  receiver_id        integer primary key,
  transaction_num    integer,
  reference_num      text,
  po_num             text,
  receipt_advice_num text,
  arrival_date       timestamptz,
  creation_date      timestamptz,
  customer           text,
  tracking_num       text,
  on_hold            boolean default false,
  total_qty          numeric default 0,
  line_count         integer default 0,
  skus               text[] default '{}',
  cached_at          timestamptz default now(),
  updated_at         timestamptz default now()
);

-- Cache metadata
create table if not exists cache_meta (
  key        text primary key,
  value      text,
  updated_at timestamptz default now()
);

-- RLS — authenticated users can read cache
alter table receivers_cache enable row level security;
alter table cache_meta      enable row level security;

create policy "auth_read" on receivers_cache
  for select to authenticated using (true);

create policy "auth_read" on cache_meta
  for select to authenticated using (true);

-- Service role can write (edge function uses service role)
create policy "service_write" on receivers_cache
  for all to service_role using (true) with check (true);

create policy "service_write" on cache_meta
  for all to service_role using (true) with check (true);

-- Also add new columns to receipts_flags if not already done
alter table receipts_flags add column if not exists upc text;
alter table receipts_flags add column if not exists item_desc text;
