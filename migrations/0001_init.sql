-- Returns service schema. Every row carries the commercebuild store id it
-- belongs to (the token's cb_store_id); every query filters by it.
-- No customer names, email addresses or postal addresses are stored.

create table if not exists returns (
  id               uuid primary key default gen_random_uuid(),
  store_id         text not null,
  request_number   integer not null,
  request_id       text not null,             -- "RET-1001"
  order_number     text not null,
  order_date       text not null default '',
  currency_code    text not null default '',
  customer_code    text not null default '',
  user_id          integer not null,          -- platform user who submitted it
  locale           text not null default '',  -- for links in emails
  status           text not null,
  status_history   jsonb not null default '[]',
  rma              text,
  comment          text not null default '',
  items            jsonb not null,            -- line snapshot taken from the order at create
  item_count       integer not null,
  estimated_credit numeric(14, 4) not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (store_id, request_number),
  unique (store_id, request_id)
);
create index if not exists returns_store_created_idx on returns (store_id, created_at desc);
create index if not exists returns_store_customer_idx on returns (store_id, customer_code);
create index if not exists returns_store_order_idx on returns (store_id, order_number);

create table if not exists return_photos (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references returns (id) on delete cascade,
  line_sequence integer not null,
  item_code     text not null default '',
  data_url      text not null,
  mime_type     text not null default '',
  source        text not null default 'request',  -- request | customer-response
  created_at    timestamptz not null default now()
);
create index if not exists return_photos_return_idx on return_photos (return_id);

create table if not exists return_notes (
  id             uuid primary key default gen_random_uuid(),
  return_id      uuid not null references returns (id) on delete cascade,
  text           text not null,
  author_name    text not null default '',     -- staff display name
  author_user_id integer not null,
  created_at     timestamptz not null default now()
);
create index if not exists return_notes_return_idx on return_notes (return_id);

-- Per-store sequences: request numbers and RMA numbers.
create table if not exists counters (
  store_id text not null,
  name     text not null,
  next     integer not null,
  primary key (store_id, name)
);

create table if not exists store_settings (
  store_id   text primary key,
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- One row per (store, Idempotency-Key): a repeated write returns the stored
-- answer instead of running again.
create table if not exists idempotency_keys (
  store_id   text not null,
  key        text not null,
  status     integer,            -- null while the first request is running
  response   jsonb,
  created_at timestamptz not null default now(),
  primary key (store_id, key)
);

create table if not exists schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
