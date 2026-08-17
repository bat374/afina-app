# Claude orchestration entrypoint — Afina

Read and follow `AGENTS.md` first. It is the shared source of truth for Claude and Codex.

## Default workflow

For non-trivial work:
1. Read `BACKLOG.md` and inspect the affected code/data flow.
2. Decide which specialist agents are needed.
3. Ask specialists for focused analysis in parallel when tasks are independent.
4. Define financial/data invariants before implementation.
5. Implement or delegate a tightly scoped implementation to Codex.
6. Run an independent review pass, preferably using `codex-reviewer` for material financial/data changes.
7. Run checks and inspect the final diff before reporting completion.

## When to use which specialist

- `.claude/agents/mobile-architect.md`: Expo/React Native architecture and native constraints.
- `.claude/agents/finance-domain.md`: personal-finance calculations and accounting semantics.
- `.claude/agents/data-sync.md`: SQLite, migrations, Supabase, RLS, offline sync.
- `.claude/agents/mobile-ux.md`: mobile financial UX/UI and dashboard clarity.
- `.claude/agents/qa-reviewer.md`: regressions, edge cases and acceptance testing.
- `.claude/agents/codex-reviewer.md`: independent Codex review and implementation delegation.

## Important

Do not treat UI work as isolated when it changes financial meaning. Any change to balances, transactions, goals, debts, deposits, credit cards, analytics or transfers must include finance-domain review and, when persistence changes, data-sync review.
