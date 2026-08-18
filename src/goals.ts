import { convertCurrency, operationConversionBasis } from './currency';
import { Account, CurrencySettings, Debt, FinancialGoal, FinancialOperation } from './types';

export function calculateGoalProgress(goal: FinancialGoal, accounts: Account[], operations: FinancialOperation[], debts: Debt[], settings: CurrencySettings, now = new Date()) {
  let current = 0;
  const missing = new Set<string>();
  let includedAccountIds: string[] = [];
  const addConverted = (amount: number, currency: string) => {
    const converted = convertCurrency(amount, currency, goal.currency, settings);
    if (converted === null) missing.add(currency); else current += converted;
  };
  if (goal.type === 'balance') {
    // With no specific account picked, "includeAllCurrencies" distinguishes two different
    // intents that used to be conflated: only accounts already in the goal's own currency
    // (no conversion, exact figures) vs every account converted into it (broader, rate-dependent).
    const relevant = goal.accountId
      ? accounts.filter((account) => account.id === goal.accountId)
      : goal.includeAllCurrencies
        ? accounts
        : accounts.filter((account) => account.currency === goal.currency);
    includedAccountIds = relevant.map((account) => account.id);
    relevant.forEach((account) => addConverted(account.balance, account.currency));
  } else if (goal.type === 'monthly_income') {
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    operations.filter((operation) => operation.kind === 'income' && operation.status !== 'reversed' && !operation.relatedOperationId && operation.date.startsWith(prefix))
      .forEach((operation) => { const basis = operationConversionBasis(operation); addConverted(basis.amount, basis.currency); });
  } else {
    const debt = debts.find((item) => item.id === goal.debtId);
    if (debt) addConverted(Math.max(0, debt.originalAmount - debt.currentBalance), debt.currency);
  }
  const rawPercent = goal.target > 0 ? Math.max(0, current / goal.target * 100) : 0;
  return {
    current,
    missing: [...missing],
    includedAccountIds,
    percent: Math.min(100, rawPercent),
    rawPercent,
    overdue: goal.deadline < now.toISOString().slice(0, 10) && current < goal.target,
  };
}
