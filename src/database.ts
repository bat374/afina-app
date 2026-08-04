import * as SQLite from 'expo-sqlite';
import { Account, AccountType, Budget, CashFlowKind, CurrencySettings, Debt, DebtDirection, DebtHistory, DebtHistoryType, DebtStatus, ExpenseRepeat, FinancialGoal, FinancialOperation, GoalType, InterestDestination, InterestSchedule, PlannedExpense, RecurrenceUnit, WithdrawalPolicy } from './types';
import { addLocalDays, daysBetween, localToday, nextBusinessMonday, nextMonthlyDate, parseLocalDate, previousMonthlyDate, toLocalIso } from './date';

type AccountRow = {
  id: string;
  name: string;
  subtitle: string;
  type: AccountType;
  balance: number;
  currency: string;
  rate: number | null;
  rate_caption: string | null;
  start_date: string | null;
  maturity_date: string | null;
  interest_schedule: InterestSchedule | null;
  interest_destination: InterestDestination | null;
  destination_account_id: string | null;
  next_interest_date: string | null;
  auto_renewal: number;
  rate_review_reminder: number;
  withdrawal_policy: WithdrawalPolicy | null;
  minimum_balance: number | null;
  replenishment_allowed: number | null;
  credit_limit: number | null;
  statement_day: number | null;
  payment_due_day: number | null;
  grace_period_days: number | null;
  minimum_payment_percent: number | null;
  accent: string;
};

export type AccountInput = Omit<Account, 'id'>;
export type PlannedExpenseInput = Omit<PlannedExpense, 'id'>;

type PlannedExpenseRow = {
  id: string;
  title: string;
  category: string;
  amount: number;
  currency: string;
  account_id: string | null;
  start_date: string;
  end_date: string | null;
  repeat_rule: ExpenseRepeat;
  kind: CashFlowKind;
  repeat_interval: number;
  repeat_unit: RecurrenceUnit | null;
  weekdays: string | null;
  exchange_rate: number | null;
  source_transaction_id: string | null;
};

type DebtRow = {
  id: string; person: string; title: string; direction: DebtDirection; original_amount: number;
  current_balance: number; currency: string; account_id: string | null; start_date: string;
  due_date: string; status: DebtStatus; note: string | null;
};

type DebtHistoryRow = {
  id: string; debt_id: string; type: DebtHistoryType; amount: number | null; from_date: string | null;
  to_date: string | null; occurred_at: string; note: string | null;
};

export type DebtInput = Omit<Debt, 'id' | 'currentBalance' | 'status'>;
export type FinancialOperationInput = Omit<FinancialOperation, 'id' | 'source'>;
export type BudgetInput = Omit<Budget, 'id'>;
export type FinancialGoalInput = Omit<FinancialGoal, 'id'>;

let database: Promise<SQLite.SQLiteDatabase> | null = null;

const getDatabase = () => {
  if (!database) database = SQLite.openDatabaseAsync('afina.db');
  return database;
};

export async function initializeDatabase() {
  const db = await getDatabase();
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      subtitle TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK(type IN ('card', 'savings', 'deposit', 'cash')),
      balance REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UZS',
      rate REAL,
      rate_caption TEXT,
      start_date TEXT,
      maturity_date TEXT,
      interest_schedule TEXT CHECK(interest_schedule IN ('daily', 'monthly', 'maturity')),
      interest_destination TEXT CHECK(interest_destination IN ('same', 'other')),
      destination_account_id TEXT,
      next_interest_date TEXT,
      auto_renewal INTEGER NOT NULL DEFAULT 0,
      rate_review_reminder INTEGER NOT NULL DEFAULT 1,
      withdrawal_policy TEXT CHECK(withdrawal_policy IN ('to_zero', 'minimum_balance', 'interest_only', 'none')),
      minimum_balance REAL,
      replenishment_allowed INTEGER,
      credit_limit REAL,
      statement_day INTEGER,
      payment_due_day INTEGER,
      grace_period_days INTEGER,
      minimum_payment_percent REAL,
      accent TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS planned_expenses (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Другое',
      amount REAL NOT NULL CHECK(amount >= 0),
      currency TEXT NOT NULL,
      account_id TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      repeat_rule TEXT NOT NULL CHECK(repeat_rule IN ('once', 'daily', 'weekly', 'monthly', 'yearly')),
      source_transaction_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS scheduled_flows (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'Другое',
      amount REAL NOT NULL CHECK(amount >= 0),
      currency TEXT NOT NULL,
      account_id TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT,
      repeat_rule TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
      repeat_interval INTEGER NOT NULL DEFAULT 1 CHECK(repeat_interval > 0),
      repeat_unit TEXT CHECK(repeat_unit IN ('day', 'week', 'month', 'year')),
      weekdays TEXT,
      exchange_rate REAL CHECK(exchange_rate > 0),
      source_transaction_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS debts (
      id TEXT PRIMARY KEY NOT NULL,
      person TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      direction TEXT NOT NULL CHECK(direction IN ('owed_to_me', 'i_owe')),
      original_amount REAL NOT NULL CHECK(original_amount > 0),
      current_balance REAL NOT NULL CHECK(current_balance >= 0),
      currency TEXT NOT NULL,
      account_id TEXT,
      start_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active', 'overdue', 'paid')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS debt_history (
      id TEXT PRIMARY KEY NOT NULL,
      debt_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('created', 'edited', 'payment', 'early_payment', 'extension', 'overdue')),
      amount REAL,
      from_date TEXT,
      to_date TEXT,
      occurred_at TEXT NOT NULL,
      note TEXT,
      FOREIGN KEY(debt_id) REFERENCES debts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS currency_rates (
      currency TEXT PRIMARY KEY NOT NULL,
      rate_to_base REAL NOT NULL CHECK(rate_to_base > 0)
    );
    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
      source TEXT NOT NULL CHECK(source IN ('manual', 'debt')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS budgets (
      id TEXT PRIMARY KEY NOT NULL,
      category TEXT NOT NULL,
      currency TEXT NOT NULL,
      limit_amount REAL NOT NULL CHECK(limit_amount > 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS financial_goals (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('balance', 'monthly_income', 'debt_payoff')),
      target REAL NOT NULL CHECK(target > 0),
      currency TEXT NOT NULL,
      deadline TEXT NOT NULL,
      account_id TEXT,
      debt_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS interest_postings (
      id TEXT PRIMARY KEY NOT NULL,
      account_id TEXT NOT NULL,
      payout_date TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount >= 0),
      destination_account_id TEXT,
      operation_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, payout_date),
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    INSERT OR IGNORE INTO scheduled_flows
      (id, title, category, amount, currency, account_id, start_date, end_date, repeat_rule, kind,
       repeat_interval, repeat_unit, source_transaction_id, created_at, updated_at)
      SELECT id, title, category, amount, currency, account_id, start_date, end_date, repeat_rule, 'expense', 1,
        CASE repeat_rule WHEN 'daily' THEN 'day' WHEN 'weekly' THEN 'week' WHEN 'monthly' THEN 'month' WHEN 'yearly' THEN 'year' ELSE NULL END,
        source_transaction_id, created_at, updated_at FROM planned_expenses;
  `);
  let columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(accounts)');
  if (!columns.some((column) => column.name === 'maturity_date')) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE accounts_v2 (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK(type IN ('card', 'savings', 'deposit', 'cash')),
        balance REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'UZS',
        rate REAL,
        rate_caption TEXT,
        start_date TEXT,
        maturity_date TEXT,
        interest_schedule TEXT CHECK(interest_schedule IN ('daily', 'monthly', 'maturity')),
        interest_destination TEXT CHECK(interest_destination IN ('same', 'other')),
        destination_account_id TEXT,
        next_interest_date TEXT,
        auto_renewal INTEGER NOT NULL DEFAULT 0,
        rate_review_reminder INTEGER NOT NULL DEFAULT 1,
        withdrawal_policy TEXT CHECK(withdrawal_policy IN ('to_zero', 'minimum_balance', 'interest_only', 'none')),
        minimum_balance REAL,
        replenishment_allowed INTEGER,
        accent TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO accounts_v2 (id, name, subtitle, type, balance, currency, rate, rate_caption, accent, created_at, updated_at)
        SELECT id, name, subtitle, type, balance, currency, rate, rate_caption, accent, created_at, updated_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_v2 RENAME TO accounts;
      COMMIT;
    `);
    columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(accounts)');
  }
  if (!columns.some((column) => column.name === 'auto_renewal')) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE accounts_v3 (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        subtitle TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL CHECK(type IN ('card', 'savings', 'deposit', 'cash')),
        balance REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'UZS',
        rate REAL,
        rate_caption TEXT,
        start_date TEXT,
        maturity_date TEXT,
        interest_schedule TEXT CHECK(interest_schedule IN ('daily', 'monthly', 'maturity')),
        interest_destination TEXT CHECK(interest_destination IN ('same', 'other')),
        destination_account_id TEXT,
        next_interest_date TEXT,
        auto_renewal INTEGER NOT NULL DEFAULT 0,
        rate_review_reminder INTEGER NOT NULL DEFAULT 1,
        withdrawal_policy TEXT CHECK(withdrawal_policy IN ('to_zero', 'minimum_balance', 'interest_only', 'none')),
        minimum_balance REAL,
        replenishment_allowed INTEGER,
        accent TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO accounts_v3 (id, name, subtitle, type, balance, currency, rate, rate_caption,
        start_date, maturity_date, interest_schedule, interest_destination, destination_account_id,
        accent, created_at, updated_at)
        SELECT id, name, subtitle, type, balance, currency, rate, rate_caption,
        start_date, maturity_date, interest_schedule, interest_destination, destination_account_id,
        accent, created_at, updated_at FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_v3 RENAME TO accounts;
      COMMIT;
    `);
  }
  columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(accounts)');
  if (!columns.some((column) => column.name === 'interest_tracking_from')) {
    await db.execAsync('ALTER TABLE accounts ADD COLUMN interest_tracking_from TEXT;');
    const existingAccounts = await db.getAllAsync<AccountRow>('SELECT * FROM accounts');
    for (const account of existingAccounts) {
      const nextDate = account.next_interest_date ?? (account.start_date ? nextMonthlyDate(account.start_date) : undefined);
      const trackingFrom = account.interest_schedule === 'monthly' && nextDate
        ? previousMonthlyDate(nextDate) ?? localToday()
        : account.interest_schedule === 'maturity' && account.start_date ? account.start_date : localToday();
      await db.runAsync('UPDATE accounts SET interest_tracking_from = ? WHERE id = ?', trackingFrom, account.id);
    }
  }
  columns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(accounts)');
  const creditColumns = [
    ['credit_limit', 'REAL'], ['statement_day', 'INTEGER'], ['payment_due_day', 'INTEGER'],
    ['grace_period_days', 'INTEGER'], ['minimum_payment_percent', 'REAL'],
  ] as const;
  for (const [name, sqlType] of creditColumns) {
    if (!columns.some((column) => column.name === name)) await db.execAsync(`ALTER TABLE accounts ADD COLUMN ${name} ${sqlType};`);
  }
  const operationSql = await db.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'");
  if (operationSql?.sql && !operationSql.sql.includes("'interest'")) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE operations_v2 (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL, account_id TEXT NOT NULL,
        date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        source TEXT NOT NULL CHECK(source IN ('manual', 'debt', 'interest', 'sms', 'receipt')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO operations_v2 SELECT * FROM operations;
      DROP TABLE operations;
      ALTER TABLE operations_v2 RENAME TO operations;
      COMMIT;
    `);
  }
  const debtHistorySql = await db.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'debt_history'");
  if (debtHistorySql?.sql && !debtHistorySql.sql.includes("'edited'")) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE debt_history_v2 (
        id TEXT PRIMARY KEY NOT NULL, debt_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('created', 'edited', 'payment', 'early_payment', 'extension', 'overdue')),
        amount REAL, from_date TEXT, to_date TEXT, occurred_at TEXT NOT NULL, note TEXT,
        FOREIGN KEY(debt_id) REFERENCES debts(id) ON DELETE CASCADE
      );
      INSERT INTO debt_history_v2 SELECT * FROM debt_history;
      DROP TABLE debt_history;
      ALTER TABLE debt_history_v2 RENAME TO debt_history;
      COMMIT;
    `);
  }
  await db.execAsync('PRAGMA user_version = 4;');
}

export async function listAccounts(): Promise<Account[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<AccountRow>('SELECT * FROM accounts ORDER BY created_at ASC');
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    subtitle: row.subtitle,
    type: row.credit_limit !== null ? 'credit_card' : row.type,
    balance: row.balance,
    currency: row.currency,
    rate: row.rate ?? undefined,
    rateCaption: row.rate_caption ?? undefined,
    startDate: row.start_date ?? undefined,
    maturityDate: row.maturity_date ?? undefined,
    interestSchedule: row.interest_schedule ?? undefined,
    interestDestination: row.interest_destination ?? undefined,
    destinationAccountId: row.destination_account_id ?? undefined,
    nextInterestDate: row.next_interest_date ?? undefined,
    autoRenewal: row.auto_renewal === 1,
    rateReviewReminder: row.rate_review_reminder !== 0,
    withdrawalPolicy: row.withdrawal_policy ?? undefined,
    minimumBalance: row.minimum_balance ?? undefined,
    replenishmentAllowed: row.replenishment_allowed === null ? undefined : row.replenishment_allowed === 1,
    creditLimit: row.credit_limit ?? undefined,
    statementDay: row.statement_day ?? undefined,
    paymentDueDay: row.payment_due_day ?? undefined,
    gracePeriodDays: row.grace_period_days ?? undefined,
    minimumPaymentPercent: row.minimum_payment_percent ?? undefined,
    accent: row.accent,
  }));
}

export async function saveAccount(input: AccountInput, id?: string) {
  const db = await getDatabase();
  const nextInterestDate = input.interestSchedule === 'monthly' && input.startDate
    ? input.nextInterestDate ?? nextMonthlyDate(input.startDate)
    : input.nextInterestDate;
  const trackingFrom = input.interestSchedule === 'monthly' && nextInterestDate
    ? previousMonthlyDate(nextInterestDate) ?? localToday()
    : input.interestSchedule === 'maturity' && input.startDate ? input.startDate : localToday();
  if (id) {
    await db.runAsync(
      `UPDATE accounts SET name = ?, subtitle = ?, type = ?, balance = ?, currency = ?,
       rate = ?, rate_caption = ?, start_date = ?, maturity_date = ?, interest_schedule = ?,
       interest_destination = ?, destination_account_id = ?, next_interest_date = ?, auto_renewal = ?,
       rate_review_reminder = ?, withdrawal_policy = ?, minimum_balance = ?, replenishment_allowed = ?,
       credit_limit = ?, statement_day = ?, payment_due_day = ?, grace_period_days = ?, minimum_payment_percent = ?,
       accent = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      input.name, input.subtitle, input.type === 'credit_card' ? 'card' : input.type, input.balance, input.currency,
      input.rate ?? null, input.rateCaption ?? null, input.startDate ?? null, input.maturityDate ?? null,
      input.interestSchedule ?? null, input.interestDestination ?? null, input.destinationAccountId ?? null,
      nextInterestDate ?? null, input.autoRenewal ? 1 : 0, input.rateReviewReminder === false ? 0 : 1,
      input.withdrawalPolicy ?? null, input.minimumBalance ?? null,
      input.replenishmentAllowed === undefined ? null : input.replenishmentAllowed ? 1 : 0,
      input.creditLimit ?? null, input.statementDay ?? null, input.paymentDueDay ?? null,
      input.gracePeriodDays ?? null, input.minimumPaymentPercent ?? null,
      input.accent, id,
    );
    return id;
  }
  const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.runAsync(
    `INSERT INTO accounts (id, name, subtitle, type, balance, currency, rate, rate_caption,
      start_date, maturity_date, interest_schedule, interest_destination, destination_account_id,
      next_interest_date, auto_renewal, rate_review_reminder, withdrawal_policy, minimum_balance,
      replenishment_allowed, credit_limit, statement_day, payment_due_day, grace_period_days,
      minimum_payment_percent, accent, interest_tracking_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId, input.name, input.subtitle, input.type === 'credit_card' ? 'card' : input.type, input.balance, input.currency,
    input.rate ?? null, input.rateCaption ?? null, input.startDate ?? null, input.maturityDate ?? null,
    input.interestSchedule ?? null, input.interestDestination ?? null, input.destinationAccountId ?? null,
    nextInterestDate ?? null, input.autoRenewal ? 1 : 0, input.rateReviewReminder === false ? 0 : 1,
    input.withdrawalPolicy ?? null, input.minimumBalance ?? null,
    input.replenishmentAllowed === undefined ? null : input.replenishmentAllowed ? 1 : 0,
    input.creditLimit ?? null, input.statementDay ?? null, input.paymentDueDay ?? null,
    input.gracePeriodDays ?? null, input.minimumPaymentPercent ?? null,
    input.accent, trackingFrom,
  );
  return newId;
}

export async function deleteAccount(id: string) {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM accounts WHERE id = ?', id);
}

export async function listPlannedExpenses(): Promise<PlannedExpense[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<PlannedExpenseRow>('SELECT * FROM scheduled_flows ORDER BY start_date ASC, created_at ASC');
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    category: row.category,
    amount: row.amount,
    currency: row.currency,
    accountId: row.account_id ?? undefined,
    startDate: row.start_date,
    endDate: row.end_date ?? undefined,
    repeat: row.repeat_rule,
    kind: row.kind,
    repeatInterval: row.repeat_interval,
    repeatUnit: row.repeat_unit ?? undefined,
    weekdays: row.weekdays ? row.weekdays.split(',').map(Number).filter((value) => value >= 1 && value <= 7) : undefined,
    exchangeRate: row.exchange_rate ?? undefined,
    sourceTransactionId: row.source_transaction_id ?? undefined,
  }));
}

export async function savePlannedExpense(input: PlannedExpenseInput, id?: string) {
  const db = await getDatabase();
  const expenseId = id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (id) {
    await db.runAsync(
      `UPDATE scheduled_flows SET title = ?, category = ?, amount = ?, currency = ?, account_id = ?,
       start_date = ?, end_date = ?, repeat_rule = ?, kind = ?, repeat_interval = ?, repeat_unit = ?,
       weekdays = ?, exchange_rate = ?, source_transaction_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      input.title, input.category, input.amount, input.currency, input.accountId ?? null,
      input.startDate, input.endDate ?? null, input.repeat, input.kind, input.repeatInterval ?? 1,
      input.repeatUnit ?? null, input.weekdays?.join(',') ?? null, input.exchangeRate ?? null,
      input.sourceTransactionId ?? null, id,
    );
  } else {
    await db.runAsync(
      `INSERT INTO scheduled_flows (id, title, category, amount, currency, account_id, start_date, end_date,
       repeat_rule, kind, repeat_interval, repeat_unit, weekdays, exchange_rate, source_transaction_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      expenseId, input.title, input.category, input.amount, input.currency, input.accountId ?? null,
      input.startDate, input.endDate ?? null, input.repeat, input.kind, input.repeatInterval ?? 1,
      input.repeatUnit ?? null, input.weekdays?.join(',') ?? null, input.exchangeRate ?? null,
      input.sourceTransactionId ?? null,
    );
  }
  return expenseId;
}

export async function deletePlannedExpense(id: string) {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM scheduled_flows WHERE id = ?', id);
}

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const mapDebt = (row: DebtRow): Debt => ({
  id: row.id, person: row.person, title: row.title, direction: row.direction,
  originalAmount: row.original_amount, currentBalance: row.current_balance, currency: row.currency,
  accountId: row.account_id ?? undefined, startDate: row.start_date, dueDate: row.due_date,
  status: row.status, note: row.note ?? undefined,
});

export async function synchronizeOverdueDebts(today = localToday()) {
  const db = await getDatabase();
  const overdue = await db.getAllAsync<DebtRow>("SELECT * FROM debts WHERE status = 'active' AND current_balance > 0 AND due_date < ?", today);
  if (!overdue.length) return;
  await db.withTransactionAsync(async () => {
    for (const debt of overdue) {
      await db.runAsync("UPDATE debts SET status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = ?", debt.id);
      await db.runAsync(
        'INSERT INTO debt_history (id, debt_id, type, occurred_at, from_date, note) VALUES (?, ?, ?, ?, ?, ?)',
        makeId(), debt.id, 'overdue', `${today}T12:00:00.000Z`, debt.due_date, 'Срок погашения истёк',
      );
    }
  });
}

export async function listDebts(): Promise<Debt[]> {
  await synchronizeOverdueDebts();
  const db = await getDatabase();
  const rows = await db.getAllAsync<DebtRow>("SELECT * FROM debts ORDER BY CASE status WHEN 'overdue' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, due_date ASC");
  return rows.map(mapDebt);
}

export async function createDebt(input: DebtInput) {
  const db = await getDatabase();
  const id = makeId();
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO debts (id, person, title, direction, original_amount, current_balance, currency, account_id, start_date, due_date, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      id, input.person, input.title, input.direction, input.originalAmount, input.originalAmount,
      input.currency, input.accountId ?? null, input.startDate, input.dueDate, input.note ?? null,
    );
    await db.runAsync(
      'INSERT INTO debt_history (id, debt_id, type, amount, occurred_at, note) VALUES (?, ?, ?, ?, ?, ?)',
      makeId(), id, 'created', input.originalAmount, now, input.note ?? null,
    );
  });
  return id;
}

export async function updateDebt(id: string, input: DebtInput) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', id);
  if (!row) throw new Error('Debt not found');
  const paidPart = Math.max(0, row.original_amount - row.current_balance);
  const currentBalance = Math.max(0, input.originalAmount - paidPart);
  const nextStatus: DebtStatus = currentBalance < 0.000001 ? 'paid' : row.status === 'paid' ? 'active' : row.status;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE debts SET person = ?, title = ?, direction = ?, original_amount = ?, current_balance = ?, status = ?,
       currency = ?, account_id = ?, start_date = ?, due_date = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      input.person, input.title, input.direction, input.originalAmount, currentBalance, nextStatus, input.currency,
      input.accountId ?? null, input.startDate, input.dueDate, input.note ?? null, id,
    );
    await db.runAsync(
      'INSERT INTO debt_history (id, debt_id, type, occurred_at, note) VALUES (?, ?, ?, ?, ?)',
      makeId(), id, 'edited', new Date().toISOString(), 'Изменены условия долга',
    );
  });
}

export async function listDebtHistory(debtId: string): Promise<DebtHistory[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<DebtHistoryRow>('SELECT * FROM debt_history WHERE debt_id = ? ORDER BY occurred_at DESC', debtId);
  return rows.map((row) => ({
    id: row.id, debtId: row.debt_id, type: row.type, amount: row.amount ?? undefined,
    fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined,
    occurredAt: row.occurred_at, note: row.note ?? undefined,
  }));
}

export async function recordDebtPayment(debtId: string, requestedAmount: number, paymentDate: string, note?: string) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', debtId);
  if (!row) throw new Error('Debt not found');
  const amount = Math.min(requestedAmount, row.current_balance);
  if (amount <= 0) return;
  const balance = Math.max(0, row.current_balance - amount);
  const paid = balance < 0.000001;
  const historyType: DebtHistoryType = paid && paymentDate < row.due_date ? 'early_payment' : 'payment';
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE debts SET current_balance = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", balance, paid ? 'paid' : row.status, debtId);
    if (row.account_id) {
      const account = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', row.account_id);
      let accountAmount = amount;
      if (account && account.currency !== row.currency) {
        const base = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'base_currency'");
        const source = row.currency === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', row.currency))?.rate_to_base;
        const target = account.currency === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', account.currency))?.rate_to_base;
        if (!source || !target) throw new Error(`Нет курса ${row.currency}/${account.currency}`);
        accountAmount = amount * source / target;
      }
      const delta = row.direction === 'owed_to_me' ? accountAmount : -accountAmount;
      await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, row.account_id);
      await db.runAsync(
        `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source)
         VALUES (?, ?, 'Долги', ?, ?, ?, ?, ?, 'debt')`,
        makeId(), `${row.direction === 'owed_to_me' ? 'Возврат долга' : 'Погашение долга'} · ${row.person}`,
        amount, row.currency, row.account_id, paymentDate, row.direction === 'owed_to_me' ? 'income' : 'expense',
      );
    }
    await db.runAsync(
      'INSERT INTO debt_history (id, debt_id, type, amount, occurred_at, note) VALUES (?, ?, ?, ?, ?, ?)',
      makeId(), debtId, historyType, amount, `${paymentDate}T12:00:00.000Z`, note ?? null,
    );
  });
}

export async function extendDebt(debtId: string, newDueDate: string, note?: string) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', debtId);
  if (!row || row.status === 'paid') return;
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE debts SET due_date = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?", newDueDate, debtId);
    await db.runAsync(
      'INSERT INTO debt_history (id, debt_id, type, from_date, to_date, occurred_at, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      makeId(), debtId, 'extension', row.due_date, newDueDate, now, note ?? null,
    );
  });
}

export async function markDebtOverdue(debtId: string, note?: string) {
  const db = await getDatabase();
  const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', debtId);
  if (!row || row.status !== 'active') return;
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync("UPDATE debts SET status = 'overdue', updated_at = CURRENT_TIMESTAMP WHERE id = ?", debtId);
    await db.runAsync(
      'INSERT INTO debt_history (id, debt_id, type, from_date, occurred_at, note) VALUES (?, ?, ?, ?, ?, ?)',
      makeId(), debtId, 'overdue', row.due_date, now, note ?? 'Отмечено вручную',
    );
  });
}

export async function getCurrencySettings(): Promise<CurrencySettings> {
  const db = await getDatabase();
  const baseRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'base_currency'");
  const updatedRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'currency_rates_updated_at'");
  const sourceRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'currency_rates_source'");
  const autoRow = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'currency_rates_auto_update'");
  const baseCurrency = baseRow?.value ?? 'UZS';
  const rows = await db.getAllAsync<{ currency: string; rate_to_base: number }>('SELECT currency, rate_to_base FROM currency_rates');
  const rates = Object.fromEntries(rows.map((row) => [row.currency, row.rate_to_base]));
  rates[baseCurrency] = 1;
  return { baseCurrency, rates, lastUpdated: updatedRow?.value, source: sourceRow?.value === 'cbu' ? 'cbu' : 'manual', autoUpdate: autoRow?.value !== '0' };
}

export async function saveCurrencySettings(settings: CurrencySettings) {
  const db = await getDatabase();
  await db.withTransactionAsync(async () => {
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('base_currency', ?)", settings.baseCurrency);
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currency_rates_updated_at', ?)", settings.lastUpdated ?? new Date().toISOString());
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currency_rates_source', ?)", settings.source ?? 'manual');
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('currency_rates_auto_update', ?)", settings.autoUpdate === false ? '0' : '1');
    await db.runAsync('DELETE FROM currency_rates');
    for (const [currency, rate] of Object.entries({ ...settings.rates, [settings.baseCurrency]: 1 })) {
      if (Number.isFinite(rate) && rate > 0) await db.runAsync('INSERT INTO currency_rates (currency, rate_to_base) VALUES (?, ?)', currency, rate);
    }
  });
}

export async function listOperations(): Promise<FinancialOperation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; title: string; category: string; amount: number; currency: string;
    account_id: string; date: string; kind: 'income' | 'expense'; source: FinancialOperation['source'];
  }>('SELECT * FROM operations ORDER BY date DESC, created_at DESC');
  return rows.map((row) => ({ id: row.id, title: row.title, category: row.category, amount: row.amount, currency: row.currency, accountId: row.account_id, date: row.date, kind: row.kind, source: row.source }));
}

const monthlyDueDates = (startDate: string, trackingFrom: string, through: string) => {
  const start = parseLocalDate(startDate); const from = parseLocalDate(trackingFrom); const end = parseLocalDate(through);
  if (!start || !from || !end) return [];
  const dates: string[] = [];
  for (let year = from.getFullYear(), month = from.getMonth(); year < end.getFullYear() || (year === end.getFullYear() && month <= end.getMonth()); month += 1) {
    if (month > 11) { year += 1; month = 0; }
    const candidate = new Date(year, month, Math.min(start.getDate(), new Date(year, month + 1, 0).getDate()), 12);
    const iso = toLocalIso(candidate);
    if (iso > trackingFrom && iso <= through && candidate >= start) dates.push(iso);
  }
  return dates;
};

export async function synchronizeInterestPostings(today = localToday()) {
  const db = await getDatabase();
  const accounts = await db.getAllAsync<AccountRow & { interest_tracking_from: string | null }>(
    `SELECT * FROM accounts WHERE rate > 0 AND interest_schedule IS NOT NULL
     AND interest_tracking_from IS NOT NULL`,
  );
  for (const account of accounts) {
    const trackingFrom = account.interest_tracking_from ?? today;
    const finalDate = account.maturity_date && !account.auto_renewal && account.maturity_date < today ? account.maturity_date : today;
    let dates: string[] = [];
    if (account.interest_schedule === 'daily') {
      for (let date = addLocalDays(trackingFrom, 1); date <= finalDate; date = addLocalDays(date, 1)) dates.push(date);
    } else if (account.interest_schedule === 'monthly' && account.start_date) {
      dates = monthlyDueDates(account.start_date, trackingFrom, finalDate);
    } else if (account.interest_schedule === 'maturity' && account.maturity_date && account.maturity_date > trackingFrom) {
      const payoutDate = nextBusinessMonday(account.maturity_date);
      if (payoutDate <= today) dates = [payoutDate];
    }
    let previousDate = trackingFrom; let lastProcessedDate = trackingFrom;
    for (const payoutDate of dates) {
      const source = await db.getFirstAsync<{ balance: number; currency: string }>('SELECT balance, currency FROM accounts WHERE id = ?', account.id);
      if (!source) break;
      const periodDays = account.interest_schedule === 'daily' ? 1 : Math.max(1, daysBetween(parseLocalDate(previousDate)!, parseLocalDate(payoutDate)!));
      const amount = source.balance * ((account.rate ?? 0) / 100) * periodDays / 365;
      const destinationId = account.interest_destination === 'same' ? account.id : account.destination_account_id;
      let creditedAmount = amount; let creditedCurrency = source.currency;
      if (destinationId) {
        const destination = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', destinationId);
        if (!destination) continue;
        creditedCurrency = destination.currency;
        if (destination.currency !== source.currency) {
          const base = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'base_currency'");
          const sourceRate = source.currency === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', source.currency))?.rate_to_base;
          const targetRate = destination.currency === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', destination.currency))?.rate_to_base;
          if (!sourceRate || !targetRate) continue;
          creditedAmount = amount * sourceRate / targetRate;
        }
      }
      await db.withTransactionAsync(async () => {
        const postingId = makeId();
        const inserted = await db.runAsync(
          'INSERT OR IGNORE INTO interest_postings (id, account_id, payout_date, amount, destination_account_id) VALUES (?, ?, ?, ?, ?)',
          postingId, account.id, payoutDate, amount, destinationId ?? null,
        );
        if (!inserted.changes || !destinationId) return;
        const operationId = makeId();
        await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', creditedAmount, destinationId);
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source)
           VALUES (?, ?, 'Проценты', ?, ?, ?, ?, 'income', 'interest')`,
          operationId, `Проценты · ${account.name}`, creditedAmount, creditedCurrency, destinationId, payoutDate,
        );
        await db.runAsync('UPDATE interest_postings SET operation_id = ? WHERE id = ?', operationId, postingId);
      });
      previousDate = payoutDate; lastProcessedDate = payoutDate;
    }
    let effectiveStart = account.start_date;
    let effectiveMaturity = account.maturity_date;
    if (account.auto_renewal && effectiveStart && effectiveMaturity && nextBusinessMonday(effectiveMaturity) <= today) {
      const termDays = Math.max(1, daysBetween(parseLocalDate(effectiveStart)!, parseLocalDate(effectiveMaturity)!));
      do {
        effectiveStart = nextBusinessMonday(effectiveMaturity);
        effectiveMaturity = nextBusinessMonday(addLocalDays(effectiveStart, termDays));
      } while (effectiveMaturity <= today);
      await db.runAsync('UPDATE accounts SET start_date = ?, maturity_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', effectiveStart, effectiveMaturity, account.id);
    }
    const nextTrackingFrom = lastProcessedDate !== trackingFrom ? lastProcessedDate : (account.interest_schedule === 'daily' && !dates.length ? today : trackingFrom);
    const monthlyAnchor = account.next_interest_date ?? effectiveStart;
    const automaticNext = account.interest_schedule === 'monthly' && monthlyAnchor ? nextMonthlyDate(monthlyAnchor, today) : null;
    await db.runAsync('UPDATE accounts SET interest_tracking_from = ?, next_interest_date = COALESCE(?, next_interest_date), updated_at = CURRENT_TIMESTAMP WHERE id = ?', nextTrackingFrom, automaticNext ?? null, account.id);
  }
}

export async function createOperation(input: FinancialOperationInput) {
  const db = await getDatabase();
  const id = makeId();
  const delta = input.kind === 'income' ? input.amount : -input.amount;
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
      id, input.title, input.category, input.amount, input.currency, input.accountId, input.date, input.kind,
    );
    await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, input.accountId);
  });
  return id;
}

export async function listBudgets(): Promise<Budget[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; category: string; currency: string; limit_amount: number }>('SELECT id, category, currency, limit_amount FROM budgets ORDER BY category ASC');
  return rows.map((row) => ({ id: row.id, category: row.category, currency: row.currency, limit: row.limit_amount }));
}

export async function saveBudget(input: BudgetInput, id?: string) {
  const db = await getDatabase();
  if (id) {
    await db.runAsync('UPDATE budgets SET category = ?, currency = ?, limit_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', input.category, input.currency, input.limit, id);
    return id;
  }
  const budgetId = makeId();
  await db.runAsync('INSERT INTO budgets (id, category, currency, limit_amount) VALUES (?, ?, ?, ?)', budgetId, input.category, input.currency, input.limit);
  return budgetId;
}

export async function deleteBudget(id: string) {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM budgets WHERE id = ?', id);
}

export async function listFinancialGoals(): Promise<FinancialGoal[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; title: string; type: GoalType; target: number; currency: string;
    deadline: string; account_id: string | null; debt_id: string | null;
  }>('SELECT id, title, type, target, currency, deadline, account_id, debt_id FROM financial_goals ORDER BY deadline ASC');
  return rows.map((row) => ({ id: row.id, title: row.title, type: row.type, target: row.target, currency: row.currency, deadline: row.deadline, accountId: row.account_id ?? undefined, debtId: row.debt_id ?? undefined }));
}

export async function saveFinancialGoal(input: FinancialGoalInput, id?: string) {
  const db = await getDatabase();
  if (id) {
    await db.runAsync(
      'UPDATE financial_goals SET title = ?, type = ?, target = ?, currency = ?, deadline = ?, account_id = ?, debt_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      input.title, input.type, input.target, input.currency, input.deadline, input.accountId ?? null, input.debtId ?? null, id,
    );
    return id;
  }
  const goalId = makeId();
  await db.runAsync(
    'INSERT INTO financial_goals (id, title, type, target, currency, deadline, account_id, debt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    goalId, input.title, input.type, input.target, input.currency, input.deadline, input.accountId ?? null, input.debtId ?? null,
  );
  return goalId;
}

export async function deleteFinancialGoal(id: string) {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM financial_goals WHERE id = ?', id);
}
