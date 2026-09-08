alter table holds
  add column placement_hash text,
  add column placement_expires_at timestamptz;

create unique index holds_placement_hash_unique on holds (placement_hash) where placement_hash is not null;
