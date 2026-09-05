-- Web Push subscriptions for the held queue (plan addition A7): a hold needs a person, and a
-- person holds a phone. One row per browser subscription; a push service answering 404 or 410
-- removes it. The subscription's keys are the browser's, never the account's.
create table if not exists push_subscriptions (
  endpoint      text primary key,
  subscription  jsonb not null,
  label         text,
  created_at    timestamptz not null default now(),
  last_sent_at  timestamptz,
  last_error    text
);
