-- Additive only. Per-user rate-limit accounting for the ai-assistant Edge Function. Deliberately
-- has RLS enabled with ZERO policies and no grants to anon/authenticated: only the function's
-- service-role client (which bypasses RLS entirely) can read or write it. This is the whole
-- point -- a decompiled APK that somehow calls this table directly gets nothing, so it can't
-- read or reset its own rate-limit counters.
create table public.ai_usage_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  model text not null,
  outcome text not null check (outcome in ('ok', 'rate_limited', 'upstream_error', 'unauthenticated', 'bad_protocol')),
  input_tokens integer,
  output_tokens integer
);

create index ai_usage_log_user_created_idx on public.ai_usage_log (user_id, created_at desc);

alter table public.ai_usage_log enable row level security;
-- No policies, no grants -- see comment above.
revoke all on public.ai_usage_log from anon, authenticated;
