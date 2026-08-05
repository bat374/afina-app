-- Existing SQLite installations can contain historical references to entities
-- that were deleted before cloud sync was introduced. Keep those identifiers
-- for audit/history instead of rejecting the complete migration.
alter table public.accounts drop constraint if exists accounts_user_id_destination_account_id_fkey;
alter table public.scheduled_flows drop constraint if exists scheduled_flows_user_id_account_id_fkey;
alter table public.debts drop constraint if exists debts_user_id_account_id_fkey;
alter table public.operations drop constraint if exists operations_user_id_account_id_fkey;
alter table public.operations drop constraint if exists operations_user_id_debt_id_fkey;
alter table public.operations drop constraint if exists operations_user_id_related_operation_id_fkey;
alter table public.debt_history drop constraint if exists debt_history_user_id_operation_id_fkey;
alter table public.debt_history drop constraint if exists debt_history_user_id_related_history_id_fkey;
alter table public.financial_goals drop constraint if exists financial_goals_user_id_account_id_fkey;
alter table public.financial_goals drop constraint if exists financial_goals_user_id_debt_id_fkey;

