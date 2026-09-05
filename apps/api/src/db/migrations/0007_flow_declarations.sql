-- What the developer declares about their own flow (identification beat, opt-out handler, endpoints
-- and the action sequences each serves). Every change is a new row; the newest row is current, and
-- every change is also an entry in the evidence log, because the declaration shapes two atoms.
create table if not exists flow_declarations (
  id                bigserial primary key,
  application_id    text,
  declaration       jsonb not null,
  declaration_hash  text not null,
  declared_by       text not null,
  declared_at       timestamptz not null default now()
);
create index if not exists flow_declarations_app_idx on flow_declarations (application_id, id desc);
