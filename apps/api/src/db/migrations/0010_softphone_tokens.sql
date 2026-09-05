-- Softphone user tokens issued, so the daily allowance of public judge tokens survives a restart
-- and is shared across processes. One row per token; the user name is the platform's user name.
create table if not exists softphone_tokens (
  id         bigserial primary key,
  role       text not null check (role in ('judge', 'scheduler')),
  username   text not null,
  issued_at  timestamptz not null default now()
);
create index if not exists softphone_tokens_issued_idx on softphone_tokens (role, issued_at desc);
