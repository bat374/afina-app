import { Account, CurrencySettings, Debt, PlannedExpense } from './types';
import { localToday, parseLocalDate } from './date';
import { occursOn } from './recurrence';

export type InterestEvent = {
  kind: 'interest' | 'reminder' | 'expense' | 'planned_income' | 'debt_income' | 'debt_expense' | 'credit_payment';
  date: string;
  day: number;
  accountId: string;
  title: string;
  amount: number;
  currency: string;
  trackedInBalance: boolean;
};

export type ProjectedDay = {
  day: number;
  date: string;
  balance: number;
  income: number;
  expense: number;
  risky: boolean;
};

const DAY_MS = 86_400_000;

const isoDate = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

const daysBetween = (from: Date, to: Date) => Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));

const sameDay = (left: Date, right: Date) => left.toDateString() === right.toDateString();

const monthlyPaymentDate = (year: number, month: number, preferredDay: number) =>
  new Date(year, month, Math.min(preferredDay, new Date(year, month + 1, 0).getDate()), 12);

export const getCurrencyTotals = (accounts: Account[]) => {
  const totals: Record<string, number> = {};
  for (const account of accounts) totals[account.currency] = (totals[account.currency] ?? 0) + account.balance;
  return totals;
};

const convertedFlowAmount = (flow: PlannedExpense, account: Account | undefined, currency: string, settings?: CurrencySettings) => {
  const targetCurrency = account?.currency ?? flow.currency;
  if (targetCurrency !== currency) return null;
  if (flow.currency === targetCurrency) return flow.amount;
  if (flow.exchangeRate && flow.exchangeRate > 0) return flow.amount * flow.exchangeRate;
  const sourceRate = settings?.rates[flow.currency];
  const targetRate = targetCurrency === settings?.baseCurrency ? 1 : settings?.rates[targetCurrency];
  return sourceRate && targetRate ? flow.amount * sourceRate / targetRate : null;
};

export function buildMonthProjection(accounts: Account[], currency: string, year: number, month: number, plannedExpenses: PlannedExpense[] = [], debts: Debt[] = [], settings?: CurrencySettings, today = localToday()) {
  const count = new Date(year, month + 1, 0).getDate();
  const relevant = accounts.filter((account) => account.currency === currency);
  const trackedIds = new Set(relevant.map((account) => account.id));
  const runningPrincipal = new Map(relevant.map((account) => [account.id, account.balance]));
  let balance = relevant.reduce((sum, account) => sum + account.balance, 0);
  const days: ProjectedDay[] = [];
  const events: InterestEvent[] = [];
  const todayDate = parseLocalDate(today) ?? new Date();

  for (let day = 1; day <= count; day += 1) {
    const current = new Date(year, month, day, 12);
    const date = isoDate(year, month, day);
    let income = 0;
    let scheduledCreditPayment = 0;
    const past = current < todayDate;
    for (const account of relevant) {
      const start = parseLocalDate(account.startDate) ?? new Date(year, month, 1, 12);
      const maturity = parseLocalDate(account.maturityDate);
      if (account.autoRenewal && account.rateReviewReminder && maturity && sameDay(current, maturity)) {
        events.push({
          kind: 'reminder', date, day, accountId: account.id,
          title: `Проверить ставку после пролонгации · ${account.name}`,
          amount: 0, currency, trackedInBalance: false,
        });
      }
      if (!past && account.type === 'credit_card' && account.balance < 0 && account.paymentDueDay) {
        const dueDay = Math.min(account.paymentDueDay, count);
        if (day === dueDay) {
          const paymentAmount = Math.abs(account.balance) * ((account.minimumPaymentPercent ?? 100) / 100);
          scheduledCreditPayment += paymentAmount;
          events.push({
            kind: 'credit_payment', date, day, accountId: account.id,
            title: `Платёж по кредитной карте · ${account.name}`,
            amount: paymentAmount,
            currency, trackedInBalance: false,
          });
        }
      }
      if (past || sameDay(current, todayDate) || !account.rate || account.rate <= 0 || !account.interestSchedule) continue;
      if (current < start || (maturity && current > maturity)) continue;
      let amount = 0;
      if (account.interestSchedule === 'daily') {
        const principal = runningPrincipal.get(account.id) ?? account.balance;
        amount = principal * (account.rate / 100) / 365;
        if (account.interestDestination === 'same') runningPrincipal.set(account.id, principal + amount);
      } else if (account.interestSchedule === 'monthly') {
        const nextInterest = parseLocalDate(account.nextInterestDate);
        const preferredDay = nextInterest?.getDate() ?? start.getDate();
        const paymentDate = monthlyPaymentDate(year, month, preferredDay);
        const isDue = sameDay(current, paymentDate) && (!nextInterest || current >= nextInterest);
        if (isDue) {
          const previousPayment = monthlyPaymentDate(year, month - 1, preferredDay);
          const periodStart = previousPayment < start ? start : previousPayment;
          const principal = runningPrincipal.get(account.id) ?? account.balance;
          amount = principal * (account.rate / 100) * (daysBetween(periodStart, current) / 365);
          if (account.interestDestination === 'same') runningPrincipal.set(account.id, principal + amount);
        }
      } else if (maturity && sameDay(current, maturity)) {
        amount = account.balance * (account.rate / 100) * (daysBetween(start, maturity) / 365);
      }
      if (!amount) continue;
      const tracked = account.interestDestination === 'same' || (!!account.destinationAccountId && trackedIds.has(account.destinationAccountId));
      if (tracked) balance += amount;
      income += amount;
      events.push({ kind: 'interest', date, day, accountId: account.id, title: `Проценты · ${account.name}`, amount, currency, trackedInBalance: tracked });
    }
    let expenseTotal = scheduledCreditPayment;
    if (!past) for (const expense of plannedExpenses) {
      const linkedAccount = accounts.find((item) => item.id === expense.accountId);
      const amount = convertedFlowAmount(expense, linkedAccount, currency, settings);
      if (amount === null || !occursOn(expense, current)) continue;
      if (expense.kind === 'income') { income += amount; balance += amount; }
      else { expenseTotal += amount; balance -= amount; }
      events.push({
        kind: expense.kind === 'income' ? 'planned_income' : 'expense', date, day, accountId: expense.accountId ?? expense.id,
        title: expense.title, amount, currency, trackedInBalance: true,
      });
    }
    if (!past) for (const debt of debts.filter((item) => item.currency === currency && item.status !== 'paid' && item.currentBalance > 0)) {
      const dueDate = parseLocalDate(debt.dueDate);
      if (!dueDate || !sameDay(current, dueDate)) continue;
      if (debt.direction === 'owed_to_me') {
        income += debt.currentBalance;
        balance += debt.currentBalance;
        events.push({ kind: 'debt_income', date, day, accountId: debt.accountId ?? debt.id, title: `Возврат долга · ${debt.person}`, amount: debt.currentBalance, currency, trackedInBalance: true });
      } else {
        expenseTotal += debt.currentBalance;
        balance -= debt.currentBalance;
        events.push({ kind: 'debt_expense', date, day, accountId: debt.accountId ?? debt.id, title: `Погашение долга · ${debt.person}`, amount: debt.currentBalance, currency, trackedInBalance: true });
      }
    }
    days.push({ day, date, balance, income, expense: expenseTotal, risky: balance < 0 });
  }
  return {
    days,
    events,
    openingBalance: relevant.reduce((sum, account) => sum + account.balance, 0),
    closingBalance: days.at(-1)?.balance ?? balance,
    passiveIncome: events.filter((event) => event.kind === 'interest').reduce((sum, event) => sum + event.amount, 0),
    plannedExpense: events.filter((event) => event.kind === 'expense').reduce((sum, event) => sum + event.amount, 0),
    plannedIncome: events.filter((event) => event.kind === 'planned_income').reduce((sum, event) => sum + event.amount, 0),
  };
}

export const annualPassiveIncome = (accounts: Account[], currency: string) =>
  accounts
    .filter((account) => account.currency === currency && account.rate && account.balance > 0 && account.type !== 'credit_card')
    .reduce((sum, account) => sum + account.balance * ((account.rate ?? 0) / 100), 0);
