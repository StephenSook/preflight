-- What a leg's answer-time webhook said about the call (direction, from, to, the app user), kept
-- beside its executed path. The platform's input event on a timeout carries `uuid: null` and none
-- of those fields, so the branch hook reads them back and decides the continuation as the same
-- call: the same caller id, the same calling hours, the same person on the line.
alter table call_paths add column if not exists context jsonb;
