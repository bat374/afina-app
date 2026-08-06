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
  to_date: string | null; occurred_at: string; note: string | null; operation_id: string | null;
  related_history_id: string | null;
};

export type DebtInput = Omit<Debt, 'id' | 'currentBalance' | 'status'>;
export type FinancialOperationInput = Omit<FinancialOperation, 'id' | 'source'>;
export type BudgetInput = Omit<Budget, 'id'>;
export type FinancialGoalInput = Omit<FinancialGoal, 'id'>;

export type LocalSnapshot = {
  schemaVersion: 1;
  exportedAt: string;
  accounts: Account[];
  scheduledFlows: PlannedExpense[];
  debts: Debt[];
  debtHistory: DebtHistory[];
  operations: FinancialOperation[];
  budgets: Budget[];
  goals: FinancialGoal[];
  currencySettings: CurrencySettings;
};

let database: Promise<SQLite.SQLiteDatabase> | null = null;

const getDatabase = () => {
  if (!database) database = SQLite.openDatabaseAsync('afina.db');
  return database;
};

// expo-sqlite's native bridge is not safe for concurrent calls on the same connection:
// overlapping runAsync/getAllAsync calls can corrupt each other's prepared statements
// (surfaces as "NativeDatabase.prepareAsync ... SharedObject doesn't contain valid id").
// Every exported function below is routed through this queue so only one runs at a time.
// Functions that call other database helpers internally (listDebts, exportLocalSnapshot) call
// the *Core variants directly instead of the enqueued exports, to avoid deadlocking the queue.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function initializeDatabaseCore() {
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
      type TEXT NOT NULL CHECK(type IN ('created', 'edited', 'payment', 'early_payment', 'payment_reversed', 'extension', 'overdue')),
      amount REAL,
      from_date TEXT,
      to_date TEXT,
      occurred_at TEXT NOT NULL,
      note TEXT,
      operation_id TEXT,
      related_history_id TEXT,
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
      source TEXT NOT NULL CHECK(source IN ('manual', 'debt', 'interest', 'sms', 'receipt')),
      debt_id TEXT,
      related_operation_id TEXT,
      account_amount REAL,
      account_currency TEXT,
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted', 'reversed')),
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
  const operationColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(operations)');
  const operationExtras = [
    ['debt_id', 'TEXT'], ['related_operation_id', 'TEXT'], ['account_amount', 'REAL'],
    ['account_currency', 'TEXT'], ["status", "TEXT NOT NULL DEFAULT 'posted'"],
  ] as const;
  for (const [name, sqlType] of operationExtras) {
    if (!operationColumns.some((column) => column.name === name)) await db.execAsync(`ALTER TABLE operations ADD COLUMN ${name} ${sqlType};`);
  }
  const debtHistorySql = await db.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'debt_history'");
  if (debtHistorySql?.sql && !debtHistorySql.sql.includes("'payment_reversed'")) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE debt_history_v2 (
        id TEXT PRIMARY KEY NOT NULL, debt_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('created', 'edited', 'payment', 'early_payment', 'payment_reversed', 'extension', 'overdue')),
        amount REAL, from_date TEXT, to_date TEXT, occurred_at TEXT NOT NULL, note TEXT,
        operation_id TEXT, related_history_id TEXT,
        FOREIGN KEY(debt_id) REFERENCES debts(id) ON DELETE CASCADE
      );
      INSERT INTO debt_history_v2 (id, debt_id, type, amount, from_date, to_date, occurred_at, note)
        SELECT id, debt_id, type, amount, from_date, to_date, occurred_at, note FROM debt_history;
      DROP TABLE debt_history;
      ALTER TABLE debt_history_v2 RENAME TO debt_history;
      COMMIT;
    `);
  }
  await db.execAsync('PRAGMA user_version = 5;');
}

export function initializeDatabase() {
  return enqueue(initializeDatabaseCore);
}

async function listAccountsCore(): Promise<Account[]> {
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

export function listAccounts(): Promise<Account[]> {
  return enqueue(listAccountsCore);
}

export function saveAccount(input: AccountInput, id?: string) {
  return enqueue(async () => {
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
  });
}

export function deleteAccount(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM accounts WHERE id = ?', id);
  });
}

async function listPlannedExpensesCore(): Promise<PlannedExpense[]> {
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

export function listPlannedExpenses(): Promise<PlannedExpense[]> {
  return enqueue(listPlannedExpensesCore);
}

export function savePlannedExpense(input: PlannedExpenseInput, id?: string) {
  return enqueue(async () => {
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
  });
}

export function deletePlannedExpense(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM scheduled_flows WHERE id = ?', id);
  });
}

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const mapDebt = (row: DebtRow): Debt => ({
  id: row.id, person: row.person, title: row.title, direction: row.direction,
  originalAmount: row.original_amount, currentBalance: row.current_balance, currency: row.currency,
  accountId: row.account_id ?? undefined, startDate: row.start_date, dueDate: row.due_date,
  status: row.status, note: row.note ?? undefined,
});

async function synchronizeOverdueDebtsCore(today = localToday()) {
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

export function synchronizeOverdueDebts(today = localToday()) {
  return enqueue(() => synchronizeOverdueDebtsCore(today));
}

async function listDebtsCore(): Promise<Debt[]> {
  await synchronizeOverdueDebtsCore();
  const db = await getDatabase();
  const rows = await db.getAllAsync<DebtRow>("SELECT * FROM debts ORDER BY CASE status WHEN 'overdue' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, due_date ASC");
  return rows.map(mapDebt);
}

export function listDebts(): Promise<Debt[]> {
  return enqueue(listDebtsCore);
}

export function createDebt(input: DebtInput) {
  return enqueue(async () => {
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
  });
}

const DEBT_DIRECTION_LABEL: Record<DebtDirection, string> = { owed_to_me: 'Мне должны', i_owe: 'Я должна' };

async function describeDebtChanges(db: SQLite.SQLiteDatabase, row: DebtRow, input: DebtInput, nextBalance: number): Promise<string> {
  const changes: string[] = [];
  if (row.person !== input.person) changes.push(`Кто: «${row.person}» → «${input.person}»`);
  if (row.title !== input.title) changes.push(`Название: «${row.title}» → «${input.title}»`);
  if (row.direction !== input.direction) changes.push(`Направление: ${DEBT_DIRECTION_LABEL[row.direction]} → ${DEBT_DIRECTION_LABEL[input.direction]}`);
  if (row.original_amount !== input.originalAmount || row.currency !== input.currency) {
    changes.push(`Сумма: ${row.original_amount} ${row.currency} → ${input.originalAmount} ${input.currency}`);
  }
  if (Math.abs(row.current_balance - nextBalance) > 0.000001) changes.push(`Остаток: ${row.current_balance} → ${nextBalance}`);
  if ((row.account_id ?? null) !== (input.accountId ?? null)) {
    const ids = [row.account_id, input.accountId].filter((value): value is string => !!value);
    const names = ids.length
      ? await db.getAllAsync<{ id: string; name: string }>(`SELECT id, name FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
      : [];
    const nameOf = (accountId?: string | null) => accountId ? names.find((account) => account.id === accountId)?.name ?? accountId : 'без счёта';
    changes.push(`Счёт: ${nameOf(row.account_id)} → ${nameOf(input.accountId)}`);
  }
  if (row.start_date !== input.startDate) changes.push(`Начало: ${row.start_date} → ${input.startDate}`);
  if (row.due_date !== input.dueDate) changes.push(`Срок: ${row.due_date} → ${input.dueDate}`);
  if ((row.note ?? '') !== (input.note ?? '')) changes.push('Комментарий изменён');
  return changes.length ? `Изменены условия долга: ${changes.join('; ')}` : 'Условия сохранены без изменений';
}

export function updateDebt(id: string, input: DebtInput) {
  return enqueue(async () => {
    const db = await getDatabase();
    const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', id);
    if (!row) throw new Error('Debt not found');
    const paidPart = Math.max(0, row.original_amount - row.current_balance);
    const currentBalance = Math.max(0, input.originalAmount - paidPart);
    const nextStatus: DebtStatus = currentBalance < 0.000001 ? 'paid' : row.status === 'paid' ? 'active' : row.status;
    const changeNote = await describeDebtChanges(db, row, input, currentBalance);
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `UPDATE debts SET person = ?, title = ?, direction = ?, original_amount = ?, current_balance = ?, status = ?,
       currency = ?, account_id = ?, start_date = ?, due_date = ?, note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        input.person, input.title, input.direction, input.originalAmount, currentBalance, nextStatus, input.currency,
        input.accountId ?? null, input.startDate, input.dueDate, input.note ?? null, id,
      );
      await db.runAsync(
        'INSERT INTO debt_history (id, debt_id, type, occurred_at, note) VALUES (?, ?, ?, ?, ?)',
        makeId(), id, 'edited', new Date().toISOString(), changeNote,
      );
    });
  });
}

async function listDebtHistoryCore(debtId: string): Promise<DebtHistory[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<DebtHistoryRow>('SELECT * FROM debt_history WHERE debt_id = ? ORDER BY occurred_at DESC', debtId);
  return rows.map((row) => ({
    id: row.id, debtId: row.debt_id, type: row.type, amount: row.amount ?? undefined,
    fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined,
    occurredAt: row.occurred_at, note: row.note ?? undefined, operationId: row.operation_id ?? undefined,
    relatedHistoryId: row.related_history_id ?? undefined,
  }));
}

export function listDebtHistory(debtId: string): Promise<DebtHistory[]> {
  return enqueue(() => listDebtHistoryCore(debtId));
}

const convertUsingStoredRates = async (db: SQLite.SQLiteDatabase, amount: number, from: string, to: string) => {
  if (from === to) return amount;
  const base = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'base_currency'");
  const source = from === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', from))?.rate_to_base;
  const target = to === base?.value ? 1 : (await db.getFirstAsync<{ rate_to_base: number }>('SELECT rate_to_base FROM currency_rates WHERE currency = ?', to))?.rate_to_base;
  if (!source || !target) throw new Error(`Нет курса ${from}/${to}`);
  return amount * source / target;
};

export function recordDebtPayment(debtId: string, requestedAmount: number, paymentDate: string, accountId?: string | null, exchangeRate?: number, note?: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    const row = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', debtId);
    if (!row) throw new Error('Debt not found');
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) throw new Error('Сумма погашения должна быть больше нуля');
    if (requestedAmount > row.current_balance + 0.000001) throw new Error('Сумма погашения больше остатка долга');
    const amount = requestedAmount;
    const balance = Math.max(0, row.current_balance - amount);
    const paid = balance < 0.000001;
    const historyType: DebtHistoryType = paid && paymentDate < row.due_date ? 'early_payment' : 'payment';
    const selectedAccountId = accountId === undefined ? row.account_id : accountId;
    await db.withTransactionAsync(async () => {
      await db.runAsync("UPDATE debts SET current_balance = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", balance, paid ? 'paid' : row.status, debtId);
      let operationId: string | undefined;
      if (selectedAccountId) {
        const account = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', selectedAccountId);
        if (!account) throw new Error('Счёт погашения не найден');
        const accountAmount = exchangeRate && exchangeRate > 0
          ? amount * exchangeRate
          : await convertUsingStoredRates(db, amount, row.currency, account.currency);
        const delta = row.direction === 'owed_to_me' ? accountAmount : -accountAmount;
        await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, selectedAccountId);
        operationId = makeId();
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source,
          debt_id, account_amount, account_currency, status)
         VALUES (?, ?, 'Долги', ?, ?, ?, ?, ?, 'debt', ?, ?, ?, 'posted')`,
          operationId, `${row.direction === 'owed_to_me' ? 'Возврат долга' : 'Погашение долга'} · ${row.person}`,
          amount, row.currency, selectedAccountId, paymentDate, row.direction === 'owed_to_me' ? 'income' : 'expense',
          debtId, accountAmount, account.currency,
        );
      }
      await db.runAsync(
        'INSERT INTO debt_history (id, debt_id, type, amount, occurred_at, note, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        makeId(), debtId, historyType, amount, `${paymentDate}T12:00:00.000Z`, note ?? null, operationId ?? null,
      );
    });
  });
}

export function reverseDebtPayment(debtId: string, historyId: string, fallbackAccountId?: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    const debt = await db.getFirstAsync<DebtRow>('SELECT * FROM debts WHERE id = ?', debtId);
    const history = await db.getFirstAsync<DebtHistoryRow>('SELECT * FROM debt_history WHERE id = ? AND debt_id = ?', historyId, debtId);
    if (!debt || !history || !['payment', 'early_payment'].includes(history.type) || !history.amount) throw new Error('Погашение не найдено');
    const alreadyReversed = await db.getFirstAsync<{ id: string }>("SELECT id FROM debt_history WHERE related_history_id = ? AND type = 'payment_reversed'", historyId);
    if (alreadyReversed) throw new Error('Это погашение уже отменено');
    const operation = history.operation_id ? await db.getFirstAsync<{
      id: string; account_id: string; account_amount: number | null; account_currency: string | null;
      kind: 'income' | 'expense'; status: 'posted' | 'reversed'; date: string;
    }>('SELECT * FROM operations WHERE id = ?', history.operation_id) : null;
    const accountId = operation?.account_id ?? fallbackAccountId;
    await db.withTransactionAsync(async () => {
      const restored = Math.min(debt.original_amount, debt.current_balance + history.amount!);
      const status: DebtStatus = debt.due_date < localToday() ? 'overdue' : 'active';
      await db.runAsync('UPDATE debts SET current_balance = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', restored, status, debtId);
      let reversalOperationId: string | undefined;
      if (accountId) {
        const account = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', accountId);
        if (!account) throw new Error('Счёт исходного погашения не найден');
        const accountAmount = operation?.account_amount ?? await convertUsingStoredRates(db, history.amount!, debt.currency, account.currency);
        const originalKind = operation?.kind ?? (debt.direction === 'owed_to_me' ? 'income' : 'expense');
        const reverseKind = originalKind === 'income' ? 'expense' : 'income';
        const delta = reverseKind === 'income' ? accountAmount : -accountAmount;
        await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, accountId);
        reversalOperationId = makeId();
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source,
          debt_id, related_operation_id, account_amount, account_currency, status)
         VALUES (?, ?, 'Долги', ?, ?, ?, ?, ?, 'debt', ?, ?, ?, ?, 'posted')`,
          reversalOperationId, `Отмена погашения · ${debt.person}`, history.amount, debt.currency, accountId,
          localToday(), reverseKind, debtId, operation?.id ?? null, accountAmount, account.currency,
        );
        if (operation) await db.runAsync("UPDATE operations SET status = 'reversed' WHERE id = ?", operation.id);
      }
      await db.runAsync(
        `INSERT INTO debt_history (id, debt_id, type, amount, occurred_at, note, operation_id, related_history_id)
       VALUES (?, ?, 'payment_reversed', ?, ?, ?, ?, ?)`,
        makeId(), debtId, history.amount, new Date().toISOString(), 'Ошибочное погашение отменено', reversalOperationId ?? null, historyId,
      );
    });
  });
}

export function extendDebt(debtId: string, newDueDate: string, note?: string) {
  return enqueue(async () => {
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
  });
}

export function markDebtOverdue(debtId: string, note?: string) {
  return enqueue(async () => {
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
  });
}

async function getCurrencySettingsCore(): Promise<CurrencySettings> {
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

export function getCurrencySettings(): Promise<CurrencySettings> {
  return enqueue(getCurrencySettingsCore);
}

export function saveCurrencySettings(settings: CurrencySettings) {
  return enqueue(async () => {
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
  });
}

async function listOperationsCore(): Promise<FinancialOperation[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; title: string; category: string; amount: number; currency: string;
    account_id: string; date: string; kind: 'income' | 'expense'; source: FinancialOperation['source'];
    debt_id: string | null; related_operation_id: string | null; account_amount: number | null;
    account_currency: string | null; status: 'posted' | 'reversed' | null;
  }>('SELECT * FROM operations ORDER BY date DESC, created_at DESC');
  return rows.map((row) => ({
    id: row.id, title: row.title, category: row.category, amount: row.amount, currency: row.currency,
    accountId: row.account_id, date: row.date, kind: row.kind, source: row.source,
    debtId: row.debt_id ?? undefined, relatedOperationId: row.related_operation_id ?? undefined,
    accountAmount: row.account_amount ?? undefined, accountCurrency: row.account_currency ?? undefined,
    status: row.status ?? 'posted',
  }));
}

export function listOperations(): Promise<FinancialOperation[]> {
  return enqueue(listOperationsCore);
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

export function synchronizeInterestPostings(today = localToday()) {
  return enqueue(async () => {
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
  });
}

export function createOperation(input: FinancialOperationInput) {
  return enqueue(async () => {
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
  });
}

async function listBudgetsCore(): Promise<Budget[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; category: string; currency: string; limit_amount: number }>('SELECT id, category, currency, limit_amount FROM budgets ORDER BY category ASC');
  return rows.map((row) => ({ id: row.id, category: row.category, currency: row.currency, limit: row.limit_amount }));
}

export function listBudgets(): Promise<Budget[]> {
  return enqueue(listBudgetsCore);
}

export function saveBudget(input: BudgetInput, id?: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    if (id) {
      await db.runAsync('UPDATE budgets SET category = ?, currency = ?, limit_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', input.category, input.currency, input.limit, id);
      return id;
    }
    const budgetId = makeId();
    await db.runAsync('INSERT INTO budgets (id, category, currency, limit_amount) VALUES (?, ?, ?, ?)', budgetId, input.category, input.currency, input.limit);
    return budgetId;
  });
}

export function deleteBudget(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM budgets WHERE id = ?', id);
  });
}

async function listFinancialGoalsCore(): Promise<FinancialGoal[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{
    id: string; title: string; type: GoalType; target: number; currency: string;
    deadline: string; account_id: string | null; debt_id: string | null;
  }>('SELECT id, title, type, target, currency, deadline, account_id, debt_id FROM financial_goals ORDER BY deadline ASC');
  return rows.map((row) => ({ id: row.id, title: row.title, type: row.type, target: row.target, currency: row.currency, deadline: row.deadline, accountId: row.account_id ?? undefined, debtId: row.debt_id ?? undefined }));
}

export function listFinancialGoals(): Promise<FinancialGoal[]> {
  return enqueue(listFinancialGoalsCore);
}

export function saveFinancialGoal(input: FinancialGoalInput, id?: string) {
  return enqueue(async () => {
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
  });
}

export function deleteFinancialGoal(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync('DELETE FROM financial_goals WHERE id = ?', id);
  });
}

export function exportLocalSnapshot(): Promise<LocalSnapshot> {
  return enqueue(async () => {
    // Sequential, not Promise.all: these Core calls share the single SQLite connection,
    // and running them concurrently is exactly the race that corrupts native statements.
    const accounts = await listAccountsCore();
    const scheduledFlows = await listPlannedExpensesCore();
    const debts = await listDebtsCore();
    const operations = await listOperationsCore();
    const budgets = await listBudgetsCore();
    const goals = await listFinancialGoalsCore();
    const currencySettings = await getCurrencySettingsCore();
    const debtHistory: DebtHistory[] = [];
    for (const debt of debts) debtHistory.push(...(await listDebtHistoryCore(debt.id)));
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      accounts,
      scheduledFlows,
      debts,
      debtHistory,
      operations,
      budgets,
      goals,
      currencySettings,
    };
  });
}

export function getLinkedCloudUserId() {
  return enqueue(async () => {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'cloud_user_id'");
    return row?.value;
  });
}

export function setLinkedCloudUserId(userId: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('cloud_user_id', ?)", userId);
  });
}

export function replaceLocalSnapshot(snapshot: LocalSnapshot) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
      DELETE FROM debt_history;
      DELETE FROM interest_postings;
      DELETE FROM operations;
      DELETE FROM scheduled_flows;
      DELETE FROM planned_expenses;
      DELETE FROM financial_goals;
      DELETE FROM budgets;
      DELETE FROM debts;
      DELETE FROM accounts;
      DELETE FROM currency_rates;
    `);
      for (const account of snapshot.accounts) {
        await db.runAsync(
          `INSERT INTO accounts (id, name, subtitle, type, balance, currency, rate, rate_caption,
          start_date, maturity_date, interest_schedule, interest_destination, destination_account_id,
          next_interest_date, auto_renewal, rate_review_reminder, withdrawal_policy, minimum_balance,
          replenishment_allowed, credit_limit, statement_day, payment_due_day, grace_period_days,
          minimum_payment_percent, accent, interest_tracking_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          account.id, account.name, account.subtitle, account.type === 'credit_card' ? 'card' : account.type,
          account.balance, account.currency, account.rate ?? null, account.rateCaption ?? null,
          account.startDate ?? null, account.maturityDate ?? null, account.interestSchedule ?? null,
          account.interestDestination ?? null, account.destinationAccountId ?? null,
          account.nextInterestDate ?? null, account.autoRenewal ? 1 : 0,
          account.rateReviewReminder === false ? 0 : 1, account.withdrawalPolicy ?? null,
          account.minimumBalance ?? null, account.replenishmentAllowed === undefined ? null : account.replenishmentAllowed ? 1 : 0,
          account.creditLimit ?? null, account.statementDay ?? null, account.paymentDueDay ?? null,
          account.gracePeriodDays ?? null, account.minimumPaymentPercent ?? null, account.accent,
          account.startDate ?? localToday(),
        );
      }
      for (const flow of snapshot.scheduledFlows) {
        await db.runAsync(
          `INSERT INTO scheduled_flows (id, title, category, amount, currency, account_id, start_date,
          end_date, repeat_rule, kind, repeat_interval, repeat_unit, weekdays, exchange_rate, source_transaction_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          flow.id, flow.title, flow.category, flow.amount, flow.currency, flow.accountId ?? null,
          flow.startDate, flow.endDate ?? null, flow.repeat, flow.kind, flow.repeatInterval ?? 1,
          flow.repeatUnit ?? null, flow.weekdays ? JSON.stringify(flow.weekdays) : null,
          flow.exchangeRate ?? null, flow.sourceTransactionId ?? null,
        );
      }
      for (const debt of snapshot.debts) {
        await db.runAsync(
          `INSERT INTO debts (id, person, title, direction, original_amount, current_balance, currency,
          account_id, start_date, due_date, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          debt.id, debt.person, debt.title, debt.direction, debt.originalAmount, debt.currentBalance,
          debt.currency, debt.accountId ?? null, debt.startDate, debt.dueDate, debt.status, debt.note ?? null,
        );
      }
      for (const operation of snapshot.operations) {
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source,
          debt_id, related_operation_id, account_amount, account_currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          operation.id, operation.title, operation.category, operation.amount, operation.currency,
          operation.accountId, operation.date, operation.kind, operation.source, operation.debtId ?? null,
          operation.relatedOperationId ?? null, operation.accountAmount ?? null,
          operation.accountCurrency ?? null, operation.status ?? 'posted',
        );
      }
      for (const event of snapshot.debtHistory) {
        await db.runAsync(
          `INSERT INTO debt_history (id, debt_id, type, amount, from_date, to_date, occurred_at, note,
          operation_id, related_history_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          event.id, event.debtId, event.type, event.amount ?? null, event.fromDate ?? null,
          event.toDate ?? null, event.occurredAt, event.note ?? null, event.operationId ?? null,
          event.relatedHistoryId ?? null,
        );
      }
      for (const budget of snapshot.budgets) {
        await db.runAsync('INSERT INTO budgets (id, category, currency, limit_amount) VALUES (?, ?, ?, ?)',
          budget.id, budget.category, budget.currency, budget.limit);
      }
      for (const goal of snapshot.goals) {
        await db.runAsync(
          'INSERT INTO financial_goals (id, title, type, target, currency, deadline, account_id, debt_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          goal.id, goal.title, goal.type, goal.target, goal.currency, goal.deadline,
          goal.accountId ?? null, goal.debtId ?? null,
        );
      }
      await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('base_currency', ?)", snapshot.currencySettings.baseCurrency);
      await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('rates_last_updated', ?)", snapshot.currencySettings.lastUpdated ?? '');
      await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('rates_source', ?)", snapshot.currencySettings.source ?? 'manual');
      await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('rates_auto_update', ?)", snapshot.currencySettings.autoUpdate === false ? '0' : '1');
      for (const [currency, rate] of Object.entries(snapshot.currencySettings.rates)) {
        await db.runAsync('INSERT INTO currency_rates (currency, rate_to_base) VALUES (?, ?)', currency, rate);
      }
    });
  });
}
