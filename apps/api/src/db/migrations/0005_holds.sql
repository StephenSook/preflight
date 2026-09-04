-- The held queue: calls the interlock could not decide under strict policy, waiting for a person.
-- A decision here is an override and is written to the ledger; the row keeps who and when.
create table if not exists holds (
  hold_id      text primary key,
  call_uuid    text,
  human_party  text,
  reason       text not null,
  verdicts     jsonb not null,
  status       text not null check (status in ('open', 'placed', 'cancelled')) default 'open',
  created_at   timestamptz not null default now(),
  decided_by   text,
  decided_at   timestamptz
);
create index if not exists holds_status_idx on holds (status, created_at desc);
