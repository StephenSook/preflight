alter table call_paths add column if not exists pending_node_id text;

create table if not exists call_path_legs (
  conversation_uuid text not null,
  call_uuid text not null,
  primary key (conversation_uuid, call_uuid)
);
