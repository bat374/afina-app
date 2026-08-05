-- Afina cloud schema. Money is NUMERIC, never floating point.
-- Every user-owned key is composite (user_id, id) so existing SQLite ids can be migrated safely.

create extension if not exists pgcrypto;

create or replace function public.touch_owned_row()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = timezone('utc', now());
  new.version = case when tg_op = 'UPDATE' then old.version + 1 else coalesce(new.version, 1) end;
  return new;
end;
$$;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'Asia/Tashkent',
  locale text not null default 'ru',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  version bigint not null default 1
);

create table public.accounts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  name text not null,
  subtitle text not null default '',
  type text not null check (type in ('card', 'credit_card', 'savings', 'deposit', 'cash')),
  balance numeric(24,6) not null default 0,
  currency text not null,
  rate numeric(12,6),
  rate_caption text,
  start_date date,
  maturity_date date,
  interest_schedule text check (interest_schedule in ('daily', 'monthly', 'maturity')),
  interest_destination text check (interest_destination in ('same', 'other')),
  destination_account_id text,
  next_interest_date date,
  auto_renewal boolean not null default false,
  rate_review_reminder boolean not null default true,
  withdrawal_policy text check (withdrawal_policy in ('to_zero', 'minimum_balance', 'interest_only', 'none')),
  minimum_balance numeric(24,6),
  replenishment_allowed boolean,
  credit_limit numeric(24,6),
  statement_day smallint check (statement_day between 1 and 31),
  payment_due_day smallint check (payment_due_day between 1 and 31),
  grace_period_days integer check (grace_period_days >= 0),
  minimum_payment_percent numeric(12,6),
  accent text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, destination_account_id) references public.accounts(user_id, id) deferrable initially deferred
);

create table public.scheduled_flows (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  category text not null default 'Другое',
  amount numeric(24,6) not null check (amount >= 0),
  currency text not null,
  account_id text,
  start_date date not null,
  end_date date,
  repeat_rule text not null,
  kind text not null check (kind in ('income', 'expense')),
  repeat_interval integer not null default 1 check (repeat_interval > 0),
  repeat_unit text check (repeat_unit in ('day', 'week', 'month', 'year')),
  weekdays smallint[],
  exchange_rate numeric(24,10) check (exchange_rate > 0),
  source_transaction_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) deferrable initially deferred
);

create table public.debts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  person text not null,
  title text not null default '',
  direction text not null check (direction in ('owed_to_me', 'i_owe')),
  original_amount numeric(24,6) not null check (original_amount > 0),
  current_balance numeric(24,6) not null check (current_balance >= 0),
  currency text not null,
  account_id text,
  start_date date not null,
  due_date date not null,
  status text not null check (status in ('active', 'overdue', 'paid')),
  note text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) deferrable initially deferred
);

create table public.operations (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  category text not null,
  amount numeric(24,6) not null check (amount > 0),
  currency text not null,
  account_id text not null,
  date date not null,
  kind text not null check (kind in ('income', 'expense')),
  source text not null check (source in ('manual', 'debt', 'interest', 'sms', 'receipt')),
  debt_id text,
  related_operation_id text,
  account_amount numeric(24,6),
  account_currency text,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) deferrable initially deferred,
  foreign key (user_id, debt_id) references public.debts(user_id, id) deferrable initially deferred,
  foreign key (user_id, related_operation_id) references public.operations(user_id, id) deferrable initially deferred
);

create table public.debt_history (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  debt_id text not null,
  type text not null check (type in ('created', 'edited', 'payment', 'early_payment', 'payment_reversed', 'extension', 'overdue')),
  amount numeric(24,6),
  from_date date,
  to_date date,
  occurred_at timestamptz not null,
  note text,
  operation_id text,
  related_history_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, debt_id) references public.debts(user_id, id) on delete cascade deferrable initially deferred,
  foreign key (user_id, operation_id) references public.operations(user_id, id) deferrable initially deferred,
  foreign key (user_id, related_history_id) references public.debt_history(user_id, id) deferrable initially deferred
);

create table public.budgets (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  category text not null,
  currency text not null,
  limit_amount numeric(24,6) not null check (limit_amount > 0),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id)
);

create table public.financial_goals (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  title text not null,
  type text not null check (type in ('balance', 'monthly_income', 'debt_payoff')),
  target numeric(24,6) not null check (target > 0),
  currency text not null,
  deadline date not null,
  account_id text,
  debt_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, account_id) references public.accounts(user_id, id) deferrable initially deferred,
  foreign key (user_id, debt_id) references public.debts(user_id, id) deferrable initially deferred
);

create table public.interest_postings (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  account_id text not null,
  payout_date date not null,
  amount numeric(24,6) not null check (amount >= 0),
  destination_account_id text,
  operation_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  unique (user_id, account_id, payout_date),
  foreign key (user_id, account_id) references public.accounts(user_id, id) on delete cascade deferrable initially deferred,
  foreign key (user_id, destination_account_id) references public.accounts(user_id, id) deferrable initially deferred,
  foreign key (user_id, operation_id) references public.operations(user_id, id) deferrable initially deferred
);

create table public.user_settings (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  base_currency text not null default 'UZS',
  rates_last_updated timestamptz,
  rates_source text check (rates_source in ('manual', 'cbu')),
  auto_update_rates boolean not null default true,
  migration_completed_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  version bigint not null default 1
);

create table public.user_currency_rates (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  currency text not null,
  rate_to_base numeric(24,10) not null check (rate_to_base > 0),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (user_id, currency)
);

create table public.exchange_rates (
  base_currency text not null,
  quote_currency text not null,
  rate numeric(24,10) not null check (rate > 0),
  rate_date date not null,
  source text not null,
  fetched_at timestamptz not null default timezone('utc', now()),
  primary key (base_currency, quote_currency, rate_date)
);

create index accounts_user_active_idx on public.accounts(user_id, type) where deleted_at is null;
create index operations_user_date_idx on public.operations(user_id, date desc) where deleted_at is null;
create index operations_user_account_date_idx on public.operations(user_id, account_id, date desc) where deleted_at is null;
create index flows_user_dates_idx on public.scheduled_flows(user_id, start_date, end_date) where deleted_at is null;
create index debts_user_status_idx on public.debts(user_id, status, due_date) where deleted_at is null;
create index debt_history_user_debt_idx on public.debt_history(user_id, debt_id, occurred_at desc) where deleted_at is null;
create index goals_user_deadline_idx on public.financial_goals(user_id, deadline) where deleted_at is null;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles','accounts','scheduled_flows','debts','operations','debt_history',
    'budgets','financial_goals','interest_postings','user_settings','user_currency_rates'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_own_rows', table_name
    );
    execute format('grant select, insert, update, delete on public.%I to authenticated', table_name);
  end loop;
end $$;

alter table public.exchange_rates enable row level security;
create policy exchange_rates_authenticated_read on public.exchange_rates
  for select to authenticated using (true);
grant select on public.exchange_rates to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'profiles','accounts','scheduled_flows','debts','operations','debt_history',
    'budgets','financial_goals','interest_postings','user_settings'
  ] loop
    execute format(
      'create trigger %I before insert or update on public.%I for each row execute function public.touch_owned_row()',
      'touch_' || table_name, table_name
    );
  end loop;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email));
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'financial-documents',
  'financial-documents',
  false,
  10485760,
  array['image/jpeg','image/png','image/webp','application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy financial_documents_select on storage.objects
  for select to authenticated
  using (bucket_id = 'financial-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy financial_documents_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'financial-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy financial_documents_update on storage.objects
  for update to authenticated
  using (bucket_id = 'financial-documents' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'financial-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy financial_documents_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'financial-documents' and (storage.foldername(name))[1] = (select auth.uid())::text);

