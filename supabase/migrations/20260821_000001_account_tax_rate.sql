-- Additive only. Percent of interest withheld by the bank before payout (e.g. 20 for 20%),
-- entered by the user against an account. Some banks withhold tax on deposit/savings interest
-- before crediting it, so the app's forecast (buildMonthProjection in src/finance.ts) needs this
-- to match what the bank actually pays instead of the gross contractual rate alone. Null means
-- "no tax withheld" (unchanged behavior for existing accounts).
alter table public.accounts add column if not exists tax_rate numeric;
