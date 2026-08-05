import { convertCurrency } from './currency';
import { Account, CurrencySettings, Debt, FinancialGoal, FinancialOperation } from './types';

export function calculateGoalProgress(goal: FinancialGoal, accounts: Account[], operations: FinancialOperation[], debts: Debt[], settings: CurrencySettings, now = new Date()) {
  let current = 0;
  const missing = new Set<string>();
  const addConverted = (amount: number, currency: string) => {
    const converted = convertCurrency(amount, currency, goal.currency, settings);
    if (converted === null) missing.add(currency); else current += converted;
  };
  if (goal.type === 'balance') {
    const relevant = goal.accountId ? accounts.filter((account) => account.id === goal.accountId) : accounts;
    relevant.forEach((account) => addConverted(account.balance, account.currency));
  } else if (goal.type === 'monthly_income') {
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    operations.filter((operation) => operation.kind === 'income' && operation.status !== 'reversed' && !operation.relatedOperationId && operation.date.startsWith(prefix))
      .forEach((operation) => addConverted(operation.amount, operation.currency));
  } else {
    const debt = debts.find((item) => item.id === goal.debtId);
    if (debt) addConverted(Math.max(0, debt.originalAmount - debt.currentBalance), debt.currency);
  }
  return { current, missing: [...missing], percent: goal.target > 0 ? Math.min(100, Math.max(0, current / goal.target * 100)) : 0, overdue: goal.deadline < now.toISOString().slice(0, 10) && current < goal.target };
}
