import * as SQLite from 'expo-sqlite';
import { Account, AccountType, Budget, CashFlowKind, CurrencySettings, Debt, DebtDirection, DebtHistory, DebtHistoryType, DebtStatus, ExpenseRepeat, FinancialGoal, FinancialOperation, GoalType, ImportDraft, ImportDraftSource, InterestDestination, InterestPosting, InterestSchedule, PlannedExecutionInput, PlannedExpense, PlannedOccurrence, PlannedOccurrenceStatus, RecurrenceUnit, Transfer, TransferInput, WithdrawalPolicy } from './types';
import { addLocalDays, daysBetween, localToday, nextBusinessMonday, nextMonthlyDate, parseLocalDate, previousMonthlyDate, toLocalIso } from './date';
import { occursOn } from './recurrence';
import { ParsedSms } from './sms/types';
import { hashString } from './sms/hash';

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
  card_last4: string | null;
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
  occurrences_tracking_from: string | null;
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
  interestPostings: InterestPosting[];
  transfers: Transfer[];
  plannedOccurrences: PlannedOccurrence[];
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
      occurrences_tracking_from TEXT,
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
      source TEXT NOT NULL CHECK(source IN ('manual', 'debt', 'interest', 'sms', 'receipt', 'push')),
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
      include_other_currencies INTEGER,
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
    CREATE TABLE IF NOT EXISTS transfers (
      id TEXT PRIMARY KEY NOT NULL,
      from_account_id TEXT NOT NULL,
      to_account_id TEXT NOT NULL,
      from_amount REAL NOT NULL CHECK(from_amount > 0),
      from_currency TEXT NOT NULL,
      to_amount REAL NOT NULL CHECK(to_amount > 0),
      to_currency TEXT NOT NULL,
      exchange_rate REAL,
      note TEXT,
      date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted', 'reversed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS planned_occurrences (
      id TEXT PRIMARY KEY NOT NULL,
      flow_id TEXT NOT NULL,
      occurrence_date TEXT NOT NULL,
      amount REAL NOT NULL CHECK(amount > 0),
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'completed', 'cancelled')),
      operation_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(flow_id, occurrence_date)
    );
    CREATE TABLE IF NOT EXISTS sms_drafts (
      id TEXT PRIMARY KEY NOT NULL,
      source TEXT NOT NULL DEFAULT 'sms' CHECK(source IN ('sms', 'push')),
      sender TEXT NOT NULL,
      parser_id TEXT,
      raw_body TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      received_at TEXT NOT NULL,
      occurred_at TEXT,
      amount REAL CHECK(amount IS NULL OR amount > 0),
      currency TEXT,
      kind TEXT CHECK(kind IN ('income', 'expense')),
      fee_amount REAL,
      card_last4 TEXT,
      account_id TEXT,
      merchant TEXT,
      balance_after REAL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'unrecognized', 'confirmed', 'dismissed')),
      operation_id TEXT,
      dedup_operation_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sender, body_hash)
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
    ['grace_period_days', 'INTEGER'], ['minimum_payment_percent', 'REAL'], ['card_last4', 'TEXT'],
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
    ['source_occurrence_id', 'TEXT'], ['planned_amount', 'REAL'], ['planned_currency', 'TEXT'],
    ['interest_source_account_id', 'TEXT'], ['receipt_photo_uri', 'TEXT'],
  ] as const;
  for (const [name, sqlType] of operationExtras) {
    if (!operationColumns.some((column) => column.name === name)) await db.execAsync(`ALTER TABLE operations ADD COLUMN ${name} ${sqlType};`);
  }
  // Adds 'push' to operations.source's CHECK — SQLite can't ALTER a CHECK, so this rebuilds the
  // table the same way the 'interest' addition above did. Runs after operationExtras so every
  // ALTER-added column already exists to be explicitly selected across (not relying on positional
  // SELECT * column order, which depends on ALTER TABLE's append order and is easy to get wrong).
  const operationSqlForPush = await db.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operations'");
  if (operationSqlForPush?.sql && !operationSqlForPush.sql.includes("'push'")) {
    await db.execAsync(`
      BEGIN;
      CREATE TABLE operations_v3 (
        id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount > 0), currency TEXT NOT NULL, account_id TEXT NOT NULL,
        date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('income', 'expense')),
        source TEXT NOT NULL CHECK(source IN ('manual', 'debt', 'interest', 'sms', 'receipt', 'push')),
        debt_id TEXT, related_operation_id TEXT, account_amount REAL, account_currency TEXT,
        status TEXT NOT NULL DEFAULT 'posted' CHECK(status IN ('posted', 'reversed')),
        source_occurrence_id TEXT, planned_amount REAL, planned_currency TEXT,
        interest_source_account_id TEXT, receipt_photo_uri TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO operations_v3 (
        id, title, category, amount, currency, account_id, date, kind, source, debt_id,
        related_operation_id, account_amount, account_currency, status, source_occurrence_id,
        planned_amount, planned_currency, interest_source_account_id, receipt_photo_uri, created_at
      )
      SELECT
        id, title, category, amount, currency, account_id, date, kind, source, debt_id,
        related_operation_id, account_amount, account_currency, status, source_occurrence_id,
        planned_amount, planned_currency, interest_source_account_id, receipt_photo_uri, created_at
      FROM operations;
      DROP TABLE operations;
      ALTER TABLE operations_v3 RENAME TO operations;
      COMMIT;
    `);
  }
  const smsDraftColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(sms_drafts)');
  // No CHECK on this ALTER — SQLite's ADD COLUMN doesn't take one the way CREATE TABLE does;
  // validity of 'sms' | 'push' is enforced in TypeScript instead (ImportDraftSource).
  if (!smsDraftColumns.some((column) => column.name === 'source')) await db.execAsync("ALTER TABLE sms_drafts ADD COLUMN source TEXT NOT NULL DEFAULT 'sms';");
  const flowColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(scheduled_flows)');
  if (!flowColumns.some((column) => column.name === 'occurrences_tracking_from')) {
    await db.execAsync('ALTER TABLE scheduled_flows ADD COLUMN occurrences_tracking_from TEXT;');
    // One day before start_date, so the sync loop (which starts at trackingFrom + 1 day) evaluates
    // start_date itself on the very first run instead of skipping it.
    await db.execAsync("UPDATE scheduled_flows SET occurrences_tracking_from = date(start_date, '-1 day') WHERE occurrences_tracking_from IS NULL;");
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
  const repairFlag = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'repair_v1_orphan_interest_postings'");
  if (!repairFlag) {
    // Older builds could write an interest_postings row (blocked only from crediting money) before
    // realizing the destination account was missing — see synchronizeInterestPostings. Such orphans
    // (no operation was ever created, no destination was ever resolved) block that period forever via
    // UNIQUE(account_id, payout_date). Clear them once so the period becomes retryable; rows that did
    // result in a real operation are left untouched.
    await db.withTransactionAsync(async () => {
      const affectedAccountIds = (await db.getAllAsync<{ account_id: string }>(
        'SELECT DISTINCT account_id FROM interest_postings WHERE operation_id IS NULL AND destination_account_id IS NULL',
      )).map((row) => row.account_id);
      await db.runAsync('DELETE FROM interest_postings WHERE operation_id IS NULL AND destination_account_id IS NULL');
      for (const accountId of affectedAccountIds) {
        const account = await db.getFirstAsync<{ start_date: string | null; interest_tracking_from: string | null }>(
          'SELECT start_date, interest_tracking_from FROM accounts WHERE id = ?', accountId,
        );
        if (!account) continue;
        const remainingMax = (await db.getFirstAsync<{ max_payout: string | null }>(
          'SELECT MAX(payout_date) as max_payout FROM interest_postings WHERE account_id = ?', accountId,
        ))?.max_payout;
        // Never fall back to start_date here: the legacy bug advanced interest_tracking_from past
        // every date it processed regardless of whether it actually credited money, so the current
        // (pre-repair) cursor is already at or beyond the last real posting. Resetting to start_date
        // for an account with zero surviving postings would re-accrue its entire history on top of
        // an already-current balance — real money duplication, worse than the narrow "one orphaned
        // period between two credited ones can't be retried" limitation this leaves in place.
        const restoredTrackingFrom = remainingMax ?? account.interest_tracking_from ?? account.start_date;
        await db.runAsync('UPDATE accounts SET interest_tracking_from = ? WHERE id = ?', restoredTrackingFrom, accountId);
      }
      await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('repair_v1_orphan_interest_postings', '1')");
    });
  }
  const goalColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(financial_goals)');
  if (!goalColumns.some((column) => column.name === 'include_other_currencies')) {
    await db.execAsync('ALTER TABLE financial_goals ADD COLUMN include_other_currencies INTEGER;');
    // Before this fix, a 'balance' goal with no specific account silently converted every
    // account regardless of currency. Preserve that exact number for existing goals rather than
    // changing what they already show — new goals default to "same currency only" (matching what
    // the old UI label claimed but the old code never actually did).
    await db.runAsync("UPDATE financial_goals SET include_other_currencies = 1 WHERE type = 'balance' AND account_id IS NULL");
  }
  const interestSourceRepairFlag = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'repair_v2_backfill_interest_source_account'");
  if (!interestSourceRepairFlag) {
    // interest_source_account_id didn't exist when older interest operations were created, so
    // they still attribute to the receiving account. interest_postings already recorded the
    // actual earning account for every one of them (account_id there is exactly this), linked via
    // operation_id — no guessing needed, just join the fact that was already on hand.
    await db.runAsync(`
      UPDATE operations SET interest_source_account_id = (
        SELECT account_id FROM interest_postings WHERE interest_postings.operation_id = operations.id
      )
      WHERE source = 'interest' AND interest_source_account_id IS NULL
        AND id IN (SELECT operation_id FROM interest_postings WHERE operation_id IS NOT NULL)
    `);
    await db.runAsync("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('repair_v2_backfill_interest_source_account', '1')");
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
    cardLast4: row.card_last4 ?? undefined,
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
       accent = ?, card_last4 = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        input.name, input.subtitle, input.type === 'credit_card' ? 'card' : input.type, input.balance, input.currency,
        input.rate ?? null, input.rateCaption ?? null, input.startDate ?? null, input.maturityDate ?? null,
        input.interestSchedule ?? null, input.interestDestination ?? null, input.destinationAccountId ?? null,
        nextInterestDate ?? null, input.autoRenewal ? 1 : 0, input.rateReviewReminder === false ? 0 : 1,
        input.withdrawalPolicy ?? null, input.minimumBalance ?? null,
        input.replenishmentAllowed === undefined ? null : input.replenishmentAllowed ? 1 : 0,
        input.creditLimit ?? null, input.statementDay ?? null, input.paymentDueDay ?? null,
        input.gracePeriodDays ?? null, input.minimumPaymentPercent ?? null,
        input.accent, input.cardLast4 ?? null, id,
      );
      return id;
    }
    const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await db.runAsync(
      `INSERT INTO accounts (id, name, subtitle, type, balance, currency, rate, rate_caption,
      start_date, maturity_date, interest_schedule, interest_destination, destination_account_id,
      next_interest_date, auto_renewal, rate_review_reminder, withdrawal_policy, minimum_balance,
      replenishment_allowed, credit_limit, statement_day, payment_due_day, grace_period_days,
      minimum_payment_percent, accent, interest_tracking_from, card_last4)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId, input.name, input.subtitle, input.type === 'credit_card' ? 'card' : input.type, input.balance, input.currency,
      input.rate ?? null, input.rateCaption ?? null, input.startDate ?? null, input.maturityDate ?? null,
      input.interestSchedule ?? null, input.interestDestination ?? null, input.destinationAccountId ?? null,
      nextInterestDate ?? null, input.autoRenewal ? 1 : 0, input.rateReviewReminder === false ? 0 : 1,
      input.withdrawalPolicy ?? null, input.minimumBalance ?? null,
      input.replenishmentAllowed === undefined ? null : input.replenishmentAllowed ? 1 : 0,
      input.creditLimit ?? null, input.statementDay ?? null, input.paymentDueDay ?? null,
      input.gracePeriodDays ?? null, input.minimumPaymentPercent ?? null,
      input.accent, trackingFrom, input.cardLast4 ?? null,
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
    occurrencesTrackingFrom: row.occurrences_tracking_from ?? undefined,
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
      // If the plan is backdated (start_date moved earlier than the occurrence cursor already
      // materialized), pull the cursor back too — otherwise synchronizePlannedOccurrencesCore
      // would only ever scan forward from where it already was and silently never generate the
      // now-valid dates in between. Never move the cursor forward here — that would skip dates
      // that still need generating.
      const existing = await db.getFirstAsync<{ occurrences_tracking_from: string | null }>('SELECT occurrences_tracking_from FROM scheduled_flows WHERE id = ?', id);
      const backdatedCursor = addLocalDays(input.startDate, -1);
      const nextCursor = existing?.occurrences_tracking_from && existing.occurrences_tracking_from < backdatedCursor
        ? existing.occurrences_tracking_from
        : backdatedCursor;
      await db.runAsync(
        `UPDATE scheduled_flows SET title = ?, category = ?, amount = ?, currency = ?, account_id = ?,
       start_date = ?, end_date = ?, repeat_rule = ?, kind = ?, repeat_interval = ?, repeat_unit = ?,
       weekdays = ?, exchange_rate = ?, source_transaction_id = ?, occurrences_tracking_from = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        input.title, input.category, input.amount, input.currency, input.accountId ?? null,
        input.startDate, input.endDate ?? null, input.repeat, input.kind, input.repeatInterval ?? 1,
        input.repeatUnit ?? null, input.weekdays?.join(',') ?? null, input.exchangeRate ?? null,
        input.sourceTransactionId ?? null, nextCursor, id,
      );
    } else {
      await db.runAsync(
        `INSERT INTO scheduled_flows (id, title, category, amount, currency, account_id, start_date, end_date,
       repeat_rule, kind, repeat_interval, repeat_unit, weekdays, exchange_rate, source_transaction_id, occurrences_tracking_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        expenseId, input.title, input.category, input.amount, input.currency, input.accountId ?? null,
        input.startDate, input.endDate ?? null, input.repeat, input.kind, input.repeatInterval ?? 1,
        input.repeatUnit ?? null, input.weekdays?.join(',') ?? null, input.exchangeRate ?? null,
        input.sourceTransactionId ?? null, addLocalDays(input.startDate, -1),
      );
    }
    return expenseId;
  });
}

export function deletePlannedExpense(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.withTransactionAsync(async () => {
      await db.runAsync('DELETE FROM planned_occurrences WHERE flow_id = ?', id);
      await db.runAsync('DELETE FROM scheduled_flows WHERE id = ?', id);
    });
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

type TransferRow = {
  id: string; from_account_id: string; to_account_id: string; from_amount: number; from_currency: string;
  to_amount: number; to_currency: string; exchange_rate: number | null; note: string | null; date: string;
  status: 'posted' | 'reversed';
};

const mapTransferRow = (row: TransferRow): Transfer => ({
  id: row.id, fromAccountId: row.from_account_id, toAccountId: row.to_account_id,
  fromAmount: row.from_amount, fromCurrency: row.from_currency, toAmount: row.to_amount, toCurrency: row.to_currency,
  exchangeRate: row.exchange_rate ?? undefined, note: row.note ?? undefined, date: row.date, status: row.status,
});

async function listTransfersCore(): Promise<Transfer[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<TransferRow>('SELECT * FROM transfers ORDER BY date DESC, created_at DESC');
  return rows.map(mapTransferRow);
}

export function listTransfers(): Promise<Transfer[]> {
  return enqueue(listTransfersCore);
}

export function recordTransfer(input: TransferInput) {
  return enqueue(async () => {
    const db = await getDatabase();
    if (input.fromAccountId === input.toAccountId) throw new Error('Счета списания и зачисления должны различаться');
    if (!Number.isFinite(input.fromAmount) || input.fromAmount <= 0) throw new Error('Сумма списания должна быть больше нуля');
    if (!Number.isFinite(input.toAmount) || input.toAmount <= 0) throw new Error('Сумма зачисления должна быть больше нуля');
    const fromAccount = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', input.fromAccountId);
    const toAccount = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', input.toAccountId);
    if (!fromAccount) throw new Error('Счёт списания не найден');
    if (!toAccount) throw new Error('Счёт зачисления не найден');
    const id = makeId();
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE accounts SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', input.fromAmount, input.fromAccountId);
      await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', input.toAmount, input.toAccountId);
      await db.runAsync(
        `INSERT INTO transfers (id, from_account_id, to_account_id, from_amount, from_currency, to_amount, to_currency, exchange_rate, note, date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'posted')`,
        id, input.fromAccountId, input.toAccountId, input.fromAmount, fromAccount.currency, input.toAmount, toAccount.currency,
        input.exchangeRate ?? null, input.note ?? null, input.date,
      );
    });
    return id;
  });
}

export function reverseTransfer(transferId: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    const transfer = await db.getFirstAsync<TransferRow>('SELECT * FROM transfers WHERE id = ?', transferId);
    if (!transfer) throw new Error('Перевод не найден');
    if (transfer.status === 'reversed') throw new Error('Этот перевод уже отменён');
    await db.withTransactionAsync(async () => {
      await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', transfer.from_amount, transfer.from_account_id);
      await db.runAsync('UPDATE accounts SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', transfer.to_amount, transfer.to_account_id);
      await db.runAsync("UPDATE transfers SET status = 'reversed', updated_at = CURRENT_TIMESTAMP WHERE id = ?", transferId);
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
    source_occurrence_id: string | null; planned_amount: number | null; planned_currency: string | null;
    interest_source_account_id: string | null; receipt_photo_uri: string | null;
  }>('SELECT * FROM operations ORDER BY date DESC, created_at DESC');
  return rows.map((row) => ({
    id: row.id, title: row.title, category: row.category, amount: row.amount, currency: row.currency,
    accountId: row.account_id, date: row.date, kind: row.kind, source: row.source,
    debtId: row.debt_id ?? undefined, relatedOperationId: row.related_operation_id ?? undefined,
    accountAmount: row.account_amount ?? undefined, accountCurrency: row.account_currency ?? undefined,
    status: row.status ?? 'posted',
    sourceOccurrenceId: row.source_occurrence_id ?? undefined,
    plannedAmount: row.planned_amount ?? undefined, plannedCurrency: row.planned_currency ?? undefined,
    interestSourceAccountId: row.interest_source_account_id ?? undefined,
    receiptPhotoUri: row.receipt_photo_uri ?? undefined,
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
      // Resolve the destination once, before touching any dates: a period must never be
      // marked processed (interest_postings row + tracking-cursor advance) unless the
      // interest can actually be credited somewhere. Otherwise the UNIQUE(account_id,
      // payout_date) constraint would make that period permanently unrecoverable even
      // after the user fixes the destination.
      const destinationId = account.interest_destination === 'same' ? account.id : account.destination_account_id;
      if (!destinationId) continue;
      const destination = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', destinationId);
      if (!destination) continue;
      const destinationCurrency = destination.currency;

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
      let blocked = false;
      for (const payoutDate of dates) {
        const source = await db.getFirstAsync<{ balance: number; currency: string }>('SELECT balance, currency FROM accounts WHERE id = ?', account.id);
        if (!source) break;
        const periodDays = account.interest_schedule === 'daily' ? 1 : Math.max(1, daysBetween(parseLocalDate(previousDate)!, parseLocalDate(payoutDate)!));
        const amount = source.balance * ((account.rate ?? 0) / 100) * periodDays / 365;
        let creditedAmount: number;
        try {
          creditedAmount = await convertUsingStoredRates(db, amount, source.currency, destinationCurrency);
        } catch {
          // Missing FX rate for this leg: stop here without marking the period processed,
          // so it is retried once the rate is available. Do not touch other accounts.
          blocked = true;
          break;
        }
        await db.withTransactionAsync(async () => {
          const postingId = makeId();
          const inserted = await db.runAsync(
            'INSERT OR IGNORE INTO interest_postings (id, account_id, payout_date, amount, destination_account_id) VALUES (?, ?, ?, ?, ?)',
            postingId, account.id, payoutDate, amount, destinationId,
          );
          if (!inserted.changes) return;
          const operationId = makeId();
          await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', creditedAmount, destinationId);
          await db.runAsync(
            `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source, interest_source_account_id)
           VALUES (?, ?, 'Проценты', ?, ?, ?, ?, 'income', 'interest', ?)`,
            operationId, `Проценты · ${account.name}`, creditedAmount, destinationCurrency, destinationId, payoutDate, account.id,
          );
          await db.runAsync('UPDATE interest_postings SET operation_id = ? WHERE id = ?', operationId, postingId);
        });
        previousDate = payoutDate; lastProcessedDate = payoutDate;
      }
      if (blocked) continue;
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
      // Monthly due-date anchor is always the account's own start_date (see monthlyDueDates),
      // never next_interest_date — that field is display-only and must not drift from it.
      const monthlyAnchor = effectiveStart;
      const automaticNext = account.interest_schedule === 'monthly' && monthlyAnchor ? nextMonthlyDate(monthlyAnchor, today) : null;
      await db.runAsync('UPDATE accounts SET interest_tracking_from = ?, next_interest_date = COALESCE(?, next_interest_date), updated_at = CURRENT_TIMESTAMP WHERE id = ?', nextTrackingFrom, automaticNext ?? null, account.id);
    }
  });
}

type PlannedOccurrenceRow = {
  id: string; flow_id: string; occurrence_date: string; amount: number; currency: string;
  status: PlannedOccurrenceStatus; operation_id: string | null;
};

const mapPlannedOccurrenceRow = (row: PlannedOccurrenceRow): PlannedOccurrence => ({
  id: row.id, flowId: row.flow_id, occurrenceDate: row.occurrence_date, amount: row.amount,
  currency: row.currency, status: row.status, operationId: row.operation_id ?? undefined,
});

// Materializes dated instances of recurring plans into planned_occurrences, backfilling only up to
// `today` (never the future — the live calendar projection already covers upcoming dates, see
// buildMonthProjection) so a status (planned/completed/cancelled) and a link to the resulting
// operation can survive later edits to the recurring rule. Mirrors synchronizeInterestPostings's
// cursor pattern: idempotent, safe to call repeatedly, never revisits an already-processed date.
async function synchronizePlannedOccurrencesCore(today = localToday()) {
  const db = await getDatabase();
  const cursors = await db.getAllAsync<{ id: string; occurrences_tracking_from: string | null; end_date: string | null }>(
    'SELECT id, occurrences_tracking_from, end_date FROM scheduled_flows WHERE occurrences_tracking_from IS NOT NULL',
  );
  if (!cursors.length) return;
  const flows = await listPlannedExpensesCore();
  const flowById = new Map(flows.map((flow) => [flow.id, flow]));
  await db.withTransactionAsync(async () => {
    for (const cursor of cursors) {
      const flow = flowById.get(cursor.id);
      const trackingFrom = cursor.occurrences_tracking_from;
      if (!flow || !trackingFrom) continue;
      const finalDate = cursor.end_date && cursor.end_date < today ? cursor.end_date : today;
      if (finalDate <= trackingFrom) continue;
      for (let date = addLocalDays(trackingFrom, 1); date <= finalDate; date = addLocalDays(date, 1)) {
        const current = parseLocalDate(date);
        // amount/currency are snapshotted from the flow as it exists right now, at generation
        // time — not re-read later — so editing the recurring rule afterward can never change
        // what an already-materialized occurrence says was planned for that date.
        if (current && occursOn(flow, current)) {
          await db.runAsync(
            "INSERT OR IGNORE INTO planned_occurrences (id, flow_id, occurrence_date, amount, currency, status) VALUES (?, ?, ?, ?, ?, 'planned')",
            makeId(), flow.id, date, flow.amount, flow.currency,
          );
        }
      }
      await db.runAsync('UPDATE scheduled_flows SET occurrences_tracking_from = ? WHERE id = ?', finalDate, cursor.id);
    }
  });
}

export function synchronizePlannedOccurrences(today = localToday()) {
  return enqueue(() => synchronizePlannedOccurrencesCore(today));
}

async function listPlannedOccurrencesCore(): Promise<PlannedOccurrence[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<PlannedOccurrenceRow>('SELECT * FROM planned_occurrences ORDER BY occurrence_date DESC');
  return rows.map(mapPlannedOccurrenceRow);
}

export function listPlannedOccurrences(): Promise<PlannedOccurrence[]> {
  return enqueue(listPlannedOccurrencesCore);
}

export function executePlannedOccurrence(occurrenceId: string, input: PlannedExecutionInput) {
  return enqueue(async () => {
    const db = await getDatabase();
    const occurrence = await db.getFirstAsync<PlannedOccurrenceRow>('SELECT * FROM planned_occurrences WHERE id = ?', occurrenceId);
    if (!occurrence) throw new Error('Плановое событие не найдено');
    if (occurrence.status !== 'planned') throw new Error('Событие уже проведено или отменено');
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Сумма должна быть больше нуля');
    const flow = await db.getFirstAsync<{ kind: CashFlowKind }>('SELECT kind FROM scheduled_flows WHERE id = ?', occurrence.flow_id);
    if (!flow) throw new Error('Плановая операция удалена');
    let operationId: string | undefined;
    await db.withTransactionAsync(async () => {
      if (input.accountId) {
        // The fact amount/currency can legitimately differ from the plan's (that's the whole
        // point — e.g. a USD-planned salary actually credited in UZS), but it must never differ
        // from the account it's being posted to: applying a raw number in one currency straight
        // onto a balance denominated in another would silently corrupt that balance. Currency
        // conversion, if ever needed, belongs in the UI forcing a matching currency choice, not
        // here — this is a hard guard against exactly the input the UI is supposed to prevent.
        const account = await db.getFirstAsync<{ currency: string }>('SELECT currency FROM accounts WHERE id = ?', input.accountId);
        if (!account) throw new Error('Счёт не найден');
        if (account.currency !== input.currency) throw new Error('Валюта операции должна совпадать с валютой выбранного счёта');
        operationId = makeId();
        const delta = flow.kind === 'income' ? input.amount : -input.amount;
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source,
           source_occurrence_id, planned_amount, planned_currency)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`,
          operationId, input.title, input.category, input.amount, input.currency, input.accountId,
          input.date, flow.kind, occurrenceId, occurrence.amount, occurrence.currency,
        );
        await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, input.accountId);
      }
      await db.runAsync("UPDATE planned_occurrences SET status = 'completed', operation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", operationId ?? null, occurrenceId);
    });
    return operationId;
  });
}

export function cancelPlannedOccurrence(occurrenceId: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync("UPDATE planned_occurrences SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'planned'", occurrenceId);
  });
}

export function createOperation(input: FinancialOperationInput) {
  return enqueue(async () => {
    const db = await getDatabase();
    const id = makeId();
    const delta = input.kind === 'income' ? input.amount : -input.amount;
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source, receipt_photo_uri)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)`,
        id, input.title, input.category, input.amount, input.currency, input.accountId, input.date, input.kind,
        input.receiptPhotoUri ?? null,
      );
      await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, input.accountId);
    });
    return id;
  });
}

type ImportDraftRow = {
  id: string; source: ImportDraftSource; sender: string; parser_id: string | null; raw_body: string; body_hash: string;
  received_at: string; occurred_at: string | null; amount: number | null; currency: string | null;
  kind: 'income' | 'expense' | null; fee_amount: number | null; card_last4: string | null;
  account_id: string | null; merchant: string | null; balance_after: number | null;
  status: ImportDraft['status']; operation_id: string | null; dedup_operation_id: string | null;
};

const mapImportDraftRow = (row: ImportDraftRow): ImportDraft => ({
  id: row.id, source: row.source, sender: row.sender, parserId: row.parser_id ?? undefined, rawBody: row.raw_body,
  receivedAt: row.received_at, occurredAt: row.occurred_at ?? undefined,
  amount: row.amount ?? undefined, currency: row.currency ?? undefined, kind: row.kind ?? undefined,
  feeAmount: row.fee_amount ?? undefined, cardLast4: row.card_last4 ?? undefined,
  accountId: row.account_id ?? undefined, merchant: row.merchant ?? undefined,
  balanceAfter: row.balance_after ?? undefined, status: row.status,
  operationId: row.operation_id ?? undefined, dedupOperationId: row.dedup_operation_id ?? undefined,
});

async function listImportDraftsCore(): Promise<ImportDraft[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<ImportDraftRow>("SELECT * FROM sms_drafts WHERE status IN ('pending', 'unrecognized') ORDER BY received_at DESC");
  return rows.map(mapImportDraftRow);
}

export function listImportDrafts(): Promise<ImportDraft[]> {
  return enqueue(listImportDraftsCore);
}

// A heuristic (never-silent) hint that this SMS/push message might duplicate an operation the
// user already entered by hand: same account/kind/currency/amount (to the cent) and a date within
// +/-1 day — operations only store a day-level date, not a timestamp, so a tighter window isn't
// possible. A hit never auto-drops the draft; it just flags it for the user to confirm or reject.
async function findDedupOperation(db: SQLite.SQLiteDatabase, accountId: string, kind: 'income' | 'expense', currency: string, amount: number, occurredAt: string): Promise<string | undefined> {
  const day = occurredAt.slice(0, 10);
  const row = await db.getFirstAsync<{ id: string }>(
    `SELECT id FROM operations WHERE status = 'posted' AND account_id = ? AND kind = ? AND currency = ?
     AND ABS(amount - ?) < 0.01 AND date BETWEEN date(?, '-1 day') AND date(?, '+1 day') LIMIT 1`,
    accountId, kind, currency, amount, day, day,
  );
  return row?.id;
}

export function createImportDraft(input: { source: ImportDraftSource; sender: string; rawBody: string; receivedAt: string; parsed: ParsedSms | null; parserId?: string }) {
  return enqueue(async () => {
    const db = await getDatabase();
    // Same source + sender + byte-identical body = a resend of the same message (both SMS formats
    // here embed a running balance, so two genuinely distinct transactions can never collide).
    const bodyHash = hashString(`${input.source} ${input.sender} ${input.rawBody}`);
    const existing = await db.getFirstAsync<ImportDraftRow>('SELECT * FROM sms_drafts WHERE sender = ? AND body_hash = ?', input.sender, bodyHash);
    if (existing) return { draft: mapImportDraftRow(existing), alreadyExisted: true };

    const id = makeId();
    const parsed = input.parsed;
    let accountId: string | undefined;
    let dedupOperationId: string | undefined;
    if (parsed?.cardLast4) {
      const matches = await db.getAllAsync<{ id: string }>('SELECT id FROM accounts WHERE card_last4 = ?', parsed.cardLast4);
      if (matches.length === 1) accountId = matches[0]!.id;
    }
    // Falls back to receivedAt (always present) when the parser couldn't determine occurredAt --
    // confirmed reality for push notifications, not a hypothetical: Sberbank's purchase push has
    // no timestamp in it at all, only amount and running balance.
    const occurredAt = parsed?.occurredAt ?? input.receivedAt;
    if (parsed && accountId) dedupOperationId = await findDedupOperation(db, accountId, parsed.kind, parsed.currency, parsed.amount, occurredAt);
    await db.runAsync(
      `INSERT INTO sms_drafts (id, source, sender, parser_id, raw_body, body_hash, received_at, occurred_at, amount, currency, kind, fee_amount, card_last4, account_id, merchant, balance_after, status, dedup_operation_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, input.source, input.sender, input.parserId ?? null, input.rawBody, bodyHash, input.receivedAt,
      parsed ? occurredAt : null, parsed?.amount ?? null, parsed?.currency ?? null, parsed?.kind ?? null,
      parsed?.feeAmount ?? null, parsed?.cardLast4 ?? null, accountId ?? null, parsed?.merchant ?? null,
      parsed?.balanceAfter ?? null, parsed ? 'pending' : 'unrecognized', dedupOperationId ?? null,
    );
    const row = await db.getFirstAsync<ImportDraftRow>('SELECT * FROM sms_drafts WHERE id = ?', id);
    return { draft: mapImportDraftRow(row!), alreadyExisted: false };
  });
}

export function confirmImportDraft(id: string, input: { accountId: string; title: string; category: string; feeAsSeparateOperation?: boolean }) {
  return enqueue(async () => {
    const db = await getDatabase();
    const draft = await db.getFirstAsync<ImportDraftRow>('SELECT * FROM sms_drafts WHERE id = ?', id);
    if (!draft || draft.status !== 'pending' || draft.amount === null || draft.currency === null || draft.kind === null || !draft.occurred_at) {
      throw new Error('Черновик не найден или уже обработан');
    }
    const operationId = makeId();
    const date = draft.occurred_at.slice(0, 10);
    const delta = draft.kind === 'income' ? draft.amount : -draft.amount;
    await db.withTransactionAsync(async () => {
      await db.runAsync(
        `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        operationId, input.title, input.category, draft.amount, draft.currency, input.accountId, date, draft.kind, draft.source,
      );
      await db.runAsync('UPDATE accounts SET balance = balance + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', delta, input.accountId);
      // Deliberately NOT linked via related_operation_id — that field already means "this is a
      // reversal of X" everywhere it's displayed (Operations screen shows "обратная проводка"),
      // so reusing it for a fee sibling would mislabel it. Just a plain second expense.
      if (input.feeAsSeparateOperation && draft.fee_amount) {
        const feeOperationId = makeId();
        await db.runAsync(
          `INSERT INTO operations (id, title, category, amount, currency, account_id, date, kind, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'expense', ?)`,
          feeOperationId, 'Комиссия за операцию', 'Комиссия', draft.fee_amount, draft.currency, input.accountId, date, draft.source,
        );
        await db.runAsync('UPDATE accounts SET balance = balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', draft.fee_amount, input.accountId);
      }
      await db.runAsync("UPDATE sms_drafts SET status = 'confirmed', operation_id = ?, account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", operationId, input.accountId, id);
    });
    return operationId;
  });
}

export function dismissImportDraft(id: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync("UPDATE sms_drafts SET status = 'dismissed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('pending', 'unrecognized')", id);
  });
}

export function countPendingImportDrafts(): Promise<number> {
  return enqueue(async () => {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ count: number }>("SELECT COUNT(*) as count FROM sms_drafts WHERE status IN ('pending', 'unrecognized')");
    return row?.count ?? 0;
  });
}

const SMS_WATERMARK_KEY = 'sms_last_scanned_at';

// SMS-specific: push notifications aren't scanned-since-a-timestamp, they're captured natively as
// they arrive and drained on next app open (see modules/notification-reader, once built), so that
// channel has no equivalent watermark concept.
// Advances only after the whole inbox read for this scan has been turned into drafts (or
// harmlessly deduped) -- so a scan interrupted partway through just reprocesses the overlapping
// window next time, which createImportDraft's (sender, body) uniqueness already makes idempotent.
export function getSmsScanWatermark(): Promise<string | undefined> {
  return enqueue(async () => {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', SMS_WATERMARK_KEY);
    return row?.value ?? undefined;
  });
}

export function setSmsScanWatermark(iso: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    await db.runAsync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', SMS_WATERMARK_KEY, iso);
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
    deadline: string; account_id: string | null; debt_id: string | null; include_other_currencies: number | null;
  }>('SELECT id, title, type, target, currency, deadline, account_id, debt_id, include_other_currencies FROM financial_goals ORDER BY deadline ASC');
  return rows.map((row) => ({
    id: row.id, title: row.title, type: row.type, target: row.target, currency: row.currency, deadline: row.deadline,
    accountId: row.account_id ?? undefined, debtId: row.debt_id ?? undefined,
    includeAllCurrencies: row.include_other_currencies === null ? undefined : row.include_other_currencies === 1,
  }));
}

export function listFinancialGoals(): Promise<FinancialGoal[]> {
  return enqueue(listFinancialGoalsCore);
}

export function saveFinancialGoal(input: FinancialGoalInput, id?: string) {
  return enqueue(async () => {
    const db = await getDatabase();
    const includeOtherCurrencies = input.includeAllCurrencies === undefined ? null : input.includeAllCurrencies ? 1 : 0;
    if (id) {
      await db.runAsync(
        'UPDATE financial_goals SET title = ?, type = ?, target = ?, currency = ?, deadline = ?, account_id = ?, debt_id = ?, include_other_currencies = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        input.title, input.type, input.target, input.currency, input.deadline, input.accountId ?? null, input.debtId ?? null, includeOtherCurrencies, id,
      );
      return id;
    }
    const goalId = makeId();
    await db.runAsync(
      'INSERT INTO financial_goals (id, title, type, target, currency, deadline, account_id, debt_id, include_other_currencies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      goalId, input.title, input.type, input.target, input.currency, input.deadline, input.accountId ?? null, input.debtId ?? null, includeOtherCurrencies,
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

async function listInterestPostingsCore(): Promise<InterestPosting[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ id: string; account_id: string; payout_date: string; amount: number; destination_account_id: string | null; operation_id: string | null }>(
    'SELECT id, account_id, payout_date, amount, destination_account_id, operation_id FROM interest_postings',
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    payoutDate: row.payout_date,
    amount: row.amount,
    destinationAccountId: row.destination_account_id ?? undefined,
    operationId: row.operation_id ?? undefined,
  }));
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
    const interestPostings = await listInterestPostingsCore();
    const transfers = await listTransfersCore();
    const plannedOccurrences = await listPlannedOccurrencesCore();
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
      interestPostings,
      transfers,
      plannedOccurrences,
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
      DELETE FROM transfers;
      DELETE FROM planned_occurrences;
      DELETE FROM operations;
      DELETE FROM scheduled_flows;
      DELETE FROM planned_expenses;
      DELETE FROM financial_goals;
      DELETE FROM budgets;
      DELETE FROM debts;
      DELETE FROM accounts;
      DELETE FROM currency_rates;
    `);
      // Interest already paid out on another device is recorded in interestPostings, not in a
      // synced interest_tracking_from (that cursor is local-only). Restoring it as "start_date"
      // would make the very next sync re-accrue the account's entire history a second time — real
      // money duplication. Resume from the last known payout instead; if none was ever synced
      // (pre-fix data), resume from today rather than from history, since under-accruing an
      // offline gap is a safe, visible, and correctable error, unlike creating money from nothing.
      const maxPayoutByAccount = new Map<string, string>();
      for (const posting of snapshot.interestPostings) {
        const existing = maxPayoutByAccount.get(posting.accountId);
        if (!existing || posting.payoutDate > existing) maxPayoutByAccount.set(posting.accountId, posting.payoutDate);
      }
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
          maxPayoutByAccount.get(account.id) ?? localToday(),
        );
      }
      for (const transfer of snapshot.transfers) {
        await db.runAsync(
          `INSERT INTO transfers (id, from_account_id, to_account_id, from_amount, from_currency, to_amount, to_currency, exchange_rate, note, date, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          transfer.id, transfer.fromAccountId, transfer.toAccountId, transfer.fromAmount, transfer.fromCurrency,
          transfer.toAmount, transfer.toCurrency, transfer.exchangeRate ?? null, transfer.note ?? null,
          transfer.date, transfer.status,
        );
      }
      // Unlike interest_tracking_from, occurrences_tracking_from IS synced (it's a plain column
      // on scheduled_flows), so the restored cursor is authoritative — use it directly. Fall back
      // to the latest restored occurrence, then to start_date, only for snapshots that predate
      // this field. This can't double-create money either way (INSERT OR IGNORE + UNIQUE(flow_id,
      // occurrence_date) dedupes regardless), but starting from the right cursor avoids redoing
      // years of pointless materialization on a long-running recurring plan.
      const maxOccurrenceByFlow = new Map<string, string>();
      for (const occurrence of snapshot.plannedOccurrences) {
        const existing = maxOccurrenceByFlow.get(occurrence.flowId);
        if (!existing || occurrence.occurrenceDate > existing) maxOccurrenceByFlow.set(occurrence.flowId, occurrence.occurrenceDate);
      }
      for (const flow of snapshot.scheduledFlows) {
        await db.runAsync(
          `INSERT INTO scheduled_flows (id, title, category, amount, currency, account_id, start_date,
          end_date, repeat_rule, kind, repeat_interval, repeat_unit, weekdays, exchange_rate, source_transaction_id,
          occurrences_tracking_from)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          flow.id, flow.title, flow.category, flow.amount, flow.currency, flow.accountId ?? null,
          flow.startDate, flow.endDate ?? null, flow.repeat, flow.kind, flow.repeatInterval ?? 1,
          flow.repeatUnit ?? null, flow.weekdays ? JSON.stringify(flow.weekdays) : null,
          flow.exchangeRate ?? null, flow.sourceTransactionId ?? null,
          flow.occurrencesTrackingFrom ?? maxOccurrenceByFlow.get(flow.id) ?? addLocalDays(flow.startDate, -1),
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
          debt_id, related_operation_id, account_amount, account_currency, status,
          source_occurrence_id, planned_amount, planned_currency, interest_source_account_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          operation.id, operation.title, operation.category, operation.amount, operation.currency,
          operation.accountId, operation.date, operation.kind, operation.source, operation.debtId ?? null,
          operation.relatedOperationId ?? null, operation.accountAmount ?? null,
          operation.accountCurrency ?? null, operation.status ?? 'posted',
          operation.sourceOccurrenceId ?? null, operation.plannedAmount ?? null, operation.plannedCurrency ?? null,
          operation.interestSourceAccountId ?? null,
        );
      }
      for (const occurrence of snapshot.plannedOccurrences) {
        await db.runAsync(
          'INSERT INTO planned_occurrences (id, flow_id, occurrence_date, amount, currency, status, operation_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          occurrence.id, occurrence.flowId, occurrence.occurrenceDate, occurrence.amount, occurrence.currency,
          occurrence.status, occurrence.operationId ?? null,
        );
      }
      for (const posting of snapshot.interestPostings) {
        await db.runAsync(
          'INSERT INTO interest_postings (id, account_id, payout_date, amount, destination_account_id, operation_id) VALUES (?, ?, ?, ?, ?, ?)',
          posting.id, posting.accountId, posting.payoutDate, posting.amount,
          posting.destinationAccountId ?? null, posting.operationId ?? null,
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
          'INSERT INTO financial_goals (id, title, type, target, currency, deadline, account_id, debt_id, include_other_currencies) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          goal.id, goal.title, goal.type, goal.target, goal.currency, goal.deadline,
          goal.accountId ?? null, goal.debtId ?? null,
          goal.includeAllCurrencies === undefined ? null : goal.includeAllCurrencies ? 1 : 0,
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
