import { getCurrencySettings, listAccounts, listDebts, listOperations, listPlannedExpenses, listFinancialGoals } from '../database';
import { localToday } from '../date';
import { AssistantContext } from './protocol';

// Compact per-turn snapshot sent to the Edge Function alongside the conversation -- deliberately
// small (accounts + counts, not full operation history: the model asks for detail via read tools
// instead). See docs/ai-assistant/anthropic-design.md section 1 for why the server never reads
// this itself from Postgres.
export async function buildAssistantContext(): Promise<AssistantContext> {
  const [accounts, settings, operations, debts, plannedFlows, goals] = await Promise.all([
    listAccounts(), getCurrencySettings(), listOperations(), listDebts(), listPlannedExpenses(), listFinancialGoals(),
  ]);
  const earliestOperationDate = operations.map((op) => op.date).sort()[0];
  return {
    today: localToday(),
    baseCurrency: settings.baseCurrency,
    rates: settings.rates,
    accounts: accounts.map((account) => ({
      id: account.id, name: account.name, type: account.type, balance: account.balance,
      currency: account.currency, cardLast4: account.cardLast4,
    })),
    counts: { operations: operations.length, debts: debts.length, plannedFlows: plannedFlows.length, goals: goals.length },
    earliestOperationDate,
  };
}
