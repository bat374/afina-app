import { exportLocalSnapshot, getLinkedCloudUserId, LocalSnapshot, replaceLocalSnapshot, setLinkedCloudUserId } from './database';
import { supabase } from './supabase';

type SyncResult = { uploaded: boolean; reason?: string };

const compact = <T extends Record<string, unknown>>(row: T) =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined));

async function upsertOwnedTable(table: string, userId: string, rows: Record<string, unknown>[]) {
  if (!supabase) throw new Error('Supabase is not configured');
  const normalized = rows.map((row) => compact({ ...row, user_id: userId }));
  if (normalized.length) {
    const { error } = await supabase.from(table).upsert(normalized, { onConflict: 'user_id,id' });
    if (error) throw error;
  }
}

async function deleteMissingOwnedRows(table: string, localIds: string[]) {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error: listError } = await supabase.from(table).select('id');
  if (listError) throw listError;
  const retained = new Set(localIds);
  const staleIds = (data ?? []).map((row) => String(row.id)).filter((id) => !retained.has(id));
  if (staleIds.length) {
    const { error } = await supabase.from(table).delete().in('id', staleIds);
    if (error) throw error;
  }
}

const accountRows = (snapshot: LocalSnapshot) => snapshot.accounts.map((account) => ({
  id: account.id, name: account.name, subtitle: account.subtitle, type: account.type,
  balance: account.balance, currency: account.currency, rate: account.rate ?? null,
  rate_caption: account.rateCaption ?? null, start_date: account.startDate ?? null,
  maturity_date: account.maturityDate ?? null, interest_schedule: account.interestSchedule ?? null,
  interest_destination: account.interestDestination ?? null,
  destination_account_id: account.destinationAccountId ?? null,
  next_interest_date: account.nextInterestDate ?? null, auto_renewal: account.autoRenewal ?? false,
  rate_review_reminder: account.rateReviewReminder ?? true,
  withdrawal_policy: account.withdrawalPolicy ?? null, minimum_balance: account.minimumBalance ?? null,
  replenishment_allowed: account.replenishmentAllowed ?? null, credit_limit: account.creditLimit ?? null,
  statement_day: account.statementDay ?? null, payment_due_day: account.paymentDueDay ?? null,
  grace_period_days: account.gracePeriodDays ?? null,
  minimum_payment_percent: account.minimumPaymentPercent ?? null, accent: account.accent,
}));

export async function uploadLocalDataToCloud(userId: string): Promise<SyncResult> {
  if (!supabase) return { uploaded: false, reason: 'not_configured' };
  const snapshot = await exportLocalSnapshot();

  await upsertOwnedTable('accounts', userId, accountRows(snapshot));
  await upsertOwnedTable('scheduled_flows', userId, snapshot.scheduledFlows.map((flow) => ({
    id: flow.id, title: flow.title, category: flow.category, amount: flow.amount,
    currency: flow.currency, account_id: flow.accountId ?? null, start_date: flow.startDate,
    end_date: flow.endDate ?? null, repeat_rule: flow.repeat, kind: flow.kind,
    repeat_interval: flow.repeatInterval ?? 1, repeat_unit: flow.repeatUnit ?? null,
    weekdays: flow.weekdays ?? null, exchange_rate: flow.exchangeRate ?? null,
    source_transaction_id: flow.sourceTransactionId ?? null,
  })));
  await upsertOwnedTable('debts', userId, snapshot.debts.map((debt) => ({
    id: debt.id, person: debt.person, title: debt.title, direction: debt.direction,
    original_amount: debt.originalAmount, current_balance: debt.currentBalance,
    currency: debt.currency, account_id: debt.accountId ?? null, start_date: debt.startDate,
    due_date: debt.dueDate, status: debt.status, note: debt.note ?? null,
  })));
  await upsertOwnedTable('operations', userId, snapshot.operations.map((operation) => ({
    id: operation.id, title: operation.title, category: operation.category, amount: operation.amount,
    currency: operation.currency, account_id: operation.accountId, date: operation.date,
    kind: operation.kind, source: operation.source, debt_id: operation.debtId ?? null,
    related_operation_id: operation.relatedOperationId ?? null,
    account_amount: operation.accountAmount ?? null, account_currency: operation.accountCurrency ?? null,
    status: operation.status ?? 'posted',
  })));
  await upsertOwnedTable('debt_history', userId, snapshot.debtHistory.map((event) => ({
    id: event.id, debt_id: event.debtId, type: event.type, amount: event.amount ?? null,
    from_date: event.fromDate ?? null, to_date: event.toDate ?? null, occurred_at: event.occurredAt,
    note: event.note ?? null, operation_id: event.operationId ?? null,
    related_history_id: event.relatedHistoryId ?? null,
  })));
  await upsertOwnedTable('budgets', userId, snapshot.budgets.map((budget) => ({
    id: budget.id, category: budget.category, currency: budget.currency, limit_amount: budget.limit,
  })));
  await upsertOwnedTable('financial_goals', userId, snapshot.goals.map((goal) => ({
    id: goal.id, title: goal.title, type: goal.type, target: goal.target, currency: goal.currency,
    deadline: goal.deadline, account_id: goal.accountId ?? null, debt_id: goal.debtId ?? null,
  })));

  const { error: settingsError } = await supabase.from('user_settings').upsert({
    user_id: userId,
    base_currency: snapshot.currencySettings.baseCurrency,
    rates_last_updated: snapshot.currencySettings.lastUpdated ?? null,
    rates_source: snapshot.currencySettings.source ?? 'manual',
    auto_update_rates: snapshot.currencySettings.autoUpdate ?? true,
    migration_completed_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (settingsError) throw settingsError;

  const rates = Object.entries(snapshot.currencySettings.rates).map(([currency, rate]) => ({
    user_id: userId, currency, rate_to_base: rate,
  }));
  if (rates.length) {
    const { error } = await supabase.from('user_currency_rates').upsert(rates, { onConflict: 'user_id,currency' });
    if (error) throw error;
  }
  // Delete in dependency order so foreign keys can never leave half-synchronized data.
  await deleteMissingOwnedRows('debt_history', snapshot.debtHistory.map((row) => row.id));
  await deleteMissingOwnedRows('financial_goals', snapshot.goals.map((row) => row.id));
  await deleteMissingOwnedRows('operations', snapshot.operations.map((row) => row.id));
  await deleteMissingOwnedRows('scheduled_flows', snapshot.scheduledFlows.map((row) => row.id));
  await deleteMissingOwnedRows('debts', snapshot.debts.map((row) => row.id));
  await deleteMissingOwnedRows('budgets', snapshot.budgets.map((row) => row.id));
  await deleteMissingOwnedRows('accounts', snapshot.accounts.map((row) => row.id));
  return { uploaded: true };
}

const numberOrUndefined = (value: unknown) => value === null || value === undefined ? undefined : Number(value);

export async function downloadCloudData(userId: string): Promise<LocalSnapshot> {
  if (!supabase) throw new Error('Supabase is not configured');
  const client = supabase;
  const tableNames = ['accounts', 'scheduled_flows', 'debts', 'operations', 'debt_history', 'budgets', 'financial_goals'] as const;
  const results = await Promise.all(tableNames.map((table) => client.from(table).select('*').is('deleted_at', null)));
  const failed = results.find((result) => result.error);
  if (failed?.error) throw failed.error;
  const accountRows = results[0]?.data ?? [];
  const flowRows = results[1]?.data ?? [];
  const debtRows = results[2]?.data ?? [];
  const operationRows = results[3]?.data ?? [];
  const historyRows = results[4]?.data ?? [];
  const budgetRows = results[5]?.data ?? [];
  const goalRows = results[6]?.data ?? [];
  const { data: settings, error: settingsError } = await client.from('user_settings').select('*').eq('user_id', userId).single();
  if (settingsError) throw settingsError;
  const { data: rateRows, error: ratesError } = await client.from('user_currency_rates').select('*');
  if (ratesError) throw ratesError;

  return {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    accounts: accountRows.map((row) => ({
      id: row.id, name: row.name, subtitle: row.subtitle, type: row.type,
      balance: Number(row.balance), currency: row.currency, rate: numberOrUndefined(row.rate),
      rateCaption: row.rate_caption ?? undefined, startDate: row.start_date ?? undefined,
      maturityDate: row.maturity_date ?? undefined, interestSchedule: row.interest_schedule ?? undefined,
      interestDestination: row.interest_destination ?? undefined,
      destinationAccountId: row.destination_account_id ?? undefined,
      nextInterestDate: row.next_interest_date ?? undefined, autoRenewal: row.auto_renewal,
      rateReviewReminder: row.rate_review_reminder, withdrawalPolicy: row.withdrawal_policy ?? undefined,
      minimumBalance: numberOrUndefined(row.minimum_balance), replenishmentAllowed: row.replenishment_allowed ?? undefined,
      creditLimit: numberOrUndefined(row.credit_limit), statementDay: numberOrUndefined(row.statement_day),
      paymentDueDay: numberOrUndefined(row.payment_due_day), gracePeriodDays: numberOrUndefined(row.grace_period_days),
      minimumPaymentPercent: numberOrUndefined(row.minimum_payment_percent), accent: row.accent,
    })),
    scheduledFlows: flowRows.map((row) => ({
      id: row.id, title: row.title, category: row.category, amount: Number(row.amount), currency: row.currency,
      accountId: row.account_id ?? undefined, startDate: row.start_date, endDate: row.end_date ?? undefined,
      repeat: row.repeat_rule, kind: row.kind, repeatInterval: row.repeat_interval,
      repeatUnit: row.repeat_unit ?? undefined, weekdays: row.weekdays ?? undefined,
      exchangeRate: numberOrUndefined(row.exchange_rate), sourceTransactionId: row.source_transaction_id ?? undefined,
    })),
    debts: debtRows.map((row) => ({
      id: row.id, person: row.person, title: row.title, direction: row.direction,
      originalAmount: Number(row.original_amount), currentBalance: Number(row.current_balance),
      currency: row.currency, accountId: row.account_id ?? undefined, startDate: row.start_date,
      dueDate: row.due_date, status: row.status, note: row.note ?? undefined,
    })),
    operations: operationRows.map((row) => ({
      id: row.id, title: row.title, category: row.category, amount: Number(row.amount), currency: row.currency,
      accountId: row.account_id, date: row.date, kind: row.kind, source: row.source,
      debtId: row.debt_id ?? undefined, relatedOperationId: row.related_operation_id ?? undefined,
      accountAmount: numberOrUndefined(row.account_amount), accountCurrency: row.account_currency ?? undefined,
      status: row.status,
    })),
    debtHistory: historyRows.map((row) => ({
      id: row.id, debtId: row.debt_id, type: row.type, amount: numberOrUndefined(row.amount),
      fromDate: row.from_date ?? undefined, toDate: row.to_date ?? undefined, occurredAt: row.occurred_at,
      note: row.note ?? undefined, operationId: row.operation_id ?? undefined,
      relatedHistoryId: row.related_history_id ?? undefined,
    })),
    budgets: budgetRows.map((row) => ({ id: row.id, category: row.category, currency: row.currency, limit: Number(row.limit_amount) })),
    goals: goalRows.map((row) => ({
      id: row.id, title: row.title, type: row.type, target: Number(row.target), currency: row.currency,
      deadline: row.deadline, accountId: row.account_id ?? undefined, debtId: row.debt_id ?? undefined,
    })),
    currencySettings: {
      baseCurrency: settings.base_currency,
      rates: Object.fromEntries((rateRows ?? []).map((row) => [row.currency, Number(row.rate_to_base)])),
      lastUpdated: settings.rates_last_updated ?? undefined,
      source: settings.rates_source ?? undefined,
      autoUpdate: settings.auto_update_rates,
    },
  };
}

export async function initializeCloudData(userId: string) {
  if (!supabase) return;
  const linkedUserId = await getLinkedCloudUserId();
  if (linkedUserId === userId) return;
  const { data, error } = await supabase.from('user_settings').select('migration_completed_at').eq('user_id', userId).single();
  if (error) throw error;
  if (data.migration_completed_at) {
    const snapshot = await downloadCloudData(userId);
    await replaceLocalSnapshot(snapshot);
  } else {
    await uploadLocalDataToCloud(userId);
  }
  await setLinkedCloudUserId(userId);
}
