-- The discovered call-flow graph (spec section 09) and the per-call executed path that lets a
-- branch callback be evaluated as a continuation of what the call has already run.
create table if not exists flow_nodes (
  id                 text primary key,
  application_id     text,
  endpoint           text not null,
  action_index       integer not null,
  action_type        text not null,
  action             jsonb not null,
  payload_hash       text not null,
  first_seen         timestamptz not null,
  last_seen          timestamptz not null,
  observation_count  integer not null default 1
);
create index if not exists flow_nodes_endpoint_idx on flow_nodes (endpoint);

create table if not exists flow_edges (
  from_node     text not null references flow_nodes (id),
  to_node       text not null references flow_nodes (id),
  edge_kind     text not null check (edge_kind in ('sequential', 'input_branch', 'notify_branch', 'continue')),
  first_seen    timestamptz not null,
  observations  integer not null default 1,
  primary key (from_node, to_node, edge_kind)
);

create table if not exists call_paths (
  call_uuid   text primary key,
  node_ids    text[] not null,
  updated_at  timestamptz not null default now()
);

-- Branch callbacks routed through Preflight are a fourth webhook kind.
alter table webhooks drop constraint if exists webhooks_kind_check;
alter table webhooks add constraint webhooks_kind_check check (kind in ('answer', 'event', 'fallback', 'hook'));
