-- Additive only: one row per rate/maturity change on a deposit or savings account (e.g. an
-- auto-renewal at a new rate), so "what rate did this account actually have in March" stays
-- answerable after account.rate/maturity_date is overwritten in place. Follows the exact
-- conventions of every other owned table (user_id scoping, RLS, touch_owned_row trigger,
-- soft-delete column, optimistic version) — see supabase/migrations/20260819_000001_transfers.sql.
create table public.deposit_rate_history (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  account_id text not null,
  old_rate numeric(10,4),
  new_rate numeric(10,4) not null,
  old_maturity_date date,
  new_maturity_date date,
  occurred_at timestamptz not null,
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) deferrable initially deferred
);

create index deposit_rate_history_user_account_idx on public.deposit_rate_history(user_id, account_id) where deleted_at is null;

alter table public.deposit_rate_history enable row level security;
create policy deposit_rate_history_own_rows on public.deposit_rate_history
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.deposit_rate_history to authenticated;

create trigger touch_deposit_rate_history before insert or update on public.deposit_rate_history
  for each row execute function public.touch_owned_row();
