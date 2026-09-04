-- Consent to one demonstration call. A person asks Preflight to call their phone; Verify v2 speaks a
-- code to that phone first; the checked code grants a single, short-lived consent that the demo call
-- consumes exactly once. This is consent to THIS call, not campaign-level prior-express-consent
-- record keeping. The number is kept here to place the call; the ledger records only its hash.
create table if not exists consents (
  request_id    text primary key,
  number        text not null,
  requested_at  timestamptz not null,
  granted_at    timestamptz,
  expires_at    timestamptz,
  used_at       timestamptz
);
create index if not exists consents_number_idx on consents (number, requested_at desc);
create index if not exists consents_requested_idx on consents (requested_at desc);
create index if not exists consents_used_idx on consents (used_at desc);
