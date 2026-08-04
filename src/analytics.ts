import { convertCurrency } from './currency';
import { addLocalDays, localToday, parseLocalDate, toLocalIso } from './date';
import { flowAmountInCurrency } from './finance';
import { occursOn } from './recurrence';
import { Account, CurrencySettings, FinancialOperation, PlannedExpense } from './types';

export type AnalyticsPeriod = 'month' | 'quarter' | 'year' | 'all' | 'custom';
export type DateRange = { from: string; to: string };

export function analyticsRange(period: AnalyticsPeriod, today = localToday(), custom?: DateRange, earliest?: string): DateRange {
  const current = parseLocalDate(today) ?? new Date();
  if (period === 'custom' && custom?.from && custom?.to) {
    return custom.from <= custom.to ? custom : { from: custom.to, to: custom.from };
  }
  if (period === 'all') return { from: earliest && earliest <= today ? earliest : `${current.getFullYear()}-01-01`, to: today };
  const startMonth = period === 'quarter' ? Math.floor(current.getMonth() / 3) * 3 : period === 'year' ? 0 : current.getMonth();
  const endMonth = period === 'quarter' ? startMonth + 2 : period === 'year' ? 11 : startMonth;
  return {
    from: toLocalIso(new Date(current.getFullYear(), startMonth, 1, 12)),
    to: toLocalIso(new Date(current.getFullYear(), endMonth + 1, 0, 12)),
  };
}

export function summarizeOperations(operations: FinancialOperation[], currency: string, range: DateRange, settings: CurrencySettings) {
  let income = 0;
  let expense = 0;
  let passive = 0;
  const missing = new Set<string>();
  const byInterestAccount: Record<string, number> = {};
  const reversedIds = new Set(operations.filter((operation) => operation.status === 'reversed').map((operation) => operation.id));
  for (const operation of operations) {
    if (operation.status === 'reversed' || (operation.relatedOperationId && reversedIds.has(operation.relatedOperationId)) || operation.date < range.from || operation.date > range.to) continue;
    const converted = convertCurrency(operation.amount, operation.currency, currency, settings);
    if (converted === null) { missing.add(operation.currency); continue; }
    if (operation.kind === 'income') income += converted; else expense += converted;
    if (operation.kind === 'income' && operation.source === 'interest') {
      passive += converted;
      byInterestAccount[operation.accountId] = (byInterestAccount[operation.accountId] ?? 0) + converted;
    }
  }
  return { income, expense, passive, byInterestAccount, missing: [...missing] };
}

export function summarizePlannedFlows(flows: PlannedExpense[], accounts: Account[], currency: string, range: DateRange, settings: CurrencySettings) {
  let income = 0;
  let expense = 0;
  const start = parseLocalDate(range.from);
  const end = parseLocalDate(range.to);
  if (!start || !end) return { income, expense };
  for (let cursor = range.from; cursor <= range.to; cursor = addLocalDays(cursor, 1)) {
    const date = parseLocalDate(cursor);
    if (!date) break;
    for (const flow of flows) {
      if (!occursOn(flow, date)) continue;
      const account = accounts.find((item) => item.id === flow.accountId);
      const amount = flowAmountInCurrency(flow, account, currency, settings);
      if (amount === null) continue;
      if (flow.kind === 'income') income += amount; else expense += amount;
    }
  }
  return { income, expense };
}
