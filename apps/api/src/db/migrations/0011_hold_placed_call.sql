-- A hold a person released records what the platform then placed on it, so the answer webhook and
-- the branch hook for that call (matched by call or conversation uuid) can find the override and
-- run the call on it: an inconclusive verdict passes, a false verdict still blocks.
alter table holds add column if not exists placed_call_uuid text;
alter table holds add column if not exists placed_conversation_uuid text;
create index if not exists holds_placed_call_idx on holds (placed_call_uuid) where placed_call_uuid is not null;
create index if not exists holds_placed_conversation_idx on holds (placed_conversation_uuid) where placed_conversation_uuid is not null;
