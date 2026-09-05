-- Cached Identity Insights answers, one row per line (the last ten digits of the number). A paid
-- lookup runs after a decision, never inside one; the next decision for the same line reads this.
create table if not exists number_insights (
  line          text primary key,
  status        text not null check (status in ('ok', 'error')),
  insight       jsonb,
  error         text,
  http_status   integer,
  latency_ms    integer,
  looked_up_at  timestamptz not null default now()
);
