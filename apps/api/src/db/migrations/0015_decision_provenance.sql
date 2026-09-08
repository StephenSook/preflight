alter table calls
  add column source text not null default 'unknown' check (source in ('gateway', 'webhook', 'unknown')),
  add column platform_status integer;
