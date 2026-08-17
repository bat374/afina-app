# Afina AI Collaboration Rules

This repository uses Claude Code as the primary orchestrator and Codex as an implementation/review partner.

## Product context

Afina is a personal-finance mobile app built with Expo, React Native and TypeScript. It uses SQLite as an offline cache, Supabase/PostgreSQL for cloud sync, Row Level Security for user isolation, Expo SecureStore for session tokens, and local ML Kit OCR in installed builds.

Financial correctness and data preservation are higher priority than UI speed.

## Global execution rules

1. Read `BACKLOG.md` before any non-trivial feature work. Respect dependencies and already-defined product decisions.
2. Before editing financial flows, inspect data model, migrations, balances, operation history, cloud sync and all affected screens.
3. Prefer shared domain functions over duplicated calculations. Currency conversion, interest accrual, balances, debt repayment, transfers, goals and analytics must not maintain competing formulas.
4. Any schema change must include a safe SQLite migration and corresponding Supabase considerations when cloud-synced entities are affected.
5. Never expose Supabase secret/service-role keys in the app, repo, logs, prompts or generated files. Client code may use only publishable/anon credentials.
6. Preserve auditability for financial history. Reversals and corrections should use linked compensating events where the product model requires an audit trail.
7. Treat multi-currency behavior explicitly. Never add amounts in different currencies without conversion or display them as one total without clear currency semantics.
8. For changes that affect balances, test both local SQLite state and cloud-sync behavior, including retries and offline scenarios.
9. Run at minimum `pnpm typecheck` before declaring implementation complete. For release-sensitive changes also run the appropriate Expo export/build checks when the environment allows it.
10. Do not push directly to `main` for substantial changes. Work in a task branch and use PR review when practical.

## Claude ↔ Codex orchestration

Claude owns decomposition, architecture, delegation and final synthesis.

Use Codex for one or more of these roles:
- independent implementation of a well-scoped task;
- second-pass code review;
- regression/risk analysis;
- focused refactoring after Claude defines invariants;
- test/check generation.

When Claude delegates to Codex, give Codex:
- the concrete goal;
- files or subsystems in scope;
- invariants that must remain true;
- acceptance criteria;
- commands to run;
- explicit instruction not to broaden scope unnecessarily.

For read-only review, prefer a read-only sandbox. For implementation, use a writable workspace sandbox, e.g. `codex exec --sandbox workspace-write "<task>"`.

After Codex returns, Claude must independently inspect the diff/results before accepting them.

## Role routing

### mobile-architect
Use for navigation, React Native/Expo architecture, component boundaries, app lifecycle, native-module constraints and release/build implications.

### finance-domain
Use for balances, income/expense semantics, debts, deposits, credit cards, interest, budgets, goals, transfers, plan/fact logic and multi-currency calculations.

### data-sync
Use for SQLite schema/migrations, transactionality, queues, Supabase/PostgreSQL sync, conflict behavior, RLS and offline recovery.

### mobile-ux
Use for interaction design, information hierarchy, forms, dashboards/analytics screens, accessibility, Android/iOS ergonomics and financial-product clarity.

### qa-reviewer
Use for acceptance criteria, regression matrices, edge cases, migration safety, duplicate-submission prevention and cross-screen balance consistency.

### codex-reviewer
Use Codex as an independent reviewer after material implementation. Ask it to find correctness issues, missing edge cases, unsafe data migrations, duplicated financial logic and regressions; require concrete file-level findings.

## Definition of done

A task is not complete until:
- the requested behavior works;
- financial invariants remain consistent;
- relevant migrations/sync are addressed;
- affected screens use the same underlying business rules;
- obvious duplicate-submit and offline/retry cases are considered;
- typecheck passes, or any inability to run it is explicitly reported;
- the final response lists changed files, checks run and unresolved risks.
