-- Widening only. `operations.source` only allowed ('manual', 'debt', 'interest', 'sms',
-- 'receipt') here, but local SQLite already allows 'push' (src/database.ts) and the upcoming
-- AI assistant needs 'ai' (src/types.ts FinancialOperation['source']). A single 'push'-sourced
-- operation (confirmed from a push-notification import draft) throws on upsert against this
-- constraint -- and since runUpload (src/cloudSync.ts) writes tables sequentially with
-- 'operations' before debt_history/budgets/financial_goals/interest_postings/transfers/
-- planned_occurrences, one such row silently aborts sync for ALL of those tables too, not just
-- operations. Confirmed via `\d operations` that the constraint is the default Postgres name
-- for an unnamed inline CHECK on this column.
alter table public.operations drop constraint if exists operations_source_check;
alter table public.operations add constraint operations_source_check
  check (source in ('manual', 'debt', 'interest', 'sms', 'receipt', 'push', 'ai'));
