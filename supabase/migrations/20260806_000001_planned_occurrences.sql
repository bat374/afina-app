-- O-01: track individual dated instances of a recurring plan (scheduled_flows) independently
-- of the rule, so history can distinguish planned/overdue/cancelled items and link an executed
-- occurrence to the resulting operation without duplicating it.

alter table public.scheduled_flows add column if not exists occurrences_tracking_from date;
alter table public.operations add column if not exists source_occurrence_id text;

create table public.planned_occurrences (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  flow_id text not null,
  occurrence_date date not null,
  status text not null default 'planned' check (status in ('planned', 'completed', 'cancelled')),
  operation_id text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  version bigint not null default 1,
  primary key (user_id, id),
  unique (user_id, flow_id, occurrence_date)
);

create index planned_occurrences_user_flow_idx on public.planned_occurrences(user_id, flow_id, occurrence_date desc) where deleted_at is null;

alter table public.planned_occurrences enable row level security;
create policy planned_occurrences_own_rows on public.planned_occurrences for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
grant select, insert, update, delete on public.planned_occurrences to authenticated;

create trigger touch_planned_occurrences before insert or update on public.planned_occurrences
  for each row execute function public.touch_owned_row();
