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
  // Last 4 digits of the card, as printed on bank SMS/receipts (e.g. "3463"). Used to match an
  // incoming SMS or receipt photo to this account without guessing — see BACKLOG.md R-01/R-02/R-03.
  // Synced via cloudSync.ts (supabase/migrations/20260820_000002_account_card_last4.sql).
  cardLast4?: string;
  // Percent withheld by the bank from interest before it's credited (e.g. 20 for 20%) — some banks
  // withhold tax on deposit/savings interest before payout, so the actual credited amount is lower
  // than `rate` alone would predict. Applied in buildMonthProjection (src/finance.ts) so the
  // forecast matches what the bank actually pays, not the gross contractual rate.
  // Synced via cloudSync.ts (supabase/migrations/20260821_000001_account_tax_rate.sql).
  taxRate?: number;
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
  occurrencesTrackingFrom?: string;
};

export type PlannedOccurrenceStatus = 'planned' | 'completed' | 'cancelled';

// A materialized, dated instance of a recurring PlannedExpense. amount/currency are a snapshot
// taken when the occurrence was generated, not a live read of the (possibly since-edited) flow —
// so a plan/fact deviation always compares against what was actually planned for that date.
export type PlannedOccurrence = {
  id: string;
  flowId: string;
  occurrenceDate: string;
  amount: number;
  currency: string;
  status: PlannedOccurrenceStatus;
  operationId?: string;
};

export type ImportDraftStatus = 'pending' | 'unrecognized' | 'confirmed' | 'dismissed';
export type ImportDraftSource = 'sms' | 'push';

// A parsed (or unparseable) bank SMS or push notification awaiting user confirmation before it
// can ever touch a balance. Device-local only — the raw text never leaves the phone (not synced
// to Supabase). `sender` holds the SMS sender id for source='sms', or the notifying app's Android
// package name for source='push'.
export type ImportDraft = {
  id: string;
  source: ImportDraftSource;
  sender: string;
  parserId?: string;
  rawBody: string;
  receivedAt: string;
  occurredAt?: string;
  amount?: number;
  currency?: string;
  kind?: 'income' | 'expense';
  feeAmount?: number;
  cardLast4?: string;
  accountId?: string;
  merchant?: string;
  balanceAfter?: number;
  // Set only when the bank message ALSO reports a deposit renewal alongside a transaction — e.g.
  // Sberbank's "СберВклад ... Продлили по ставке 12,10% до 21.01.27. Выплатили проценты ...". The
  // transaction (interest payout) still goes through the normal confirm/dedup flow; these two
  // fields let the confirm UI additionally offer to apply the new rate/maturity to the account.
  renewedRate?: number;
  renewedMaturityDate?: string;
  status: ImportDraftStatus;
  operationId?: string;
  dedupOperationId?: string;
};

// One row per rate/maturity change on a deposit or savings account — kept so "what rate did I
// actually have in March" stays answerable after an auto-renewal changes account.rate in place.
export type DepositRateHistory = {
  id: string;
  accountId: string;
  oldRate?: number;
  newRate: number;
  oldMaturityDate?: string;
  newMaturityDate?: string;
  occurredAt: string;
  note?: string;
};

export type PlannedExecutionInput = {
  title: string;
  category: string;
  amount: number;
  currency: string;
  accountId?: string;
  date: string;
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
  source: 'manual' | 'debt' | 'interest' | 'sms' | 'receipt' | 'push';
  debtId?: string;
  relatedOperationId?: string;
  accountAmount?: number;
  accountCurrency?: string;
  status?: 'posted' | 'reversed';
  // Set only when this operation was created from a PlannedOccurrence. plannedAmount/plannedCurrency
  // are that occurrence's snapshot (what was planned), kept alongside the operation's own
  // amount/currency (what actually happened) so a plan/fact deviation can be shown without
  // recomputing anything — distinct from accountAmount/accountCurrency, which is a separate
  // concept (a debt-currency operation's amount in the settling account's currency).
  sourceOccurrenceId?: string;
  plannedAmount?: number;
  plannedCurrency?: string;
  // Set only when source === 'interest': the deposit/savings account the interest was actually
  // earned on — accountId is where the money landed, which for interestDestination='other' is a
  // different account entirely. Attribution (which account "owns" this income, at what rate)
  // must follow this field, not accountId, or a payout card ends up mislabeled with its own 0%
  // rate next to money it merely received.
  interestSourceAccountId?: string;
  // Local device file URI for an attached receipt photo. Not synced to Supabase — the path is only
  // valid on the device that took the picture, and there's no Supabase Storage bucket configured
  // to hold the actual image bytes yet (see BACKLOG.md R-01). Purely a local attachment for now.
  receiptPhotoUri?: string;
};

export type InterestPosting = {
  id: string;
  accountId: string;
  payoutDate: string;
  amount: number;
  destinationAccountId?: string;
  operationId?: string;
};

export type Transfer = {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  fromAmount: number;
  fromCurrency: string;
  toAmount: number;
  toCurrency: string;
  exchangeRate?: number;
  note?: string;
  date: string;
  status: 'posted' | 'reversed';
};

export type TransferInput = {
  fromAccountId: string;
  toAccountId: string;
  fromAmount: number;
  toAmount: number;
  exchangeRate?: number;
  note?: string;
  date: string;
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
  // Only meaningful for type 'balance' when accountId is unset (i.e. "all accounts"):
  // true = every account, other currencies converted into `currency`;
  // false/undefined = only accounts already denominated in `currency`, no conversion.
  includeAllCurrencies?: boolean;
};

export type Goal = {
  id: string;
  title: string;
  current: number;
  target: number;
  deadline: string;
  color: string;
};
