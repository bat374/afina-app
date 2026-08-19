-- Additive only. An interest-posting operation's account_id is where the money landed, which for
-- interest_destination='other' is a different account than the one that actually earned it. This
-- records which account earned it, so income can be attributed (and its rate/schedule displayed)
-- against the earning deposit rather than the receiving account. Never rewrites existing data —
-- historical interest operations simply have this column null, and consumers fall back to
-- account_id for those rows.
alter table public.operations add column if not exists interest_source_account_id text;
