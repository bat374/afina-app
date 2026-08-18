-- Additive only: distinguishes, for a 'balance' goal with no specific account, whether it
-- should include only accounts already denominated in the goal's currency (no conversion) or
-- every account converted into it. Existing rows default to null (client backfills the intended
-- per-row value locally); this migration never rewrites existing data.
alter table public.financial_goals
  add column if not exists include_other_currencies boolean;
