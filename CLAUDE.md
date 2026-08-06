# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Афина (Afina) — an Expo/React Native personal finance app (accounts, debts, planned income/expense,
operations history, budgets, goals, currency conversion, bank-screenshot OCR, Supabase cloud sync).
Package manager is **pnpm** (`pnpm-lock.yaml` is the lockfile; do not introduce npm/yarn lockfiles).

## Commands

```bash
pnpm install
pnpm start              # Expo dev server
pnpm android            # Expo dev server, Android
pnpm ios                # Expo dev server, iOS
pnpm typecheck          # tsc --noEmit — the only automated check in this repo
pnpm exec expo export --platform android   # verifies the app actually bundles
```

There is no test suite and no linter configured — `pnpm typecheck` plus manually exercising the app
(emulator/APK) is the whole verification loop. Treat "did I run it" as part of finishing a UI change.

Installable APK via EAS:

```bash
npx eas-cli@latest login
npx eas-cli@latest build --platform android --profile preview
```

## Before making changes

Read `BACKLOG.adoc` first. It is the live spec and priority list (not a changelog) — features are
described there as requirements, and a `✅` next to an item under "План обновлений" means it's already
implemented, not that it needs redoing. `README.adoc` lists what currently ships.

The backlog's own opening rule ("Правило 0") applies to any non-trivial change: analyze the relevant
backlog section and cross-screen data dependencies first; design the data model and a safe SQLite
migration before writing business logic, and business logic before UI. Don't duplicate a calculation or
a form that already exists elsewhere (currency conversion, debt/operation linking, recurrence
expansion). Verify that upgrading over an installed APK does not lose data, that balances stay
consistent across every screen that shows them, and that you haven't broken an adjacent flow.

## Architecture

**One screen file, one data file per concern.** `App.tsx` (~1300 lines) contains every screen and modal
editor as sibling function components — there is no `components/` directory and no per-screen file
split; this is deliberate, not a TODO. JSX is written dense (many elements per line) to match the
existing style. `src/database.ts` (~1300 lines) is the entire SQLite layer: schema, migrations, and every
query. Other `src/*.ts` files are single-purpose: `currency.ts` (conversion — the only place amounts
should be converted between currencies), `recurrence.ts` (`occursOn` — the recurrence-rule predicate),
`finance.ts` (calendar/month projections), `analytics.ts`, `goals.ts`, `date.ts` (local-date-string
helpers, no timezone conversion), `ocr.ts` (ML Kit screenshot parsing), `cloudSync.ts`/`supabase.ts`.

**Every SQLite call goes through a serializing queue.** `expo-sqlite`'s native bridge is not safe for
concurrent calls on one connection — overlapping statements corrupt each other and crash with
`NativeDatabase.prepareAsync ... SharedObject doesn't contain valid id` (this has happened in
production). `database.ts` defines `enqueue()` and every exported function wraps its body in it, so at
most one statement sequence runs at a time. **Consequence:** if function A needs to call function B from
inside its own enqueued body (e.g. `listDebts` needs `synchronizeOverdueDebts`'s logic), it must call
B's un-enqueued `*Core` variant directly — calling the enqueued export would deadlock (B's task would
sit in the queue behind A, which is waiting on it). When adding a new DB function that composes existing
ones, follow this Core/wrapper split.

**Schema migrations live in `initializeDatabaseCore`, not in separate migration files.** The pattern:
one large `CREATE TABLE IF NOT EXISTS` block always reflects the *current* shape (new installs get it
immediately); existing installs are upgraded additively via `PRAGMA table_info` introspection +
`ALTER TABLE ... ADD COLUMN`; changes to a `CHECK` constraint require the rebuild-via-rename pattern
(`CREATE <table>_v2`, copy, `DROP`, `RENAME`) already used several times in that function — copy that
pattern rather than inventing a new one. `PRAGMA user_version` is bumped but never read; versioning is
de facto via column/DDL introspection.

**Cloud sync is a full-snapshot mirror, not incremental.** `exportLocalSnapshot()`/`replaceLocalSnapshot()`
in `database.ts` serialize the whole local DB to/from a `LocalSnapshot`, and `cloudSync.ts` pushes/pulls
every table by name against Supabase (project id and migrations under `supabase/migrations/`). SQLite
is the offline cache; Supabase is the source of truth once linked. **Adding a table or column that
should survive multi-device sync requires touching four places together**: the local schema/migration in
`database.ts`, the `LocalSnapshot` type + export/replace functions, the push/pull mapping in
`cloudSync.ts`, and a new file in `supabase/migrations/`. Migrations in that folder are never edited
after being committed (see `20260805_000003_legacy_reference_compatibility.sql` fixing up an earlier one)
and are not applied by this codebase — a human runs them against the live Supabase project separately.
Foreign keys onto potentially-deleted/not-yet-synced rows (history, back-references) are deliberately
*not* declared, both locally and in Supabase, to avoid blocking sync — see that same migration.

**Recurring plans vs. their dated instances.** `scheduled_flows` stores the recurring *rule*
(`occursOn()` in `recurrence.ts` tests whether a rule fires on a given date). Individual dated instances
are materialized lazily into `planned_occurrences`, backfilled only up to *today* (never the future) via
a per-flow cursor column (`occurrences_tracking_from`), mirroring how `interest_postings` materializes
computed interest the same way. An occurrence's status (`planned`/`completed`/`cancelled`) and its link
to the real ledger entry it produced (`operations.source_occurrence_id`) are what let the unified
"Операции" history distinguish plan from fact without ever double-counting an executed plan.

## Money and currency

Amounts are plain SQLite `REAL` locally and Postgres `NUMERIC` in Supabase — never introduce floating
rounding by formatting/parsing through an intermediate string representation. All cross-currency math
goes through `convertCurrency`/`convertToBase` in `src/currency.ts`; do not re-derive a rate inline
elsewhere. `tsconfig.json` has `noUncheckedIndexedAccess: true`, so `settings.rates[currency]` is typed
possibly-`undefined` — code already checks for a missing rate rather than assuming one exists.
