-- The old dyndns.org name keeps its own state, apart from the Cloudflare
-- record: a failed mirror is tried again even if the address stays the same.
alter table devices add column legacy_ip text;      -- address last sent to the old name
alter table devices add column legacy_result text;  -- its answer
alter table devices add column legacy_at text;      -- when
