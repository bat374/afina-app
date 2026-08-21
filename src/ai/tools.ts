import { analyticsRange, summarizeOperations, summarizePlannedFlows } from '../analytics';
import { convertCurrency } from '../currency';
import * as db from '../database';
import { buildMonthProjection } from '../finance';
import { calculateGoalProgress } from '../goals';
import { localToday } from '../date';
import { AiBillSplitProposal, AiProposalKind, AiProposalPayload, ExpenseRepeat, RecurrenceUnit } from '../types';

export type ToolExecutionResult = { resultText: string; proposal?: { kind: AiProposalKind; payload: AiProposalPayload } };

const round2 = (value: number) => Math.round(value * 100) / 100;

// Splits whatever's left after any explicitly-named participant amounts equally among the
// remaining participants AND the payer -- the payer never gets their own debt row (they paid),
// so their implicit share (and any rounding remainder) simply isn't subtracted from the bill
// anywhere else. The model is told never to compute shares itself (see tools.ts description);
// this is the one and only place a split amount is actually computed.
function resolveBillSplitAmounts(payload: AiBillSplitProposal): AiBillSplitProposal {
  const unnamed = payload.participants.filter((participant) => participant.amount === undefined);
  if (!unnamed.length) return payload;
  const namedSum = payload.participants.reduce((sum, participant) => sum + (participant.amount ?? 0), 0);
  const remaining = payload.totalAmount - namedSum;
  const share = round2(remaining / (unnamed.length + 1));
  return { ...payload, participants: payload.participants.map((participant) => participant.amount === undefined ? { ...participant, amount: share } : participant) };
}

async function resolveAccountId(accountId: unknown): Promise<string | undefined> {
  if (typeof accountId !== 'string' || !accountId) return undefined;
  const accounts = await db.listAccounts();
  return accounts.some((account) => account.id === accountId) ? accountId : undefined;
}

async function resolveDebtId(debtId: unknown): Promise<string | undefined> {
  if (typeof debtId !== 'string' || !debtId) return undefined;
  const debts = await db.listDebts();
  return debts.some((debt) => debt.id === debtId) ? debtId : undefined;
}

export async function executeTool(name: string, input: Record<string, unknown>): Promise<ToolExecutionResult> {
  switch (name) {
    case 'search_operations': {
      const operations = await db.listOperations();
      const from = String(input.from ?? '');
      const to = String(input.to ?? '');
      const kind = input.kind as string | undefined;
      const filtered = operations
        .filter((op) => op.status !== 'reversed' && op.date >= from && op.date <= to)
        .filter((op) => !input.accountId || op.accountId === input.accountId)
        .filter((op) => !input.category || op.category === input.category)
        .filter((op) => !kind || kind === 'all' || op.kind === kind)
        .filter((op) => !input.textQuery || op.title.toLowerCase().includes(String(input.textQuery).toLowerCase()))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, typeof input.limit === 'number' ? Math.min(input.limit, 200) : 50);
      return { resultText: JSON.stringify(filtered.map((op) => ({ date: op.date, title: op.title, category: op.category, amount: op.amount, currency: op.currency, kind: op.kind }))) };
    }
    case 'summarize_spending': {
      const operations = await db.listOperations();
      const settings = await db.getCurrencySettings();
      const currency = (input.currency as string) ?? settings.baseCurrency;
      const range = { from: String(input.from ?? ''), to: String(input.to ?? '') };
      const summary = summarizeOperations(operations, currency, range, settings);
      return { resultText: JSON.stringify({ currency, income: summary.income, expense: summary.expense, passive: summary.passive, missingRatesFor: summary.missing }) };
    }
    case 'get_account_details': {
      const accounts = await db.listAccounts();
      const ids = Array.isArray(input.accountIds) ? input.accountIds as string[] : undefined;
      const filtered = ids?.length ? accounts.filter((account) => ids.includes(account.id)) : accounts;
      return { resultText: JSON.stringify(filtered.map((account) => ({
        id: account.id, name: account.name, type: account.type, balance: account.balance, currency: account.currency,
        rate: account.rate, taxRate: account.taxRate, maturityDate: account.maturityDate,
      }))) };
    }
    case 'list_debts': {
      const debts = await db.listDebts();
      const status = input.status as string | undefined;
      const direction = input.direction as string | undefined;
      const filtered = debts.filter((debt) => (!status || debt.status === status) && (!direction || debt.direction === direction));
      return { resultText: JSON.stringify(filtered.map((debt) => ({ id: debt.id, person: debt.person, title: debt.title, direction: debt.direction, currentBalance: debt.currentBalance, currency: debt.currency, dueDate: debt.dueDate, status: debt.status }))) };
    }
    case 'list_planned_flows': {
      const [flows, accounts, settings] = await Promise.all([db.listPlannedExpenses(), db.listAccounts(), db.getCurrencySettings()]);
      const kind = input.kind as string | undefined;
      const filtered = flows.filter((flow) => !kind || kind === 'all' || flow.kind === kind);
      if (input.from && input.to) {
        const range = { from: String(input.from), to: String(input.to) };
        const summary = summarizePlannedFlows(filtered, accounts, settings.baseCurrency, range, settings);
        return { resultText: JSON.stringify({ flows: filtered.map((flow) => ({ id: flow.id, title: flow.title, category: flow.category, amount: flow.amount, currency: flow.currency, kind: flow.kind, startDate: flow.startDate, repeat: flow.repeat })), periodSummaryInBaseCurrency: summary }) };
      }
      return { resultText: JSON.stringify(filtered.map((flow) => ({ id: flow.id, title: flow.title, category: flow.category, amount: flow.amount, currency: flow.currency, kind: flow.kind, startDate: flow.startDate, repeat: flow.repeat }))) };
    }
    case 'get_budgets_and_goals': {
      const [budgets, goals, accounts, operations, debts, settings] = await Promise.all([
        db.listBudgets(), db.listFinancialGoals(), db.listAccounts(), db.listOperations(), db.listDebts(), db.getCurrencySettings(),
      ]);
      const goalsWithProgress = goals.map((goal) => {
        const progress = calculateGoalProgress(goal, accounts, operations, debts, settings);
        return { id: goal.id, title: goal.title, type: goal.type, target: goal.target, currency: goal.currency, deadline: goal.deadline, percent: progress.percent, current: progress.current };
      });
      return { resultText: JSON.stringify({ budgets, goals: goalsWithProgress }) };
    }
    case 'project_balance': {
      const [accounts, flows, debts, occurrences, operations, transfers, settings] = await Promise.all([
        db.listAccounts(), db.listPlannedExpenses(), db.listDebts(), db.listPlannedOccurrences(), db.listOperations(), db.listTransfers(), db.getCurrencySettings(),
      ]);
      const currency = String(input.currency ?? settings.baseCurrency);
      const accountFilter = typeof input.accountId === 'string' ? (account: { id: string }) => account.id === input.accountId : undefined;
      const projection = buildMonthProjection(accounts, currency, Number(input.year), Number(input.month), flows, debts, settings, localToday(), occurrences, operations, transfers, accountFilter);
      return { resultText: JSON.stringify({ currency, openingBalance: projection.openingBalance, closingBalance: projection.closingBalance, passiveIncome: projection.passiveIncome, plannedExpense: projection.plannedExpense, plannedIncome: projection.plannedIncome }) };
    }
    case 'propose_operation': {
      const currency = String(input.currency ?? '');
      const payload: AiProposalPayload = {
        kind: 'operation', title: String(input.title ?? ''), category: String(input.category ?? 'Другое'),
        amount: Number(input.amount), currency, accountId: await resolveAccountId(input.accountId),
        date: String(input.date ?? localToday()), operationKind: input.operationKind === 'income' ? 'income' : 'expense',
        note: typeof input.note === 'string' ? input.note : undefined,
      };
      return { resultText: 'Черновик операции подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'operation', payload } };
    }
    case 'propose_transfer': {
      const payload: AiProposalPayload = {
        kind: 'transfer', fromAccountId: await resolveAccountId(input.fromAccountId), toAccountId: await resolveAccountId(input.toAccountId),
        fromAmount: Number(input.fromAmount), toAmount: Number(input.toAmount ?? input.fromAmount),
        exchangeRate: typeof input.exchangeRate === 'number' ? input.exchangeRate : undefined,
        note: typeof input.note === 'string' ? input.note : undefined, date: String(input.date ?? localToday()),
      };
      return { resultText: 'Черновик перевода подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'transfer', payload } };
    }
    case 'propose_debt': {
      const payload: AiProposalPayload = {
        kind: 'debt', person: String(input.person ?? ''), title: String(input.title ?? ''),
        direction: input.direction === 'i_owe' ? 'i_owe' : 'owed_to_me', originalAmount: Number(input.originalAmount),
        currency: String(input.currency ?? ''), accountId: await resolveAccountId(input.accountId),
        startDate: String(input.startDate ?? localToday()), dueDate: String(input.dueDate ?? localToday()),
        note: typeof input.note === 'string' ? input.note : undefined,
      };
      return { resultText: 'Черновик долга подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'debt', payload } };
    }
    case 'propose_debt_payment': {
      const payload: AiProposalPayload = {
        kind: 'debt_payment', debtId: await resolveDebtId(input.debtId), amount: Number(input.amount),
        date: String(input.date ?? localToday()), accountId: await resolveAccountId(input.accountId),
        exchangeRate: typeof input.exchangeRate === 'number' ? input.exchangeRate : undefined,
        note: typeof input.note === 'string' ? input.note : undefined,
      };
      return { resultText: 'Черновик погашения долга подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'debt_payment', payload } };
    }
    case 'propose_planned_flow': {
      const payload: AiProposalPayload = {
        kind: 'planned_flow', title: String(input.title ?? ''), category: String(input.category ?? 'Другое'),
        amount: Number(input.amount), currency: String(input.currency ?? ''), accountId: await resolveAccountId(input.accountId),
        startDate: String(input.startDate ?? localToday()), endDate: typeof input.endDate === 'string' ? input.endDate : undefined,
        repeat: (typeof input.repeat === 'string' ? input.repeat : 'once') as ExpenseRepeat,
        flowKind: input.flowKind === 'income' ? 'income' : 'expense',
        repeatInterval: typeof input.repeatInterval === 'number' ? input.repeatInterval : undefined,
        repeatUnit: typeof input.repeatUnit === 'string' ? (input.repeatUnit as RecurrenceUnit) : undefined,
      };
      return { resultText: 'Черновик плана подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'planned_flow', payload } };
    }
    case 'propose_bill_split': {
      const rawPayload: AiBillSplitProposal = {
        kind: 'bill_split', title: String(input.title ?? ''), category: String(input.category ?? 'Другое'),
        totalAmount: Number(input.totalAmount), currency: String(input.currency ?? ''),
        payingAccountId: await resolveAccountId(input.payingAccountId), date: String(input.date ?? localToday()),
        dueDate: typeof input.dueDate === 'string' ? input.dueDate : undefined,
        participants: Array.isArray(input.participants)
          ? (input.participants as { name?: unknown; amount?: unknown }[]).map((participant) => ({
              name: String(participant.name ?? ''), amount: typeof participant.amount === 'number' ? participant.amount : undefined,
            }))
          : [],
      };
      const payload = resolveBillSplitAmounts(rawPayload);
      return { resultText: 'Черновик разделения счёта подготовлен, ждёт подтверждения пользователя.', proposal: { kind: 'bill_split', payload } };
    }
    default:
      return { resultText: JSON.stringify({ error: `Неизвестный инструмент: ${name}` }) };
  }
}
