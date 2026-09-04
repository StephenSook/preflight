-- The evidence log. Append-only twice over: the application role loses UPDATE and DELETE on the
-- table, and a trigger refuses both even for a role that has them. seq is assigned inside a
-- transaction that holds an advisory lock, so prev_hash always names the real predecessor.
create table if not exists ledger (
  seq         bigint primary key,
  entry       jsonb not null,
  entry_hash  text not null unique,
  prev_hash   text not null,
  created_at  timestamptz not null default now()
);

create or replace function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'ledger is append-only: % is refused', tg_op;
end
$$;

drop trigger if exists ledger_no_update_delete on ledger;
create trigger ledger_no_update_delete
  before update or delete on ledger
  for each row execute function ledger_append_only();

revoke update, delete, truncate on ledger from public;
revoke update, delete, truncate on ledger from current_user;
