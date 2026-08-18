-- Additive only: adds account-to-account transfers as their own owned table, following the
-- exact conventions of every other owned table (user_id scoping, RLS, touch_owned_row trigger,
-- soft-delete column, optimistic version). Never rewrites or drops existing data.
create table public.transfers (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  from_account_id text not null,
  to_account_id text not null,
  from_amount numeric(24,6) not null check (from_amount > 0),
  from_currency text not null,
  to_amount numeric(24,6) not null check (to_amount > 0),
  to_currency text not null,
  exchange_rate numeric(24,10),
  note text,
  date date not null,
  status text not null default 'posted' check (status in ('posted', 'reversed')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  foreign key (user_id, from_account_id) references public.accounts(user_id, id) deferrable initially deferred,
  foreign key (user_id, to_account_id) references public.accounts(user_id, id) deferrable initially deferred
);

create index transfers_user_date_idx on public.transfers(user_id, date desc) where deleted_at is null;

alter table public.transfers enable row level security;
create policy transfers_own_rows on public.transfers
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.transfers to authenticated;

create trigger touch_transfers before insert or update on public.transfers
  for each row execute function public.touch_owned_row();
