export type AccountType = 'card' | 'credit_card' | 'savings' | 'deposit' | 'cash';
export type InterestSchedule = 'daily' | 'monthly' | 'maturity';
export type InterestDestination = 'same' | 'other';
export type WithdrawalPolicy = 'to_zero' | 'minimum_balance' | 'interest_only' | 'none';
export type ExpenseRepeat = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom';
export type RecurrenceUnit = 'day' | 'week' | 'month' | 'year';
export type CashFlowKind = 'income' | 'expense';
export type DebtDirection = 'owed_to_me' | 'i_owe';
export type DebtStatus = 'active' | 'overdue' | 'paid';
export type DebtHistoryType = 'created' | 'edited' | 'payment' | 'early_payment' | 'payment_reversed' | 'extension' | 'overdue';

export type Account = {
  id: string;
  name: string;
  subtitle: string;
  type: AccountType;
  balance: number;
  currency: string;
  rate?: number;
  rateCaption?: string;
  startDate?: string;
  maturityDate?: string;
  interestSchedule?: InterestSchedule;
  interestDestination?: InterestDestination;
  destinationAccountId?: string;
  nextInterestDate?: string;
  autoRenewal?: boolean;
  rateReviewReminder?: boolean;
  withdrawalPolicy?: WithdrawalPolicy;
  minimumBalance?: number;
  replenishmentAllowed?: boolean;
  creditLimit?: number;
  statementDay?: number;
  paymentDueDay?: number;
  gracePeriodDays?: number;
  minimumPaymentPercent?: number;
  accent: string;
};

export type CalendarDay = {
  day: number;
  balance: number;
  income?: number;
  expense?: number;
  risky?: boolean;
};

export type Transaction = {
  id: string;
  title: string;
  category: string;
  amount: number;
  date: string;
  account: string;
  kind: 'income' | 'expense';
};

export type PlannedExpense = {
  id: string;
  title: string;
  category: string;
  amount: number;
  currency: string;
  accountId?: string;
  startDate: string;
  endDate?: string;
  repeat: ExpenseRepeat;
  kind: CashFlowKind;
  repeatInterval?: number;
  repeatUnit?: RecurrenceUnit;
  weekdays?: number[];
  exchangeRate?: number;
  sourceTransactionId?: string;
};

export type Debt = {
  id: string;
  person: string;
  title: string;
  direction: DebtDirection;
  originalAmount: number;
  currentBalance: number;
  currency: string;
  accountId?: string;
  startDate: string;
  dueDate: string;
  status: DebtStatus;
  note?: string;
};

export type DebtHistory = {
  id: string;
  debtId: string;
  type: DebtHistoryType;
  amount?: number;
  fromDate?: string;
  toDate?: string;
  occurredAt: string;
  note?: string;
  operationId?: string;
  relatedHistoryId?: string;
};

export type CurrencySettings = {
  baseCurrency: string;
  rates: Record<string, number>;
  lastUpdated?: string;
  source?: 'manual' | 'cbu';
  autoUpdate?: boolean;
};

export type FinancialOperation = {
  id: string;
  title: string;
  category: string;
  amount: number;
  currency: string;
  accountId: string;
  date: string;
  kind: 'income' | 'expense';
  source: 'manual' | 'debt' | 'interest' | 'sms' | 'receipt';
  debtId?: string;
  relatedOperationId?: string;
  accountAmount?: number;
  accountCurrency?: string;
  status?: 'posted' | 'reversed';
};

export type Budget = {
  id: string;
  category: string;
  currency: string;
  limit: number;
};

export type GoalType = 'balance' | 'monthly_income' | 'debt_payoff';

export type FinancialGoal = {
  id: string;
  title: string;
  type: GoalType;
  target: number;
  currency: string;
  deadline: string;
  accountId?: string;
  debtId?: string;
};

export type Goal = {
  id: string;
  title: string;
  current: number;
  target: number;
  deadline: string;
  color: string;
};
