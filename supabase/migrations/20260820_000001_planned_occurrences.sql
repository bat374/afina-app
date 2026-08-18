-- Additive only: adds plan/fact tracking for recurring plans (scheduled_flows). Lets an
-- executed occurrence record a different amount/currency than what was planned (e.g. a salary
-- planned in USD but actually credited in UZS) without losing the link back to the plan or
-- double-counting the plan and the resulting operation. Never rewrites or drops existing data.

alter table public.scheduled_flows add column if not exists occurrences_tracking_from date;
alter table public.operations add column if not exists source_occurrence_id text;
alter table public.operations add column if not exists planned_amount numeric(24,6);
alter table public.operations add column if not exists planned_currency text;

create table public.planned_occurrences (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  flow_id text not null,
  occurrence_date date not null,
  amount numeric(24,6) not null check (amount > 0),
  currency text not null,
  status text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  operation_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  unique (user_id, flow_id, occurrence_date),
  foreign key (user_id, flow_id) references public.scheduled_flows(user_id, id) on delete cascade deferrable initially deferred,
  foreign key (user_id, operation_id) references public.operations(user_id, id) deferrable initially deferred
);

create index planned_occurrences_user_flow_idx on public.planned_occurrences(user_id, flow_id, occurrence_date desc) where deleted_at is null;

alter table public.planned_occurrences enable row level security;
create policy planned_occurrences_own_rows on public.planned_occurrences
  for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.planned_occurrences to authenticated;

create trigger touch_planned_occurrences before insert or update on public.planned_occurrences
  for each row execute function public.touch_owned_row();
