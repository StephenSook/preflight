-- One row per answer-path decision, and one row per property verdict beneath it. The witness path
-- is stored as the exact action sequence the monitor produced.
create table if not exists calls (
  id                    bigserial primary key,
  call_uuid             text,
  conversation_uuid     text,
  application_id        text,
  direction             text not null check (direction in ('inbound', 'outbound', 'unknown')),
  from_number           text,
  to_number             text,
  human_party           text,
  state                 text,
  rate_center           text,
  line_type             text not null,
  line_type_source      text not null,
  line_type_confidence  text not null,
  zones                 text[] not null default '{}',
  within_hours          boolean,
  hours_basis           text not null,
  policy                text not null check (policy in ('strict', 'advisory')),
  terminal              boolean not null,
  ncco_hash             text not null,
  decision              text not null check (decision in ('pass', 'block', 'hold')),
  reason                text,
  decided_at            timestamptz not null default now(),
  origin_latency_ms     double precision,
  verify_latency_ms     double precision
);
create index if not exists calls_decided_at_idx on calls (decided_at desc);
create index if not exists calls_call_uuid_idx on calls (call_uuid);
create index if not exists calls_decision_idx on calls (decision);

create table if not exists verdicts (
  id            bigserial primary key,
  call_id       bigint not null references calls (id) on delete cascade,
  property_id   text not null,
  verdict       text not null check (verdict in ('true', 'false', 'inconclusive')),
  citation      text not null,
  witness       jsonb,
  at_end        boolean not null default false,
  reason        text
);
create index if not exists verdicts_call_id_idx on verdicts (call_id);
