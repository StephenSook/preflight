-- Every webhook Preflight admits, with the exact bytes received. Rate properties (P6-P8) and the
-- replay corpus are computed from this table. Never updated in place.
create table if not exists webhooks (
  id                 bigserial primary key,
  kind               text not null check (kind in ('answer', 'event', 'fallback')),
  received_at        timestamptz not null default now(),
  method             text not null check (method in ('GET', 'POST')),
  application_id     text,
  call_uuid          text,
  conversation_uuid  text,
  raw                text not null,
  payload            jsonb,
  origin_latency_ms  double precision,
  verify_latency_ms  double precision,
  decision           text check (decision in ('pass', 'block', 'hold', 'forwarded', 'stored'))
);

create index if not exists webhooks_call_uuid_idx on webhooks (call_uuid);
create index if not exists webhooks_received_at_idx on webhooks (received_at desc);
create index if not exists webhooks_kind_status_idx on webhooks (kind, (payload->>'status'));
