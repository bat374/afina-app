import { Account, CurrencySettings, Debt, FinancialOperation, PlannedExpense, PlannedOccurrence, Transfer } from './types';
import { addLocalDays, localToday, parseLocalDate } from './date';
import { convertCurrency } from './currency';
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

// `nativeCurrency` is what the linked account actually gets charged/credited in (or the flow's
// own currency if it isn't linked to an account yet) -- distinct from `currency`, the display
// currency the caller asked for (whatever's selected on the Calendar/Home/Analytics screen).
// Previously this returned null whenever those two didn't match, silently dropping any plan not
// denominated in the exact currency currently selected on screen, even though a conversion rate
// for it existed and is used everywhere else in the app (BACKLOG.md BUG-03: planned expenses
// disappearing from Analytics' "План расходов" because their account's currency isn't whatever
// currency happened to be selected).
export const flowAmountInCurrency = (flow: PlannedExpense, account: Account | undefined, currency: string, settings?: CurrencySettings) => {
  const nativeCurrency = account?.currency ?? flow.currency;
  let nativeAmount: number;
  if (flow.currency === nativeCurrency) nativeAmount = flow.amount;
  else if (flow.exchangeRate && flow.exchangeRate > 0) nativeAmount = flow.amount * flow.exchangeRate;
  else {
    const sourceRate = settings?.rates[flow.currency];
    const targetRate = nativeCurrency === settings?.baseCurrency ? 1 : settings?.rates[nativeCurrency];
    if (!sourceRate || !targetRate) return null;
    nativeAmount = flow.amount * sourceRate / targetRate;
  }
  if (nativeCurrency === currency) return nativeAmount;
  return settings ? convertCurrency(nativeAmount, nativeCurrency, currency, settings) : null;
};

export function buildMonthProjection(accounts: Account[], currency: string, year: number, month: number, plannedExpenses: PlannedExpense[] = [], debts: Debt[] = [], settings?: CurrencySettings, today = localToday(), plannedOccurrences: PlannedOccurrence[] = [], operations: FinancialOperation[] = [], transfers: Transfer[] = [], accountFilter?: (account: Account) => boolean) {
  // A flow's occurrence for "today" can already be resolved (executed or cancelled) by the time
  // this projection runs — "today" itself doesn't count as `past` below, so without this the same
  // flow would otherwise be counted once as a real operation (already in account.balance) and a
  // second time here as a still-pending projected event.
  const resolvedOccurrenceKeys = new Set(
    plannedOccurrences.filter((occurrence) => occurrence.status !== 'planned').map((occurrence) => `${occurrence.flowId}|${occurrence.occurrenceDate}`),
  );
  const count = new Date(year, month + 1, 0).getDate();
  const relevant = accounts.filter((account) => account.currency === currency && (!accountFilter || accountFilter(account)));
  const trackedIds = new Set(relevant.map((account) => account.id));
  const runningPrincipal = new Map(relevant.map((account) => [account.id, account.balance]));
  let balance = relevant.reduce((sum, account) => sum + account.balance, 0);
  const currentBalance = balance;
  const days: ProjectedDay[] = [];
  const events: InterestEvent[] = [];
  const todayDate = parseLocalDate(today) ?? new Date();

  // Reconstructs past days' actual balance/income/expense from real history instead of repeating
  // today's live balance for every day before it (the account.balance in `relevant` is always
  // "right now" — it has no memory of what it was on any earlier date). Only posted, non-reversed
  // operations/transfers on the tracked accounts count; the same-currency transfer pool nets to
  // zero on the aggregate `relevant` total by construction, which is correct.
  const historyOperations = operations.filter((op) => op.status !== 'reversed' && trackedIds.has(op.accountId) && op.currency === currency);
  const historyTransfers = transfers.filter((transfer) => transfer.status !== 'reversed');
  // Gross income/expense in (fromExclusiveIso, toInclusiveIso] -- kept separate rather than
  // netted, so a day with both an income and an expense still shows both, not just the difference.
  const grossTotalsInRange = (fromExclusiveIso: string, toInclusiveIso: string) => {
    let income = 0; let expense = 0;
    for (const op of historyOperations) {
      if (op.date > fromExclusiveIso && op.date <= toInclusiveIso) { if (op.kind === 'income') income += op.amount; else expense += op.amount; }
    }
    for (const transfer of historyTransfers) {
      if (transfer.date <= fromExclusiveIso || transfer.date > toInclusiveIso) continue;
      if (trackedIds.has(transfer.fromAccountId) && transfer.fromCurrency === currency) expense += transfer.fromAmount;
      if (trackedIds.has(transfer.toAccountId) && transfer.toCurrency === currency) income += transfer.toAmount;
    }
    return { income, expense };
  };

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
      // Some banks withhold tax on deposit/savings interest before crediting it — taxFactor turns
      // the gross contractual rate into what actually lands on the account, applied before the
      // amount is used for compounding (interestDestination==='same') so growth tracks the real,
      // net-of-tax balance rather than an inflated gross one.
      const taxFactor = 1 - (account.taxRate ?? 0) / 100;
      if (account.interestSchedule === 'daily') {
        const principal = runningPrincipal.get(account.id) ?? account.balance;
        amount = principal * (account.rate / 100) / 365 * taxFactor;
        if (account.interestDestination === 'same') runningPrincipal.set(account.id, principal + amount);
      } else if (account.interestSchedule === 'monthly') {
        const preferredDay = start.getDate();
        const paymentDate = monthlyPaymentDate(year, month, preferredDay);
        const isDue = sameDay(current, paymentDate);
        if (isDue) {
          const previousPayment = monthlyPaymentDate(year, month - 1, preferredDay);
          const periodStart = previousPayment < start ? start : previousPayment;
          const principal = runningPrincipal.get(account.id) ?? account.balance;
          amount = principal * (account.rate / 100) * (daysBetween(periodStart, current) / 365) * taxFactor;
          if (account.interestDestination === 'same') runningPrincipal.set(account.id, principal + amount);
        }
      } else if (maturity && sameDay(current, maturity)) {
        amount = account.balance * (account.rate / 100) * (daysBetween(start, maturity) / 365) * taxFactor;
      }
      if (!amount) continue;
      const tracked = account.interestDestination === 'same' || (!!account.destinationAccountId && trackedIds.has(account.destinationAccountId));
      if (tracked) balance += amount;
      income += amount;
      events.push({ kind: 'interest', date, day, accountId: account.id, title: `Проценты · ${account.name}`, amount, currency, trackedInBalance: tracked });
    }
    let expenseTotal = scheduledCreditPayment;
    if (!past) for (const expense of plannedExpenses) {
      if (resolvedOccurrenceKeys.has(`${expense.id}|${date}`)) continue;
      const linkedAccount = accounts.find((item) => item.id === expense.accountId);
      if (linkedAccount && accountFilter && !accountFilter(linkedAccount)) continue;
      const amount = flowAmountInCurrency(expense, linkedAccount, currency, settings);
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
      const linkedDebtAccount = accounts.find((item) => item.id === debt.accountId);
      if (linkedDebtAccount && accountFilter && !accountFilter(linkedDebtAccount)) continue;
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
    if (past) {
      // Everything above this block was skipped for a past day (every projection branch is
      // gated on `!past`), so `balance`/`income`/`expenseTotal` are still just carrying today's
      // live figures forward unchanged -- reconstruct this day's actual numbers from history
      // instead of pushing those as if they applied historically too.
      const previousDate = addLocalDays(date, -1);
      const afterToday = grossTotalsInRange(date, today);
      const dayBalance = currentBalance - afterToday.income + afterToday.expense;
      const onThisDay = grossTotalsInRange(previousDate, date);
      days.push({ day, date, balance: dayBalance, income: onThisDay.income, expense: onThisDay.expense, risky: dayBalance < 0 });
    } else {
      days.push({ day, date, balance, income, expense: expenseTotal, risky: balance < 0 });
    }
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
    .reduce((sum, account) => sum + account.balance * ((account.rate ?? 0) / 100) * (1 - (account.taxRate ?? 0) / 100), 0);
