create table if not exists call_webhook_claims (
  call_uuid text not null,
  event_key text not null,
  primary key (call_uuid, event_key)
);
