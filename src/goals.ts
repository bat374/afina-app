import { Account, Debt, FinancialGoal, FinancialOperation } from './types';

export function calculateGoalProgress(goal: FinancialGoal, accounts: Account[], operations: FinancialOperation[], debts: Debt[], passiveIncome = 0, now = new Date()) {
  let current = 0;
  if (goal.type === 'balance') {
    current = goal.accountId
      ? accounts.find((account) => account.id === goal.accountId)?.balance ?? 0
      : accounts.filter((account) => account.currency === goal.currency).reduce((sum, account) => sum + account.balance, 0);
  } else if (goal.type === 'monthly_income') {
    const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    current = operations.filter((operation) => operation.kind === 'income' && operation.currency === goal.currency && operation.date.startsWith(prefix)).reduce((sum, operation) => sum + operation.amount, 0) + passiveIncome;
  } else {
    const debt = debts.find((item) => item.id === goal.debtId);
    current = debt ? Math.max(0, debt.originalAmount - debt.currentBalance) : 0;
  }
  return { current, percent: goal.target > 0 ? Math.min(100, Math.max(0, current / goal.target * 100)) : 0, overdue: goal.deadline < now.toISOString().slice(0, 10) && current < goal.target };
}
