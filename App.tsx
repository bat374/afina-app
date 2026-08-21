import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Animated, AppState, Dimensions, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Switch, Text, TextInput, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { budgets, calendarDays, goals, transactions } from './src/data';
import { money, percent } from './src/format';
import { Account, AccountType, AiChatMessage, AiProposal, Budget, CashFlowKind, CurrencySettings, Debt, DebtDirection, DebtHistory, DepositRateHistory, ExpenseRepeat, FinancialGoal, FinancialOperation, GoalType, ImportDraft, InterestSchedule, PlannedExecutionInput, PlannedExpense, PlannedOccurrence, RecurrenceUnit, Transfer, TransferInput, WithdrawalPolicy } from './src/types';
import { AccountInput, BudgetInput, cancelPlannedOccurrence, clearAiChat, commitAiProposal, confirmImportDraft, confirmImportDraftAsTransfer, countPendingAiProposals, countPendingImportDrafts, createDebt, createImportDraft, createOperation, DebtInput, deleteAccount, deleteBudget, deleteFinancialGoal, deletePlannedExpense, dismissAiProposal, dismissImportDraft, executePlannedOccurrence, extendDebt, extendDepositRate, FinancialGoalInput, FinancialOperationInput, getCurrencySettings, getSmsScanWatermark, initializeDatabase, listAccounts, listAiChatMessages, listAiProposals, listBudgets, listDebtHistory, listDebts, listDepositRateHistory, listFinancialGoals, listImportDrafts, listOperations, listPlannedExpenses, listPlannedOccurrences, listTransfers, markDebtOverdue, PlannedExpenseInput, recordDebtPayment, recordTransfer, rematchImportDrafts, reverseDebtPayment, reverseTransfer, saveAccount, saveBudget, saveCurrencySettings, saveFinancialGoal, savePlannedExpense, setSmsScanWatermark, synchronizeInterestPostings, synchronizePlannedOccurrences, updateDebt } from './src/database';
import { sendUserMessage } from './src/ai/loop';
import { extractReceiptText } from './src/ai/receipt';
import { parsersForSender, parseSms } from './src/sms/registry';
import { parsePush } from './src/push/registry';
import { KNOWN_BANK_PACKAGES } from './src/push/packages';
import { hasSmsPermission, isSmsReaderAvailable, readSmsInbox, requestSmsPermission } from './modules/sms-reader';
import { DetectedAccount, recognizeAccountScreenshot } from './src/ocr';
import { annualPassiveIncome, buildMonthProjection, flowAmountInCurrency, getCurrencyTotals } from './src/finance';
import { consolidatedNetWorth, convertCurrency, convertToBase, fetchOfficialCurrencyRates, operationConversionBasis, rebaseRates, weightedAssetRates } from './src/currency';
import { calculateGoalProgress } from './src/goals';
import { addLocalDays, localToday, nextMonthlyDate, parseLocalDate, toLocalIso } from './src/date';
import { occursOn, recurrenceLabel } from './src/recurrence';
import { AnalyticsPeriod, DateRange, analyticsRange, summarizeOperations, summarizePlannedFlows } from './src/analytics';
import { supabase, isCloudConfigured } from './src/supabase';
import { initializeCloudData, uploadLocalDataToCloud } from './src/cloudSync';
import type { Session } from '@supabase/supabase-js';

type Tab = 'home' | 'accounts' | 'calendar' | 'operations' | 'analytics' | 'profile';

const APP_VERSION = '1.4.0';

const C = {
  bg: '#EDF5F8', card: '#FFFFFF', ink: '#172A34', muted: '#718087',
  line: '#D9E7ED', green: '#788D7B', blue: '#5C91AA', red: '#C9574F',
  redSoft: '#F9E8E4', navy: '#263C4A', sageSoft: '#E9EEE8',
};

// Supabase/PostgREST errors are plain objects ({message, code, details, hint}), not instances of
// the native Error class, so `error instanceof Error` misses them and silently hides the actual
// cause of a failed cloud operation. This covers both shapes.
const describeError = (error: unknown): string | undefined => {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return undefined;
};

const iconForType: Record<AccountType, keyof typeof Ionicons.glyphMap> = {
  card: 'card-outline', credit_card: 'card-outline', savings: 'leaf-outline', deposit: 'time-outline', cash: 'wallet-outline',
};

const scheduleLabel = (schedule?: InterestSchedule) => schedule === 'daily' ? 'ежедневно' : schedule === 'monthly' ? 'раз в месяц' : 'в конце срока';
const debtStatusLabel = (debt: Debt) => debt.status === 'paid' ? 'Погашен' : debt.status === 'overdue' ? 'Просрочен' : `до ${debt.dueDate}`;
const debtHistoryLabel = (event: DebtHistory) => ({ created: 'Долг создан', edited: 'Условия изменены', payment: 'Погашение', early_payment: 'Досрочное погашение', payment_reversed: 'Погашение отменено', extension: 'Пролонгация', overdue: 'Просрочка' }[event.type]);

function SectionTitle({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <View style={s.sectionHead}><Text style={s.sectionTitle}>{title}</Text>{action && (onAction ? <Pressable onPress={onAction} hitSlop={10}><Text style={s.link}>{action}</Text></Pressable> : <Text style={s.link}>{action}</Text>)}</View>;
}

function Progress({ value, color }: { value: number; color: string }) {
  return <View style={s.progressTrack}><View style={[s.progressFill, { width: `${Math.min(value, 100)}%`, backgroundColor: color }]} /></View>;
}

function Header({ eyebrow, title, onAvatarPress }: { eyebrow: string; title: string; onAvatarPress?: () => void }) {
  return <View style={s.header}>
    <View><Text style={s.eyebrow}>{eyebrow}</Text><Text style={s.title}>{title}</Text></View>
    <Pressable style={s.avatar} onPress={onAvatarPress}><Text style={s.avatarText}>А</Text></Pressable>
  </View>;
}

function LegacyHome({ onImport, go, accounts }: { onImport: () => void; go: (tab: Tab) => void; accounts: Account[] }) {
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow="Доброе утро" title="Ваши финансы" />
    <View style={s.hero}>
      <Text style={s.heroLabel}>ЧИСТЫЙ КАПИТАЛ</Text>
      <Text style={s.heroAmount}>{money(total)}</Text>
      <View style={s.heroDelta}><Ionicons name="trending-up" size={15} color="#DCE7DD" /><Text style={s.heroDeltaText}> +4,8% за месяц</Text></View>
      <View style={s.heroRule} />
      <View style={s.heroStats}>
        <View><Text style={s.heroStatLabel}>Доходы</Text><Text style={s.heroStat}>+16,9 млн</Text></View>
        <View><Text style={s.heroStatLabel}>Расходы</Text><Text style={s.heroStat}>−7,1 млн</Text></View>
        <View><Text style={s.heroStatLabel}>Пассивно</Text><Text style={s.heroStat}>+372 тыс</Text></View>
      </View>
    </View>

    <Pressable style={s.scanButton} onPress={onImport}>
      <View style={s.scanIcon}><Ionicons name="scan-outline" size={22} color={C.navy} /></View>
      <View style={{ flex: 1 }}><Text style={s.scanTitle}>Добавить скриншот</Text><Text style={s.scanSub}>Распознаем счета и операции</Text></View>
      <Ionicons name="arrow-forward" size={21} color={C.navy} />
    </Pressable>

    <View style={s.alert}>
      <View style={s.alertIcon}><Ionicons name="warning-outline" size={20} color={C.red} /></View>
      <View style={{ flex: 1 }}><Text style={s.alertTitle}>Риск кассового разрыва</Text><Text style={s.alertText}>12 августа может не хватить 828 000 сум</Text></View>
      <Pressable onPress={() => go('calendar')}><Ionicons name="chevron-forward" size={20} color={C.red} /></Pressable>
    </View>

    <SectionTitle title="Ближайшие события" action="Все" />
    <View style={s.card}>
      <View style={s.eventRow}>
        <View style={s.dateTile}><Text style={s.dateDay}>05</Text><Text style={s.dateMonth}>АВГ</Text></View>
        <View style={{ flex: 1 }}><Text style={s.rowTitle}>Аренда квартиры</Text><Text style={s.rowSub}>Обязательный платёж</Text></View>
        <Text style={s.expense}>−4,8 млн</Text>
      </View>
      <View style={s.divider} />
      <View style={s.eventRow}>
        <View style={[s.dateTile, { backgroundColor: C.sageSoft }]}><Text style={s.dateDay}>09</Text><Text style={s.dateMonth}>АВГ</Text></View>
        <View style={{ flex: 1 }}><Text style={s.rowTitle}>Возврат долга от Малики</Text><Text style={s.rowSub}>Ожидаемый приход</Text></View>
        <Text style={s.income}>+1,25 млн</Text>
      </View>
    </View>

    <SectionTitle title="Счета" action="Все счета" />
    {accounts.length === 0 ? <View style={s.emptyCard}><Ionicons name="wallet-outline" size={25} color={C.blue} /><Text style={s.emptyTitle}>Добавьте первый счёт</Text><Text style={s.emptyText}>Баланс и аналитика появятся здесь автоматически</Text></View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.accountRail}>
      {accounts.slice(0, 3).map((account) => <View key={account.id} style={[s.miniAccount, { borderTopColor: account.accent }]}>
        <View style={[s.roundIcon, { backgroundColor: `${account.accent}18` }]}><Ionicons name={iconForType[account.type]} size={20} color={account.accent} /></View>
        <Text style={s.miniName}>{account.name}</Text><Text style={s.miniBalance}>{money(account.balance)}</Text>
        <Text style={s.rowSub}>{account.subtitle}</Text>
      </View>)}
    </ScrollView>}
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function Home({ onImport, go, accounts, plannedExpenses, plannedOccurrences, debts, currencySettings, onCurrencySettings, onProfile, pendingImportDrafts, operations, transfers, onEditAccount }: { onImport: () => void; go: (tab: Tab) => void; accounts: Account[]; plannedExpenses: PlannedExpense[]; plannedOccurrences: PlannedOccurrence[]; debts: Debt[]; currencySettings: CurrencySettings; onCurrencySettings: () => void; onProfile: () => void; pendingImportDrafts: number; operations: FinancialOperation[]; transfers: Transfer[]; onEditAccount: (account: Account) => void }) {
  const now = new Date();
  const totals = getCurrencyTotals(accounts);
  const currencies = Array.from(new Set([currencySettings.baseCurrency, ...Object.keys(totals), ...plannedExpenses.map((item) => item.currency), ...debts.map((item) => item.currency)])).sort((a, b) => a === 'UZS' ? -1 : b === 'UZS' ? 1 : a.localeCompare(b));
  const primaryCurrency = currencies[0] ?? 'UZS';
  const projection = buildMonthProjection(accounts, primaryCurrency, now.getFullYear(), now.getMonth(), plannedExpenses, debts, currencySettings, localToday(), plannedOccurrences, operations, transfers);
  const consolidated = consolidatedNetWorth(accounts, debts, currencySettings);
  // Same period, same aggregation function ("Аналитика" already uses summarizeOperations) for
  // all three hero stats -- "Активно"/"Расходы" used to be a hardcoded 0 regardless of real
  // data (BACKLOG.md OV-03), and "Пассивно" used buildMonthProjection's forward-looking daily
  // interest schedule rather than what was actually posted this period, which isn't the same
  // number once any day in the period has an actual, possibly-differing bank-credited amount.
  const heroRange = analyticsRange('month', localToday());
  // Base currency (not primaryCurrency, which is just "UZS if any account has it, else
  // alphabetical") — these three figures are meant to be the user's one across-accounts view,
  // so they're converted via the same system rates consolidatedNetWorth above already uses.
  const heroActual = summarizeOperations(operations, currencySettings.baseCurrency, heroRange, currencySettings);
  const heroPeriodLabel = `за ${now.toLocaleString('ru-RU', { month: 'long' })} ${now.getFullYear()}`;
  const risk = projection.days.find((day) => day.risky);
  const events = projection.events.filter((event) => event.day >= now.getDate()).slice(0, 3);
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow="ДОБРО ПОЖАЛОВАТЬ" title="Ваши финансы" onAvatarPress={onProfile} />
    <View style={s.hero}>
      <Text style={s.heroLabel}>ОБЩИЙ КАПИТАЛ · {currencySettings.baseCurrency}</Text>
      <Text style={s.heroAmount}>{money(consolidated.total, false, currencySettings.baseCurrency)}</Text>
      {!!consolidated.missing.length && <Text style={s.heroOtherCurrency}>Без курса: {consolidated.missing.join(', ')}</Text>}
      <Pressable onPress={() => go('accounts')} style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }}>
        <Text style={s.heroOtherCurrency}>Счета в {currencies.length} {currencies.length === 1 ? 'валюте' : 'валютах'}</Text>
        <Ionicons name="chevron-forward" size={14} color="#C6D5DB" style={{ marginLeft: 4 }} />
      </Pressable>
      <View style={s.heroDelta}><Ionicons name="cloud-done-outline" size={14} color="#DCE7DD" /><Text style={s.heroDeltaText}> Данные синхронизируются с облаком</Text></View>
      <View style={s.heroRule} />
      <Text style={[s.heroStatLabel, { marginBottom: 8, textAlign: 'center' }]}>{heroPeriodLabel.toUpperCase()} · {currencySettings.baseCurrency}</Text>
      <View style={s.heroStats}>
        <View style={s.heroStatCol}><Text style={[s.heroStatLabel, s.heroStatLabelBox]}>Активные доходы</Text><Text style={s.heroStat}>+{money(heroActual.income - heroActual.passive, true, currencySettings.baseCurrency)}</Text></View>
        <View style={s.heroStatCol}><Text style={[s.heroStatLabel, s.heroStatLabelBox]}>Расходы</Text><Text style={s.heroStat}>{money(heroActual.expense, true, currencySettings.baseCurrency)}</Text></View>
        <View style={s.heroStatCol}><Text style={[s.heroStatLabel, s.heroStatLabelBox]}>Пассивные доходы</Text><Text style={s.heroStat}>+{money(heroActual.passive, true, currencySettings.baseCurrency)}</Text></View>
      </View>
      {!!heroActual.missing.length && <Text style={[s.heroOtherCurrency, { marginTop: 8 }]}>Без курса: {heroActual.missing.join(', ')}</Text>}
    </View>

    <Pressable style={s.currencySettingsButton} onPress={onCurrencySettings}><Ionicons name="swap-horizontal-outline" size={19} color={C.blue} /><Text style={s.manualAccountText}>Базовая валюта и курсы</Text></Pressable>

    <Pressable style={s.scanButton} onPress={onImport}><View style={s.scanIcon}><Ionicons name="scan-outline" size={22} color={C.navy} /></View><View style={{ flex: 1 }}><Text style={s.scanTitle}>Добавить скриншот</Text><Text style={s.scanSub}>Распознаем счёт и условия</Text></View><Ionicons name="arrow-forward" size={21} color={C.navy} /></Pressable>

    {risk && <View style={s.alert}><View style={s.alertIcon}><Ionicons name="warning-outline" size={20} color={C.red} /></View><View style={{ flex: 1 }}><Text style={s.alertTitle}>Риск кассового разрыва</Text><Text style={s.alertText}>{risk.day} числа прогнозный баланс станет отрицательным</Text></View><Pressable onPress={() => go('calendar')}><Ionicons name="chevron-forward" size={20} color={C.red} /></Pressable></View>}
    {pendingImportDrafts > 0 && <Pressable style={[s.alert, { backgroundColor: C.sageSoft }]} onPress={onProfile}><View style={[s.alertIcon, { backgroundColor: `${C.green}22` }]}><Ionicons name="chatbox-ellipses-outline" size={20} color={C.green} /></View><View style={{ flex: 1 }}><Text style={[s.alertTitle, { color: C.green }]}>{pendingImportDrafts} {pendingImportDrafts === 1 ? 'операция ждёт' : 'операции ждут'} подтверждения</Text><Text style={[s.alertText, { color: C.green }]}>Найдено в SMS — Профиль → Автоматизация</Text></View><Ionicons name="chevron-forward" size={20} color={C.green} /></Pressable>}

    <SectionTitle title="Ближайшие события" action="Календарь" onAction={() => go('calendar')} />
    {events.length ? <View style={s.card}>{events.map((event, index) => { const outgoing = event.kind === 'expense' || event.kind === 'debt_expense' || event.kind === 'credit_payment'; const incoming = event.kind === 'interest' || event.kind === 'debt_income' || event.kind === 'planned_income'; return <View key={`${event.date}-${event.accountId}-${event.kind}`}><View style={s.eventRow}><View style={[s.dateTile, { backgroundColor: outgoing ? C.redSoft : event.kind === 'reminder' ? C.bg : C.sageSoft }]}><Text style={s.dateDay}>{String(event.day).padStart(2, '0')}</Text><Text style={s.dateMonth}>{now.toLocaleString('ru-RU', { month: 'short' }).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{event.title}</Text><Text style={s.rowSub}>{event.kind === 'planned_income' ? 'Запланированный доход' : event.kind === 'debt_income' ? 'Возврат долга' : event.kind === 'debt_expense' ? 'Погашение долга' : event.kind === 'credit_payment' ? 'Минимальный платёж по кредитной карте' : event.kind === 'expense' ? 'Запланированный расход' : event.kind === 'reminder' ? 'Напоминание' : `Пассивный доход${event.trackedInBalance ? '' : ' · счёт зачисления не выбран'}`}</Text></View>{incoming && <Text style={s.income}>+{money(event.amount, false, event.currency)}</Text>}{outgoing && <Text style={s.expense}>−{money(event.amount, false, event.currency)}</Text>}</View>{index < events.length - 1 && <View style={s.divider} />}</View>; })}</View> : <View style={s.emptyCard}><Ionicons name="calendar-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Событий пока нет</Text><Text style={s.emptyText}>Запланируйте доход, расход или добавьте условия вклада</Text></View>}

    <SectionTitle title="Счета" action="Все счета" onAction={() => go('accounts')} />
    {accounts.length === 0 ? <View style={s.emptyCard}><Ionicons name="wallet-outline" size={25} color={C.blue} /><Text style={s.emptyTitle}>Добавьте первый счёт</Text><Text style={s.emptyText}>Баланс и аналитика появятся здесь автоматически</Text></View> : <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.accountRail}>{accounts.slice(0, 4).map((account) => <Pressable key={account.id} onPress={() => onEditAccount(account)} style={[s.miniAccount, { borderTopColor: account.accent }]}><View style={[s.roundIcon, { backgroundColor: `${account.accent}18` }]}><Ionicons name={iconForType[account.type]} size={20} color={account.accent} /></View><Text style={s.miniName}>{account.name}</Text><Text style={s.miniBalance}>{money(account.balance, false, account.currency)}</Text><Text style={s.rowSub}>{account.subtitle}</Text></Pressable>)}</ScrollView>}
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function LegacyAccounts({ accounts, onAdd, onImport, onEdit }: { accounts: Account[]; onAdd: () => void; onImport: () => void; onEdit: (account: Account) => void }) {
  const total = accounts.reduce((sum, a) => sum + a.balance, 0);
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow="МОИ ДЕНЬГИ" title="Счета и долги" />
    <View style={s.totalLine}><Text style={s.totalLabel}>Всего на счетах</Text><Text style={s.totalAmount}>{money(total)}</Text></View>
    <SectionTitle title="Счета" />
    <View style={s.accountActions}>
      <Pressable style={s.importAccountButton} onPress={onImport}><Ionicons name="scan-outline" size={19} color="white" /><Text style={s.importAccountText}>Со скриншота</Text></Pressable>
      <Pressable style={s.manualAccountButton} onPress={onAdd}><Ionicons name="add" size={19} color={C.blue} /><Text style={s.manualAccountText}>Вручную</Text></Pressable>
    </View>
    {accounts.length === 0 && <Pressable style={s.largeEmpty} onPress={onAdd}><View style={s.emptyRound}><Ionicons name="add" size={26} color={C.blue} /></View><Text style={s.emptyTitle}>Создайте первый счёт</Text><Text style={s.emptyText}>Карта, накопительный счёт, вклад или наличные</Text></Pressable>}
    {accounts.map((account) => <Pressable key={account.id} style={s.accountCard} onPress={() => onEdit(account)}>
      <View style={[s.accountStripe, { backgroundColor: account.accent }]} />
      <View style={[s.roundIcon, { backgroundColor: `${account.accent}18` }]}><Ionicons name={iconForType[account.type]} size={22} color={account.accent} /></View>
      <View style={{ flex: 1 }}><Text style={s.rowTitle}>{account.name}</Text><Text style={s.rowSub}>{account.subtitle}</Text>
        {account.rate && <Text style={[s.rate, { color: account.accent }]}>{account.rate}% · {account.rateCaption}</Text>}
      </View>
      <View style={{ alignItems: 'flex-end' }}><Text style={s.accountAmount}>{money(account.balance)}</Text><Text style={s.currency}>{account.currency}</Text></View>
    </Pressable>)}

    <SectionTitle title="Долги" action="+ Добавить" />
    <View style={s.debtSummary}>
      <View style={s.debtSide}><Text style={s.debtLabel}>МНЕ ДОЛЖНЫ</Text><Text style={s.debtPositive}>2 450 000 сум</Text></View>
      <View style={s.verticalRule} />
      <View style={s.debtSide}><Text style={s.debtLabel}>Я ДОЛЖНА</Text><Text style={s.debtNegative}>6 900 000 сум</Text></View>
    </View>
    <View style={s.card}>
      <View style={s.personRow}><View style={[s.personIcon, { backgroundColor: C.sageSoft }]}><Text style={s.personInitial}>М</Text></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>Малика</Text><Text style={s.rowSub}>Вернёт до 9 августа</Text></View><Text style={s.income}>+1 250 000</Text></View>
      <View style={s.divider} />
      <View style={s.personRow}><View style={[s.personIcon, { backgroundColor: C.redSoft }]}><Text style={[s.personInitial, { color: C.red }]}>Б</Text></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>Банк · рассрочка</Text><Text style={s.rowSub}>Платёж 12 августа</Text></View><Text style={s.expense}>−6 900 000</Text></View>
    </View>
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function Accounts({ accounts, onAdd, onImport, onEdit, debts, onAddDebt, onOpenDebt, currencySettings, onCurrencySettings, onProfile }: { accounts: Account[]; onAdd: () => void; onImport: () => void; onEdit: (account: Account) => void; debts: Debt[]; onAddDebt: () => void; onOpenDebt: (debt: Debt) => void; currencySettings: CurrencySettings; onCurrencySettings: () => void; onProfile: () => void }) {
  const [typeFilter, setTypeFilter] = useState<'ALL' | AccountType>('ALL'); const [currencyFilter, setCurrencyFilter] = useState('ALL'); const [bankFilter, setBankFilter] = useState('');
  const [collapsed, setCollapsed] = useState<Partial<Record<AccountType, boolean>>>({}); const [archiveOpen, setArchiveOpen] = useState(false); const [archiveQuery, setArchiveQuery] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const consolidated = consolidatedNetWorth(accounts, debts, currencySettings);
  const debtTotal = (direction: DebtDirection) => debts.filter((debt) => debt.direction === direction && debt.status !== 'paid').reduce((sum, debt) => sum + (convertToBase(debt.currentBalance, debt.currency, currencySettings) ?? 0), 0);
  const typeOrder: AccountType[] = ['card', 'credit_card', 'savings', 'deposit', 'cash'];
  const typeNames: Record<AccountType, string> = { card: 'Банковские карты', credit_card: 'Кредитные карты', savings: 'Накопительные счета', deposit: 'Вклады', cash: 'Наличные' };
  const currencies = Array.from(new Set(accounts.map((account) => account.currency))).sort();
  const filtered = accounts.filter((account) => (typeFilter === 'ALL' || account.type === typeFilter) && (currencyFilter === 'ALL' || account.currency === currencyFilter) && (!bankFilter.trim() || `${account.name} ${account.subtitle}`.toLowerCase().includes(bankFilter.trim().toLowerCase())));
  const groups = typeOrder.map((type) => ({ type, accounts: filtered.filter((account) => account.type === type) })).filter((group) => group.accounts.length);
  const activeDebts = debts.filter((debt) => debt.status !== 'paid'); const archivedDebts = debts.filter((debt) => debt.status === 'paid');
  const filteredArchivedDebts = archiveQuery.trim() ? archivedDebts.filter((debt) => `${debt.person} ${debt.title}`.toLowerCase().includes(archiveQuery.trim().toLowerCase())) : archivedDebts;
  const debtGroups = Object.entries(activeDebts.reduce<Record<string, Debt[]>>((result, debt) => ({ ...result, [debt.person]: [...(result[debt.person] ?? []), debt] }), {})).sort(([left], [right]) => left.localeCompare(right, 'ru'));
  const activeFilterCount = (typeFilter !== 'ALL' ? 1 : 0) + (currencyFilter !== 'ALL' ? 1 : 0) + (bankFilter.trim() ? 1 : 0);
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
    <Header eyebrow="МОИ ДЕНЬГИ" title="Счета и долги" onAvatarPress={onProfile} />
    <Pressable style={s.totalLine} onPress={onCurrencySettings}><Text style={s.totalLabel}>ОБЩИЙ КАПИТАЛ · {currencySettings.baseCurrency}</Text><Text style={s.totalAmount}>{money(consolidated.total, false, currencySettings.baseCurrency)}</Text>{!!consolidated.missing.length && <Text style={s.heroOtherCurrency}>Нужны курсы: {consolidated.missing.join(', ')}</Text>}<Text style={[s.totalLabel, { marginTop: 12 }]}>Нажмите, чтобы изменить валюту и курсы</Text></Pressable>
    <SectionTitle title="Счета" /><View style={s.accountActions}><Pressable style={s.importAccountButton} onPress={onImport}><Ionicons name="scan-outline" size={19} color="white" /><Text style={s.importAccountText}>Со скриншота</Text></Pressable><Pressable style={s.manualAccountButton} onPress={onAdd}><Ionicons name="add" size={19} color={C.blue} /><Text style={s.manualAccountText}>Вручную</Text></Pressable></View>
    {!!accounts.length && <Pressable style={s.groupHeader} onPress={() => setFiltersOpen((value) => !value)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={s.sectionTitle}>Фильтры</Text>
        {activeFilterCount > 0 && <View style={s.chartBadge}><Text style={s.chartBadgeText}>{activeFilterCount}</Text></View>}
      </View>
      <Ionicons name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={20} color={C.blue} />
    </Pressable>}
    {!!accounts.length && filtersOpen && <View style={s.filterPanel}><TextInput value={bankFilter} onChangeText={setBankFilter} placeholder="Фильтр по банку или названию" placeholderTextColor="#9BA9AF" style={s.input} /><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRail}>{(['ALL', ...typeOrder] as const).map((type) => <Pressable key={type} style={[s.currencyFilter, typeFilter === type && s.currencyFilterActive]} onPress={() => setTypeFilter(type)}><Text style={[s.currencyFilterText, typeFilter === type && s.currencyFilterTextActive]}>{type === 'ALL' ? 'Все типы' : typeNames[type]}</Text></Pressable>)}</ScrollView><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.filterRail}>{['ALL', ...currencies].map((item) => <Pressable key={item} style={[s.currencyFilter, currencyFilter === item && s.currencyFilterActive]} onPress={() => setCurrencyFilter(item)}><Text style={[s.currencyFilterText, currencyFilter === item && s.currencyFilterTextActive]}>{item === 'ALL' ? 'Все валюты' : item}</Text></Pressable>)}</ScrollView></View>}
    {!accounts.length && <Pressable style={s.largeEmpty} onPress={onAdd}><View style={s.emptyRound}><Ionicons name="add" size={26} color={C.blue} /></View><Text style={s.emptyTitle}>Создайте первый счёт</Text><Text style={s.emptyText}>Карта, кредитная карта, накопительный счёт, вклад или наличные</Text></Pressable>}
    {!!accounts.length && !groups.length && <View style={s.emptyCard}><Text style={s.emptyTitle}>Ничего не найдено</Text><Text style={s.emptyText}>Измените фильтры счетов</Text></View>}
    {groups.map((group) => <View key={group.type}><Pressable style={s.groupHeader} onPress={() => setCollapsed((current) => ({ ...current, [group.type]: !current[group.type] }))}><View><Text style={s.sectionTitle}>{typeNames[group.type]}</Text><Text style={s.rowSub}>{group.accounts.length} сч. · {Array.from(new Set(group.accounts.map((account) => account.currency))).map((code) => money(group.accounts.filter((account) => account.currency === code).reduce((sum, account) => sum + account.balance, 0), true, code)).join(' · ')}</Text></View><Ionicons name={collapsed[group.type] ? 'chevron-down' : 'chevron-up'} size={20} color={C.blue} /></Pressable>{!collapsed[group.type] && group.accounts.map((account) => { const creditDebt = account.type === 'credit_card' ? Math.abs(Math.min(0, account.balance)) : 0; const available = (account.creditLimit ?? 0) - creditDebt; return <Pressable key={account.id} style={s.accountCard} onPress={() => onEdit(account)}><View style={[s.accountStripe, { backgroundColor: account.accent }]} /><View style={[s.roundIcon, { backgroundColor: `${account.accent}18` }]}><Ionicons name={iconForType[account.type]} size={22} color={account.accent} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{account.name}</Text><Text style={s.rowSub}>{account.subtitle}</Text>{account.type === 'credit_card' ? <Text style={[s.rate, { color: account.accent }]}>Доступно {money(Math.max(0, available), false, account.currency)} · платёж {account.paymentDueDay ?? '—'} числа</Text> : account.rate ? <Text style={[s.rate, { color: account.accent }]}>{account.rate}% · {scheduleLabel(account.interestSchedule)}{account.maturityDate ? ` · до ${account.maturityDate}` : ''}</Text> : null}</View><View style={{ alignItems: 'flex-end' }}><Text style={[s.accountAmount, account.type === 'credit_card' && { color: C.red }]}>{account.type === 'credit_card' ? money(creditDebt, false, account.currency) : money(account.balance, false, account.currency)}</Text><Text style={s.currency}>{account.type === 'credit_card' ? 'ДОЛГ' : account.currency}</Text></View></Pressable>; })}</View>)}
    <SectionTitle title="Долги" action="+ Добавить" onAction={onAddDebt} /><View style={s.debtSummary}><View style={s.debtSide}><Text style={s.debtLabel}>МНЕ ДОЛЖНЫ · {currencySettings.baseCurrency}</Text><Text style={s.debtPositive}>{money(debtTotal('owed_to_me'), false, currencySettings.baseCurrency)}</Text></View><View style={s.verticalRule} /><View style={s.debtSide}><Text style={s.debtLabel}>Я ДОЛЖНА · {currencySettings.baseCurrency}</Text><Text style={s.debtNegative}>{money(debtTotal('i_owe'), false, currencySettings.baseCurrency)}</Text></View></View>
    {debtGroups.length ? debtGroups.map(([person, personDebts]) => <View key={person}><Text style={s.debtGroupTitle}>{person} · {personDebts.length}</Text><View style={s.card}>{personDebts.map((debt, index) => <Pressable key={debt.id} onPress={() => onOpenDebt(debt)}><View style={s.personRow}><View style={[s.personIcon, { backgroundColor: debt.status === 'overdue' ? C.redSoft : debt.direction === 'owed_to_me' ? C.sageSoft : '#DDEEF4' }]}><Ionicons name={debt.status === 'overdue' ? 'alert' : 'person-outline'} size={18} color={debt.status === 'overdue' ? C.red : debt.direction === 'owed_to_me' ? C.green : C.blue} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{debt.title}</Text><Text style={[s.rowSub, debt.status === 'overdue' && { color: C.red }]}>{debtStatusLabel(debt)}</Text></View><Text style={debt.direction === 'owed_to_me' ? s.income : s.expense}>{debt.direction === 'owed_to_me' ? '+' : '−'}{money(debt.currentBalance, false, debt.currency)}</Text></View>{index < personDebts.length - 1 && <View style={s.divider} />}</Pressable>)}</View></View>) : <Pressable style={s.emptyCard} onPress={onAddDebt}><Ionicons name="people-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Добавьте первый долг</Text><Text style={s.emptyText}>Кто должен вам или кому должны вы</Text></Pressable>}
    {!!archivedDebts.length && <><Pressable style={s.groupHeader} onPress={() => setArchiveOpen((value) => !value)}><View><Text style={s.sectionTitle}>Архив долгов</Text><Text style={s.rowSub}>{archivedDebts.length} погашено</Text></View><Ionicons name={archiveOpen ? 'chevron-up' : 'chevron-down'} size={20} color={C.blue} /></Pressable>{archiveOpen && <>
      <TextInput value={archiveQuery} onChangeText={setArchiveQuery} placeholder="Поиск по имени или названию" placeholderTextColor="#9BA9AF" style={[s.input, { marginBottom: 8 }]} />
      {filteredArchivedDebts.length ? <View style={s.card}>{filteredArchivedDebts.map((debt, index) => <Pressable key={debt.id} onPress={() => onOpenDebt(debt)}><View style={s.personRow}><View style={[s.personIcon, { backgroundColor: C.sageSoft }]}><Ionicons name="checkmark" size={18} color={C.green} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{debt.person} · {debt.title}</Text><Text style={s.rowSub}>Погашен · открыть историю</Text></View><Text style={s.rowSub}>{debt.currency}</Text></View>{index < filteredArchivedDebts.length - 1 && <View style={s.divider} />}</Pressable>)}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Ничего не найдено в архиве</Text></View>}
    </>}</>}
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function LegacyCalendar() {
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow="ПРОГНОЗ · АФИНА 0.8" title="Платёжный календарь" />
    <View style={s.monthBar}><Pressable><Ionicons name="chevron-back" size={20} color={C.ink} /></Pressable><Text style={s.month}>Август 2026</Text><Pressable><Ionicons name="chevron-forward" size={20} color={C.ink} /></Pressable></View>
    <View style={s.forecastCard}>
      <View><Text style={s.forecastLabel}>ОСТАТОК К КОНЦУ МЕСЯЦА</Text><Text style={s.forecastAmount}>4 752 000 сум</Text></View>
      <View style={s.forecastPill}><Text style={s.forecastPillText}>−6,2 млн</Text></View>
    </View>
    <View style={s.weekHead}>{['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map((d) => <Text key={d} style={s.weekDay}>{d}</Text>)}</View>
    <View style={s.calendarGrid}>
      {[null, null, null, null, null].map((_, i) => <View key={`empty-${i}`} style={s.dayCell} />)}
      {calendarDays.map((item) => <Pressable key={item.day} style={[s.dayCell, item.risky && s.riskyDay, item.day === 1 && s.today]}>
        <Text style={[s.dayNumber, item.risky && { color: C.red }]}>{item.day}</Text>
        <Text style={[s.dayBalance, item.balance < 2_000_000 && { color: C.red }]}>{money(item.balance, true)}</Text>
        <View style={s.dots}>{item.income && <View style={[s.dot, { backgroundColor: C.green }]} />}{item.expense && <View style={[s.dot, { backgroundColor: item.risky ? C.red : C.blue }]} />}</View>
      </Pressable>)}
    </View>
    <View style={s.legend}><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.green }]} /><Text style={s.legendText}>Приход</Text></View><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.blue }]} /><Text style={s.legendText}>Расход</Text></View><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.red }]} /><Text style={s.legendText}>Разрыв</Text></View></View>
    <SectionTitle title="5 августа" />
    <View style={s.card}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: C.redSoft }]}><Ionicons name="home-outline" size={20} color={C.red} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>Аренда квартиры</Text><Text style={s.rowSub}>Основная карта · обязательно</Text></View><Text style={s.expense}>−4 800 000</Text></View></View>
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function Calendar({ accounts, plannedExpenses, plannedOccurrences, debts, currencySettings, onAddExpense, onEditExpense, onExecuteOccurrence, onCancelOccurrence, onProfile, operations, transfers }: {
  accounts: Account[]; plannedExpenses: PlannedExpense[]; plannedOccurrences: PlannedOccurrence[]; debts: Debt[]; currencySettings: CurrencySettings;
  onAddExpense: (date: string) => void; onEditExpense: (expense: PlannedExpense) => void;
  onExecuteOccurrence: (occurrence: PlannedOccurrence, flow: PlannedExpense) => void; onCancelOccurrence: (occurrence: PlannedOccurrence) => void; onProfile: () => void;
  operations: FinancialOperation[]; transfers: Transfer[];
}) {
  const [today, setToday] = useState(localToday());
  const todayDate = dateFromIso(today);
  const totals = getCurrencyTotals(accounts);
  const flowCurrencies = plannedExpenses.map((flow) => accounts.find((account) => account.id === flow.accountId)?.currency ?? flow.currency);
  const currencies = Array.from(new Set([...Object.keys(totals), ...flowCurrencies, ...debts.map((item) => item.currency)])).sort((a, b) => a === 'UZS' ? -1 : b === 'UZS' ? 1 : a.localeCompare(b));
  const [currency, setCurrency] = useState(currencies[0] ?? 'UZS');
  const [viewDate, setViewDate] = useState(new Date(todayDate.getFullYear(), todayDate.getMonth(), 1));
  const [selectedDay, setSelectedDay] = useState(todayDate.getDate());
  const [typeFilter, setTypeFilter] = useState<'ALL' | AccountType>('ALL');
  const [accountFilterId, setAccountFilterId] = useState('ALL');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const typeNames: Record<AccountType, string> = { card: 'Карты', credit_card: 'Кред. карты', savings: 'Накопительные', deposit: 'Вклады', cash: 'Наличные' };
  useEffect(() => { const timer = setInterval(() => setToday(localToday()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (currencies.length && !currencies.includes(currency)) setCurrency(currencies[0] ?? 'UZS'); }, [accounts, plannedExpenses, debts]);
  useEffect(() => { if (accountFilterId !== 'ALL' && !accounts.some((account) => account.id === accountFilterId)) setAccountFilterId('ALL'); }, [accounts, accountFilterId]);
  const year = viewDate.getFullYear(); const month = viewDate.getMonth();
  const accountFilter = (typeFilter === 'ALL' && accountFilterId === 'ALL') ? undefined
    : (account: Account) => (typeFilter === 'ALL' || account.type === typeFilter) && (accountFilterId === 'ALL' || account.id === accountFilterId);
  const activeCalendarFilterCount = (typeFilter !== 'ALL' ? 1 : 0) + (accountFilterId !== 'ALL' ? 1 : 0);
  const calendarFilterSummaryParts = [
    typeFilter !== 'ALL' ? typeNames[typeFilter] : null,
    accountFilterId !== 'ALL' ? (accounts.find((item) => item.id === accountFilterId)?.name ?? null) : null,
  ].filter((part): part is string => !!part);
  const projection = useMemo(() => buildMonthProjection(accounts, currency, year, month, plannedExpenses, debts, currencySettings, today, plannedOccurrences, operations, transfers, accountFilter), [accounts, currency, year, month, plannedExpenses, debts, currencySettings, today, plannedOccurrences, operations, transfers, typeFilter, accountFilterId]);
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  const selectedEvents = projection.events.filter((event) => event.day === selectedDay);
  const delta = projection.closingBalance - projection.openingBalance;
  const selectedDate = toLocalIso(new Date(year, month, selectedDay, 12));
  const visibleFlows = plannedExpenses.filter((flow) => {
    const linkedAccount = accounts.find((account) => account.id === flow.accountId);
    if ((linkedAccount?.currency ?? flow.currency) !== currency) return false;
    if (linkedAccount && accountFilter && !accountFilter(linkedAccount)) return false;
    return true;
  });
  // Past occurrences awaiting confirmation live in plannedOccurrences, not in the (future-only)
  // live projection — buildMonthProjection only generates events for days that haven't passed yet,
  // so there's no overlap between the two sources by construction.
  const pendingByDate = new Map<string, PlannedOccurrence[]>();
  for (const occurrence of plannedOccurrences) {
    if (occurrence.status !== 'planned') continue;
    const flow = plannedExpenses.find((item) => item.id === occurrence.flowId);
    const linkedAccount = flow ? accounts.find((account) => account.id === flow.accountId) : undefined;
    const effectiveCurrency = flow ? (linkedAccount?.currency ?? flow.currency) : occurrence.currency;
    if (effectiveCurrency !== currency) continue;
    if (linkedAccount && accountFilter && !accountFilter(linkedAccount)) continue;
    const list = pendingByDate.get(occurrence.occurrenceDate) ?? [];
    list.push(occurrence);
    pendingByDate.set(occurrence.occurrenceDate, list);
  }
  const selectedOccurrences = pendingByDate.get(selectedDate) ?? [];
  // Past days must show what actually happened, not the (empty, by construction — see
  // buildMonthProjection's `!past` gates) projected events list. Future/today keep the forecast.
  const selectedIsPast = selectedDate < today;
  const dayBalanceLabel = selectedIsPast ? 'Фактический баланс' : 'Прогнозный баланс';
  const trackedAccountIds = new Set(accounts.filter((account) => account.currency === currency && (!accountFilter || accountFilter(account))).map((account) => account.id));
  const factualOperations = selectedIsPast ? operations.filter((op) => op.date === selectedDate && op.status !== 'reversed' && op.currency === currency && trackedAccountIds.has(op.accountId)) : [];
  const factualTransfers = selectedIsPast ? transfers.filter((transfer) => transfer.date === selectedDate && transfer.status !== 'reversed' && ((transfer.fromCurrency === currency && trackedAccountIds.has(transfer.fromAccountId)) || (transfer.toCurrency === currency && trackedAccountIds.has(transfer.toAccountId)))) : [];
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow={`СЕГОДНЯ · ${today} · АФИНА 1.1`} title="Платёжный календарь" onAvatarPress={onProfile} />
    <Pressable style={s.planExpenseButton} onPress={() => onAddExpense(selectedDate)}><Ionicons name="add-circle-outline" size={20} color="white" /><Text style={s.importAccountText}>Запланировать доход или расход</Text></Pressable>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{(currencies.length ? currencies : ['UZS']).map((item) => <Pressable key={item} style={[s.currencyFilter, currency === item && s.currencyFilterActive]} onPress={() => setCurrency(item)}><Text style={[s.currencyFilterText, currency === item && s.currencyFilterTextActive]}>{item}</Text></Pressable>)}</ScrollView>
    <Pressable style={s.groupHeader} onPress={() => setFiltersOpen((value) => !value)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={s.sectionTitle}>Фильтры</Text>
        {activeCalendarFilterCount > 0 && <View style={s.chartBadge}><Text style={s.chartBadgeText}>{activeCalendarFilterCount}</Text></View>}
      </View>
      <Ionicons name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={20} color={C.blue} />
    </Pressable>
    {!filtersOpen && !!calendarFilterSummaryParts.length && <Text style={[s.rowSub, { marginTop: -6, marginBottom: 10 }]}>{calendarFilterSummaryParts.join(' · ')}</Text>}
    {filtersOpen && <>
      <Text style={s.fieldLabel}>ТИП СЧЁТА</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{(['ALL', 'card', 'credit_card', 'savings', 'deposit', 'cash'] as const).map((type) => <Pressable key={type} style={[s.currencyFilter, typeFilter === type && s.currencyFilterActive]} onPress={() => setTypeFilter(type)}><Text style={[s.currencyFilterText, typeFilter === type && s.currencyFilterTextActive]}>{type === 'ALL' ? 'Все' : typeNames[type]}</Text></Pressable>)}</ScrollView>
      <Text style={s.fieldLabel}>СЧЁТ</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{['ALL', ...accounts.filter((account) => typeFilter === 'ALL' || account.type === typeFilter).map((item) => item.id)].map((id) => { const account = accounts.find((item) => item.id === id); return <Pressable key={id} style={[s.currencyFilter, accountFilterId === id && s.currencyFilterActive]} onPress={() => setAccountFilterId(id)}><Text style={[s.currencyFilterText, accountFilterId === id && s.currencyFilterTextActive]}>{id === 'ALL' ? 'Все' : account?.name}</Text></Pressable>; })}</ScrollView>
    </>}
    <View style={s.monthBar}><Pressable onPress={() => { setViewDate(new Date(year, month - 1, 1)); setSelectedDay(1); }}><Ionicons name="chevron-back" size={20} color={C.ink} /></Pressable><Text style={s.month}>{viewDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}</Text><Pressable onPress={() => { setViewDate(new Date(year, month + 1, 1)); setSelectedDay(1); }}><Ionicons name="chevron-forward" size={20} color={C.ink} /></Pressable></View>
    <View style={s.forecastCard}><View><Text style={s.forecastLabel}>ОСТАТОК К КОНЦУ МЕСЯЦА · {currency}</Text><Text style={s.forecastAmount}>{money(projection.closingBalance, false, currency)}</Text></View><View style={s.forecastPill}><Text style={[s.forecastPillText, delta >= 0 && { color: '#DCE7DD' }]}>{delta >= 0 ? '+' : '−'}{money(Math.abs(delta), true, currency)}</Text></View></View>
    <View style={s.weekHead}>{['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map((day) => <Text key={day} style={s.weekDay}>{day}</Text>)}</View>
    <View style={s.calendarGrid}>{Array.from({ length: offset }, (_, index) => <View key={`empty-${index}`} style={s.dayCell} />)}{projection.days.map((item) => { const isToday = item.date === today; const hasPending = pendingByDate.has(item.date); return <Pressable key={item.day} onPress={() => setSelectedDay(item.day)} style={[s.dayCell, item.risky && s.riskyDay, isToday && s.todayMarker, selectedDay === item.day && s.selectedDay]}><Text style={[s.dayNumber, item.risky && { color: C.red }, isToday && { color: C.blue }]}>{item.day}</Text><Text style={[s.dayBalance, item.risky && { color: C.red }]}>{money(item.balance, true, currency).replace(` ${currency}`, '')}</Text><View style={s.dots}>{item.income > 0 && <View style={[s.dot, { backgroundColor: C.green }]} />}{item.expense > 0 && <View style={[s.dot, { backgroundColor: C.blue }]} />}{hasPending && <View style={[s.dot, { backgroundColor: C.muted }]} />}</View></Pressable>; })}</View>
    <View style={s.legend}><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.green }]} /><Text style={s.legendText}>Доход</Text></View><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.blue }]} /><Text style={s.legendText}>Расход</Text></View><View style={s.legendItem}><View style={[s.dot, { backgroundColor: C.red }]} /><Text style={s.legendText}>Разрыв</Text></View></View>
    <SectionTitle title={`${selectedDay} ${viewDate.toLocaleString('ru-RU', { month: 'long' })} · ${dayBalanceLabel}`} />
    {selectedIsPast ? (
      (factualOperations.length || factualTransfers.length) ? <View style={s.card}>
        {factualOperations.map((operation, index) => <View key={`fo-${operation.id}`}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: operation.kind === 'income' ? C.sageSoft : C.redSoft }]}><Ionicons name={operation.kind === 'income' ? 'sparkles-outline' : 'receipt-outline'} size={20} color={operation.kind === 'income' ? C.green : C.red} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{operation.title || operation.category}</Text><Text style={s.rowSub}>{operation.category}</Text></View>{operation.kind === 'income' ? <Text style={s.income}>+{money(operation.amount, false, currency)}</Text> : <Text style={s.expense}>−{money(operation.amount, false, currency)}</Text>}</View>{(index < factualOperations.length - 1 || factualTransfers.length > 0) && <View style={s.divider} />}</View>)}
        {factualTransfers.map((transfer, index) => { const fromAccount = accounts.find((item) => item.id === transfer.fromAccountId); const toAccount = accounts.find((item) => item.id === transfer.toAccountId); return <View key={`ft-${transfer.id}`}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: `${C.blue}18` }]}><Ionicons name="swap-horizontal-outline" size={19} color={C.blue} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{fromAccount?.name ?? 'Счёт удалён'} → {toAccount?.name ?? 'Счёт удалён'}</Text><Text style={s.rowSub}>Перевод</Text></View><Text style={{ color: C.blue, fontWeight: '600' }}>{transfer.fromCurrency === transfer.toCurrency ? money(transfer.fromAmount, false, transfer.fromCurrency) : `${money(transfer.fromAmount, false, transfer.fromCurrency)} → ${money(transfer.toAmount, false, transfer.toCurrency)}`}</Text></View>{index < factualTransfers.length - 1 && <View style={s.divider} />}</View>; })}
      </View> : <View style={s.emptyCard}><Text style={s.emptyText}>В этот день операций не было. Фактический баланс: {money(projection.days[selectedDay - 1]?.balance ?? projection.openingBalance, false, currency)}</Text></View>
    ) : (
      selectedEvents.length ? <View style={s.card}>{selectedEvents.map((event, index) => { const outgoing = event.kind === 'expense' || event.kind === 'debt_expense' || event.kind === 'credit_payment'; const incoming = event.kind === 'interest' || event.kind === 'debt_income' || event.kind === 'planned_income'; return <View key={`${event.accountId}-${event.kind}-${index}`}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: outgoing ? C.redSoft : event.kind === 'reminder' ? C.bg : C.sageSoft }]}><Ionicons name={event.kind.startsWith('debt_') ? 'people-outline' : event.kind === 'credit_payment' ? 'card-outline' : outgoing ? 'receipt-outline' : event.kind === 'reminder' ? 'notifications-outline' : 'sparkles-outline'} size={20} color={outgoing ? C.red : event.kind === 'reminder' ? C.blue : C.green} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{event.title}</Text><Text style={s.rowSub}>{event.kind === 'planned_income' ? 'Запланированный доход' : event.kind === 'expense' ? 'Запланированный расход' : event.kind === 'credit_payment' ? 'Минимальный платёж по кредитной карте' : event.kind === 'reminder' ? 'Напоминание' : event.kind.startsWith('debt_') ? 'Платёж по долгу' : 'Процентный доход'}</Text></View>{incoming && <Text style={s.income}>+{money(event.amount, false, currency)}</Text>}{outgoing && <Text style={s.expense}>−{money(event.amount, false, currency)}</Text>}</View>{index < selectedEvents.length - 1 && <View style={s.divider} />}</View>; })}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>На этот день событий нет. Прогнозный баланс: {money(projection.days[selectedDay - 1]?.balance ?? projection.openingBalance, false, currency)}</Text></View>
    )}
    {selectedOccurrences.length > 0 && <><SectionTitle title="Ожидают подтверждения" /><View style={s.card}>{selectedOccurrences.map((occurrence, index) => { const flow = plannedExpenses.find((item) => item.id === occurrence.flowId); if (!flow) return null; return <View key={occurrence.id}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: C.bg }]}><Ionicons name="time-outline" size={20} color={C.muted} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{flow.title}</Text><Text style={s.rowSub}>План: {money(occurrence.amount, false, occurrence.currency)}</Text></View><Pressable onPress={() => onExecuteOccurrence(occurrence, flow)}><Text style={s.link}>Провести</Text></Pressable></View><Pressable onPress={() => onCancelOccurrence(occurrence)}><Text style={[s.link, { color: C.red, textAlign: 'right' }]}>Отменить</Text></Pressable>{index < selectedOccurrences.length - 1 && <View style={s.divider} />}</View>; })}</View></>}
    <SectionTitle title="Запланированные движения" action="+ Добавить" onAction={() => onAddExpense(selectedDate)} />
    {visibleFlows.length ? <View style={s.card}>{visibleFlows.map((flow, index) => <Pressable key={flow.id} onPress={() => onEditExpense(flow)}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: flow.kind === 'income' ? C.sageSoft : C.redSoft }]}><Ionicons name="repeat-outline" size={20} color={flow.kind === 'income' ? C.green : C.red} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{flow.title}</Text><Text style={s.rowSub}>{flow.category} · {recurrenceLabel(flow)} · с {flow.startDate}{flow.currency !== currency ? ` · ${flow.currency} → ${currency}` : ''}</Text></View><Text style={flow.kind === 'income' ? s.income : s.expense}>{flow.kind === 'income' ? '+' : '−'}{money(flow.amount, false, flow.currency)}</Text></View>{index < visibleFlows.length - 1 && <View style={s.divider} />}</Pressable>)}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Движений в {currency} пока не запланировано</Text></View>}
    <View style={{ height: 20 }} />
  </ScrollView>;
}

type OperationFeedRow = { key: string; date: string; kind: 'operation'; operation: FinancialOperation } | { key: string; date: string; kind: 'transfer'; transfer: Transfer };

function Operations({ operations, transfers, plannedOccurrences, plannedExpenses, accounts, onAdd, onTransfer, onReverseTransfer, onExecuteOccurrence, onCancelOccurrence, onProfile }: {
  operations: FinancialOperation[]; transfers: Transfer[]; plannedOccurrences: PlannedOccurrence[]; plannedExpenses: PlannedExpense[]; accounts: Account[];
  onAdd: () => void; onTransfer: () => void; onReverseTransfer: (transfer: Transfer) => void;
  onExecuteOccurrence: (occurrence: PlannedOccurrence, flow: PlannedExpense) => void; onCancelOccurrence: (occurrence: PlannedOccurrence) => void; onProfile: () => void;
}) {
  const pendingOccurrences = plannedOccurrences.filter((occurrence) => occurrence.status === 'planned').sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate));
  const [currency, setCurrency] = useState('ALL'); const [accountId, setAccountId] = useState('ALL'); const [category, setCategory] = useState('ALL');
  const [fromDate, setFromDate] = useState(''); const [toDate, setToDate] = useState(''); const [dateTarget, setDateTarget] = useState<'from' | 'to' | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [viewingReceipt, setViewingReceipt] = useState<string | null>(null);
  const currencies = Array.from(new Set([...operations.map((item) => item.currency), ...transfers.flatMap((item) => [item.fromCurrency, item.toCurrency])])).sort(); const categories = Array.from(new Set(operations.map((item) => item.category))).sort();
  const filtered = operations.filter((item) => (currency === 'ALL' || item.currency === currency) && (accountId === 'ALL' || item.accountId === accountId) && (category === 'ALL' || item.category === category) && (!fromDate || item.date >= fromDate) && (!toDate || item.date <= toDate));
  // Transfers have no category of their own, so a category filter (which only makes sense for
  // income/expense) hides them rather than showing them under an unrelated category.
  const filteredTransfers = category === 'ALL' ? transfers.filter((item) => (currency === 'ALL' || item.fromCurrency === currency || item.toCurrency === currency) && (accountId === 'ALL' || item.fromAccountId === accountId || item.toAccountId === accountId) && (!fromDate || item.date >= fromDate) && (!toDate || item.date <= toDate)) : [];
  const feed: OperationFeedRow[] = [
    ...filtered.map((operation) => ({ key: `op-${operation.id}`, date: operation.date, kind: 'operation' as const, operation })),
    ...filteredTransfers.map((transfer) => ({ key: `tr-${transfer.id}`, date: transfer.date, kind: 'transfer' as const, transfer })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const activeFilterCount = (currency !== 'ALL' ? 1 : 0) + (accountId !== 'ALL' ? 1 : 0) + (category !== 'ALL' ? 1 : 0) + (fromDate || toDate ? 1 : 0);
  const filterSummaryParts = [
    currency !== 'ALL' ? currency : null,
    accountId !== 'ALL' ? (accounts.find((item) => item.id === accountId)?.name ?? null) : null,
    category !== 'ALL' ? category : null,
    fromDate || toDate ? `${fromDate || '…'} – ${toDate || '…'}` : null,
  ].filter((part): part is string => !!part);
  // Excludes reversed operations and reversals of a reversed operation (same rule
  // summarizeOperations already applies), so these tiles match what's actually visible below,
  // not a raw sum that includes struck-through rows.
  const reversedOperationIds = new Set(operations.filter((item) => item.status === 'reversed').map((item) => item.id));
  const liveFiltered = filtered.filter((item) => item.status !== 'reversed' && !(item.relatedOperationId && reversedOperationIds.has(item.relatedOperationId)));
  const liveTransfers = filteredTransfers.filter((item) => item.status !== 'reversed');
  const summaryCurrencies = Array.from(new Set([...liveFiltered.map((item) => item.currency), ...liveTransfers.flatMap((item) => [item.fromCurrency, item.toCurrency])]));
  const summaryCurrency = summaryCurrencies.length === 1 ? summaryCurrencies[0] : undefined;
  const summaryIncome = summaryCurrency ? liveFiltered.filter((item) => item.kind === 'income').reduce((sum, item) => sum + item.amount, 0) : 0;
  const summaryExpense = summaryCurrency ? liveFiltered.filter((item) => item.kind === 'expense').reduce((sum, item) => sum + item.amount, 0) : 0;
  const summaryTransfers = summaryCurrency ? liveTransfers.filter((item) => item.fromCurrency === summaryCurrency).reduce((sum, item) => sum + item.fromAmount, 0) : 0;
  const summaryPeriodLabel = fromDate && toDate ? `${fromDate} – ${toDate}` : fromDate ? `с ${fromDate}` : toDate ? `по ${toDate}` : 'за всё время';
  const today = localToday();
  const yesterday = addLocalDays(today, -1);
  const dayGroupLabel = (iso: string) => {
    const formatted = dateFromIso(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long' });
    if (iso === today) return `${formatted} · Сегодня`;
    if (iso === yesterday) return `${formatted} · Вчера`;
    return formatted;
  };
  // Daily interest postings dominate this feed (one row per account per day); collapsing
  // consecutive same-account/currency/category interest rows into one expandable group keeps
  // the occasional real operation from getting lost in a wall of identical-looking entries.
  type DisplayRow = { key: string; kind: 'single'; row: OperationFeedRow } | { key: string; kind: 'interestGroup'; operations: FinancialOperation[] };
  const displayRows: DisplayRow[] = [];
  for (const row of feed) {
    const isInterest = row.kind === 'operation' && row.operation.source === 'interest' && row.operation.status !== 'reversed';
    const last = displayRows[displayRows.length - 1];
    if (isInterest && row.kind === 'operation' && last?.kind === 'interestGroup') {
      const lastOp = last.operations[last.operations.length - 1]!;
      const op = row.operation;
      if (lastOp.accountId === op.accountId && lastOp.currency === op.currency && lastOp.category === op.category && (lastOp.interestSourceAccountId ?? lastOp.accountId) === (op.interestSourceAccountId ?? op.accountId)) {
        last.operations.push(op);
        continue;
      }
    }
    if (isInterest && row.kind === 'operation') displayRows.push({ key: `grp-${row.key}`, kind: 'interestGroup', operations: [row.operation] });
    else displayRows.push({ key: row.key, kind: 'single', row });
  }
  // The date a display row visually sits under -- for an interest group this is its most recent
  // date (operations[0], since the group is built by prepending onto a descending-sorted feed),
  // not every date the group actually spans. Keeps the header math consistent with what's visibly
  // grouped under it, instead of a date range's operations being split across two headers.
  const bucketDateOf = (entry: DisplayRow): string => entry.kind === 'single' ? entry.row.date : entry.operations[0]!.date;
  // Only computed when the whole screen is already single-currency (summaryCurrency defined) --
  // same guard as the top tiles, so a per-day total never silently sums two currencies together.
  // Expenses only (not net income-expense, not transfers) -- matches the reference pattern from
  // Sberbank's own history screen, where the day header shows that day's total spend.
  const dayExpenseByDate = new Map<string, number>();
  if (summaryCurrency) {
    for (const entry of displayRows) {
      const date = bucketDateOf(entry);
      let delta = 0;
      if (entry.kind === 'single' && entry.row.kind === 'operation') {
        const op = entry.row.operation;
        if (op.kind === 'expense' && op.currency === summaryCurrency && op.status !== 'reversed' && !(op.relatedOperationId && reversedOperationIds.has(op.relatedOperationId))) {
          delta = op.amount;
        }
      }
      if (delta) dayExpenseByDate.set(date, (dayExpenseByDate.get(date) ?? 0) + delta);
    }
  }
  const renderOperation = (operation: FinancialOperation) => {
    const account = accounts.find((item) => item.id === operation.accountId); const cancelled = operation.status === 'reversed';
    const deviates = operation.plannedAmount !== undefined && operation.plannedCurrency !== undefined && (Math.abs(operation.plannedAmount - operation.amount) > 0.005 || operation.plannedCurrency !== operation.currency);
    return <View style={[s.eventRow, cancelled && { opacity: .55 }]}><View style={[s.roundIcon, { backgroundColor: operation.kind === 'income' ? C.sageSoft : C.redSoft }]}><Ionicons name={operation.relatedOperationId ? 'return-down-back-outline' : operation.sourceOccurrenceId ? 'checkmark-done-outline' : operation.kind === 'income' ? 'arrow-down-outline' : 'arrow-up-outline'} size={19} color={operation.kind === 'income' ? C.green : C.red} /></View><View style={{ flex: 1 }}><Text style={[s.rowTitle, cancelled && { textDecorationLine: 'line-through' }]}>{operation.title}</Text><Text style={s.rowSub}>{operation.category} · {account?.name ?? 'Счёт удалён'}{cancelled ? ' · отменено' : operation.relatedOperationId ? ' · обратная проводка' : ''}</Text>{deviates && <Text style={s.rowSub}>план {money(operation.plannedAmount!, false, operation.plannedCurrency!)}</Text>}</View><Text style={operation.kind === 'income' ? s.income : s.expense}>{operation.kind === 'income' ? '+' : '−'}{money(operation.amount, false, operation.currency)}</Text>{!!operation.receiptPhotoUri && <Pressable onPress={() => setViewingReceipt(operation.receiptPhotoUri!)} hitSlop={8} style={{ marginLeft: 8 }}><Ionicons name="receipt-outline" size={18} color={C.blue} /></Pressable>}</View>;
  };
  const confirmReverseTransfer = (transfer: Transfer) => {
    const fromAccount = accounts.find((item) => item.id === transfer.fromAccountId);
    const toAccount = accounts.find((item) => item.id === transfer.toAccountId);
    const partialWarning = !fromAccount || !toAccount
      ? '\n\nОдин из счетов этого перевода удалён — отмена вернёт деньги только на оставшийся счёт.'
      : '';
    Alert.alert('Отменить перевод?', `${fromAccount?.name ?? 'Счёт удалён'} → ${toAccount?.name ?? 'Счёт удалён'}, ${money(transfer.fromAmount, false, transfer.fromCurrency)}${partialWarning}`, [
      { text: 'Не отменять', style: 'cancel' },
      { text: 'Отменить перевод', style: 'destructive', onPress: () => onReverseTransfer(transfer) },
    ]);
  };
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}><Header eyebrow="ДВИЖЕНИЕ ДЕНЕГ" title="Операции" onAvatarPress={onProfile} />
    <View style={s.twoColumns}>
      <Pressable style={[s.planExpenseButton, { flex: 1 }]} onPress={onAdd}><Ionicons name="add-circle-outline" size={20} color="white" /><Text style={s.importAccountText}>Добавить операцию</Text></Pressable>
      <Pressable style={[s.planExpenseButton, { flex: 1, backgroundColor: C.blue }]} onPress={onTransfer}><Ionicons name="swap-horizontal-outline" size={20} color="white" /><Text style={s.importAccountText}>Перевод</Text></Pressable>
    </View>
    {summaryCurrency ? <View style={s.metricRow}>
      <View style={s.metric}><Text style={s.metricLabel}>ДОХОДЫ</Text><Text style={[s.metricValue, { color: C.green }]}>+{money(summaryIncome, true, summaryCurrency)}</Text><Text style={s.metricSub}>{summaryPeriodLabel}</Text></View>
      <View style={s.metric}><Text style={s.metricLabel}>РАСХОДЫ</Text><Text style={[s.metricValue, { color: C.red }]}>−{money(summaryExpense, true, summaryCurrency)}</Text><Text style={s.metricSub}>{summaryPeriodLabel}</Text></View>
      <View style={s.metric}><Text style={s.metricLabel}>ПЕРЕВОДЫ</Text><Text style={[s.metricValue, { color: C.blue }]}>{money(summaryTransfers, true, summaryCurrency)}</Text><Text style={s.metricSub}>{summaryPeriodLabel}</Text></View>
    </View> : (liveFiltered.length > 0 || liveTransfers.length > 0) && <Pressable style={s.metric} onPress={() => { setFiltersOpen(true); setCurrency(summaryCurrencies[0] ?? 'ALL'); }}>
      <Text style={s.metricLabel}>СУММЫ ЗА ПЕРИОД</Text><Text style={s.rowSub}>Выберите одну валюту в фильтрах, чтобы увидеть суммы — сейчас в списке несколько валют сразу</Text>
    </Pressable>}
    {pendingOccurrences.length > 0 && <><SectionTitle title={`Ожидают подтверждения · ${pendingOccurrences.length}`} /><View style={s.card}>{pendingOccurrences.map((occurrence, index) => {
      const flow = plannedExpenses.find((item) => item.id === occurrence.flowId);
      if (!flow) return null;
      return <View key={occurrence.id}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: C.bg }]}><Ionicons name="time-outline" size={19} color={C.muted} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{flow.title}</Text><Text style={s.rowSub}>{occurrence.occurrenceDate} · план {money(occurrence.amount, false, occurrence.currency)}</Text></View><Pressable onPress={() => onExecuteOccurrence(occurrence, flow)}><Text style={s.link}>Провести</Text></Pressable></View><Pressable onPress={() => onCancelOccurrence(occurrence)}><Text style={[s.link, { color: C.red, textAlign: 'right' }]}>Отменить</Text></Pressable>{index < pendingOccurrences.length - 1 && <View style={s.divider} />}</View>;
    })}</View></>}
    <Pressable style={s.groupHeader} onPress={() => setFiltersOpen((value) => !value)}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={s.sectionTitle}>Фильтры</Text>
        {activeFilterCount > 0 && <View style={s.chartBadge}><Text style={s.chartBadgeText}>{activeFilterCount}</Text></View>}
      </View>
      <Ionicons name={filtersOpen ? 'chevron-up' : 'chevron-down'} size={20} color={C.blue} />
    </Pressable>
    {!filtersOpen && !!filterSummaryParts.length && <Text style={[s.rowSub, { marginTop: -6, marginBottom: 10 }]}>{filterSummaryParts.join(' · ')}</Text>}
    {filtersOpen && <>
      <Text style={s.fieldLabel}>ВАЛЮТА</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{['ALL', ...currencies].map((item) => <Pressable key={item} style={[s.currencyFilter, currency === item && s.currencyFilterActive]} onPress={() => setCurrency(item)}><Text style={[s.currencyFilterText, currency === item && s.currencyFilterTextActive]}>{item === 'ALL' ? 'Все' : item}</Text></Pressable>)}</ScrollView>
      <Text style={s.fieldLabel}>СЧЁТ</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{['ALL', ...accounts.map((item) => item.id)].map((id) => { const account = accounts.find((item) => item.id === id); return <Pressable key={id} style={[s.currencyFilter, accountId === id && s.currencyFilterActive]} onPress={() => setAccountId(id)}><Text style={[s.currencyFilterText, accountId === id && s.currencyFilterTextActive]}>{id === 'ALL' ? 'Все' : account?.name}</Text></Pressable>; })}</ScrollView>
      <Text style={s.fieldLabel}>КАТЕГОРИЯ</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{['ALL', ...categories].map((item) => <Pressable key={item} style={[s.currencyFilter, category === item && s.currencyFilterActive]} onPress={() => setCategory(item)}><Text style={[s.currencyFilterText, category === item && s.currencyFilterTextActive]}>{item === 'ALL' ? 'Все' : item}</Text></Pressable>)}</ScrollView>
      <Text style={s.fieldLabel}>ПЕРИОД</Text><View style={s.twoColumns}><View style={{ flex: 1 }}><DateField value={fromDate} onPress={() => setDateTarget('from')} placeholder="С даты" /></View><View style={{ flex: 1 }}><DateField value={toDate} onPress={() => setDateTarget('to')} placeholder="По дату" /></View></View>{(fromDate || toDate) && <Pressable onPress={() => { setFromDate(''); setToDate(''); }}><Text style={s.link}>Сбросить период</Text></Pressable>}
    </>}
    <SectionTitle title={`Найдено: ${feed.length}`} />{displayRows.length ? <View style={s.card}>{displayRows.flatMap((entry, index) => {
      const bucketDate = bucketDateOf(entry);
      const nextEntry = displayRows[index + 1];
      const isLastInGroup = !nextEntry || bucketDateOf(nextEntry) !== bucketDate;
      const header = index === 0 || bucketDateOf(displayRows[index - 1]!) !== bucketDate
        ? <View key={`hdr-${bucketDate}`} style={[s.dayGroupHeader, index > 0 && { marginTop: 14 }]}>
            <Text style={s.dayGroupLabel}>{dayGroupLabel(bucketDate)}</Text>
            {dayExpenseByDate.has(bucketDate) && <Text style={s.expense}>−{money(dayExpenseByDate.get(bucketDate) ?? 0, true, summaryCurrency!)}</Text>}
          </View>
        : null;
      let content: React.ReactNode;
      if (entry.kind === 'single') {
        const row = entry.row;
        if (row.kind === 'transfer') {
          const transfer = row.transfer; const fromAccount = accounts.find((item) => item.id === transfer.fromAccountId); const toAccount = accounts.find((item) => item.id === transfer.toAccountId); const cancelled = transfer.status === 'reversed';
          content = <Pressable key={entry.key} disabled={cancelled} onPress={() => confirmReverseTransfer(transfer)}><View style={[s.eventRow, cancelled && { opacity: .55 }]}><View style={[s.roundIcon, { backgroundColor: `${C.blue}18` }]}><Ionicons name="swap-horizontal-outline" size={19} color={C.blue} /></View><View style={{ flex: 1 }}><Text style={[s.rowTitle, cancelled && { textDecorationLine: 'line-through' }]}>{fromAccount?.name ?? 'Счёт удалён'} → {toAccount?.name ?? 'Счёт удалён'}</Text><Text style={s.rowSub}>Перевод{transfer.note ? ` · ${transfer.note}` : ''}{cancelled ? ' · отменено' : ''}</Text></View><Text style={{ color: C.blue, fontWeight: '600' }}>{transfer.fromCurrency === transfer.toCurrency ? money(transfer.fromAmount, false, transfer.fromCurrency) : `${money(transfer.fromAmount, false, transfer.fromCurrency)} → ${money(transfer.toAmount, false, transfer.toCurrency)}`}</Text></View>{!isLastInGroup && <View style={s.divider} />}</Pressable>;
        } else {
          content = <View key={entry.key}>{renderOperation(row.operation)}{!isLastInGroup && <View style={s.divider} />}</View>;
        }
      } else if (entry.operations.length === 1) {
        content = <View key={entry.key}>{renderOperation(entry.operations[0]!)}{!isLastInGroup && <View style={s.divider} />}</View>;
      } else {
        const expanded = !!expandedGroups[entry.key];
        const total = entry.operations.reduce((sum, op) => sum + op.amount, 0);
        const account = accounts.find((item) => item.id === entry.operations[0]!.accountId);
        const dates = entry.operations.map((op) => op.date).sort();
        const sortedOps = entry.operations.slice().sort((a, b) => b.date.localeCompare(a.date));
        content = <View key={entry.key}>
          <Pressable onPress={() => setExpandedGroups((current) => ({ ...current, [entry.key]: !current[entry.key] }))}>
            <View style={s.eventRow}>
              <View style={[s.roundIcon, { backgroundColor: C.sageSoft }]}><Ionicons name="leaf-outline" size={19} color={C.green} /></View>
              <View style={{ flex: 1 }}><Text style={s.rowTitle}>{entry.operations[0]!.title}</Text><Text style={s.rowSub}>{dates[0]} – {dates[dates.length - 1]} · {entry.operations.length} начислений{account ? ` · ${account.name}` : ''}</Text></View>
              <Text style={s.income}>+{money(total, false, entry.operations[0]!.currency)}</Text>
              <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={C.muted} style={{ marginLeft: 8 }} />
            </View>
          </Pressable>
          {expanded && sortedOps.map((op, opIndex) => <View key={op.id} style={{ paddingLeft: 20 }}>{renderOperation(op)}{opIndex < sortedOps.length - 1 && <View style={s.divider} />}</View>)}
          {!isLastInGroup && <View style={s.divider} />}
        </View>;
      }
      return header ? [header, content] : [content];
    })}</View> : <View style={s.emptyCard}><Ionicons name="receipt-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Операции не найдены</Text><Text style={s.emptyText}>Измените фильтры или добавьте новую операцию</Text></View>}
    <DatePickerModal visible={dateTarget !== null} value={dateTarget === 'to' ? toDate : fromDate} onClose={() => setDateTarget(null)} onSelect={(value) => dateTarget === 'to' ? setToDate(value) : setFromDate(value)} />
    <ReceiptViewerModal uri={viewingReceipt} onClose={() => setViewingReceipt(null)} />
  </ScrollView>;
}

function ReceiptViewerModal({ uri, onClose }: { uri: string | null; onClose: () => void }) {
  return <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onClose}>
    <View style={s.receiptOverlay}>
      <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
      <Pressable style={[s.close, s.receiptClose]} onPress={onClose}><Ionicons name="close" size={22} color={C.ink} /></Pressable>
      {!!uri && <Image source={{ uri }} style={s.receiptImage} resizeMode="contain" />}
    </View>
  </Modal>;
}

// Senders with a registered parser (see src/sms/registry.ts).
const KNOWN_SMS_SENDERS = ['kapitalbank', '13131', '2212', '900'];

// Foreground scan only — on app launch and on return from background, per the architecture plan:
// a background listener needs a foreground-service notification on Android 8+ and still gets
// killed by OEM battery managers, for a feature whose UX already requires opening the app to
// confirm a draft. Silently does nothing if the reader is unavailable (iOS) or permission was
// never granted — this never prompts on its own, only an explicit tap in Profile does.
async function scanSmsInbox(): Promise<void> {
  if (!isSmsReaderAvailable) return;
  if (!(await hasSmsPermission())) return;
  const watermark = await getSmsScanWatermark();
  const sinceEpochMs = watermark ? new Date(watermark).getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
  const scanStartedAt = new Date().toISOString();
  const messages = await readSmsInbox(sinceEpochMs, KNOWN_SMS_SENDERS);
  for (const message of messages) {
    const sender = message.address.trim().toLowerCase();
    const result = parseSms(sender, message.body);
    await createImportDraft({
      source: 'sms', sender, rawBody: message.body, receivedAt: new Date(message.dateMs).toISOString(),
      parsed: result?.parsed ?? null, parserId: result?.parserId,
    });
  }
  // Advances to when this scan started, not to the last message's own timestamp — so a message
  // that arrives mid-scan (after the read but before this line) gets picked up next time instead
  // of silently falling into the gap between the two watermarks.
  await setSmsScanWatermark(scanStartedAt);
}

function ImportDraftCard({ draft, accounts, onConfirm, onDismiss }: { draft: ImportDraft; accounts: Account[]; onConfirm: (accountId: string, includeFee: boolean, transferCounterpartyId?: string) => void; onDismiss: () => void }) {
  const [accountId, setAccountId] = useState(draft.accountId);
  const [includeFee, setIncludeFee] = useState(true);
  // Collapsed by default once a card_last4 match already picked an account — the full account
  // list is only useful when that guess needs overriding, not as a wall of options on every card.
  const [pickerOpen, setPickerOpen] = useState(!draft.accountId);
  const [isTransfer, setIsTransfer] = useState(false);
  const [counterpartyId, setCounterpartyId] = useState<string | undefined>();
  const [counterpartyPickerOpen, setCounterpartyPickerOpen] = useState(true);
  useEffect(() => { setAccountId(draft.accountId); setPickerOpen(!draft.accountId); }, [draft.accountId]);
  const selectedAccount = accounts.find((item) => item.id === accountId);
  const selectedCounterparty = accounts.find((item) => item.id === counterpartyId);
  // There's no card/account number for the other side of a transfer (a deposit's own SMS never
  // mentions it) — so this can only ever be a ranked guess for the user to confirm or override,
  // never an auto-pick. Same-currency is a hard filter (see confirmImportDraftAsTransfer's own
  // comment on why); type/bank/balance only reorder the list, they never exclude an option.
  const looksDepositSourced = /\bdep\b/i.test(draft.merchant ?? '');
  const counterpartyOptions = accounts
    .filter((item) => item.id !== accountId && item.currency === draft.currency)
    .slice()
    .sort((a, b) => {
      const score = (item: Account) => {
        let value = 0;
        if (looksDepositSourced && (item.type === 'deposit' || item.type === 'savings')) value += 2;
        if (draft.source === 'sms' && item.subtitle.toLowerCase().includes(draft.sender.toLowerCase())) value += 2;
        if (draft.amount !== undefined && item.balance >= draft.amount) value += 1;
        return value;
      };
      return score(b) - score(a);
    });
  const sourceLabel = draft.source === 'push' ? 'Push' : 'SMS';
  if (draft.status === 'unrecognized') {
    return <View style={[s.card, { padding: 16 }]}>
      <Text style={s.rowTitle}>Не распознано · {sourceLabel}</Text>
      <Text style={[s.rowSub, { marginTop: 4 }]}>{draft.sender} · {draft.rawBody.slice(0, 90)}{draft.rawBody.length > 90 ? '…' : ''}</Text>
      <Pressable style={[s.secondaryButton, { marginTop: 8 }]} onPress={onDismiss}><Text style={s.secondaryText}>Убрать</Text></Pressable>
    </View>;
  }
  return <View style={[s.card, { padding: 16 }]}>
    <View style={s.budgetTop}><Text style={s.rowTitle}>{draft.merchant || (draft.kind === 'income' ? 'Поступление' : 'Операция по карте')}</Text><Text style={draft.kind === 'income' ? s.income : s.expense}>{draft.kind === 'income' ? '+' : '−'}{money(draft.amount ?? 0, false, draft.currency)}</Text></View>
    <Text style={s.rowSub}>{sourceLabel} · {draft.occurredAt?.replace('T', ' ')}{draft.cardLast4 ? ` · карта •${draft.cardLast4}` : ''}</Text>
    {!!draft.dedupOperationId && <Text style={[s.rowSub, { color: C.red, marginTop: 4 }]}>Похоже, эта операция уже учтена в Афине (вручную или автоматически, например проценты по вкладу) — проверьте перед подтверждением</Text>}
    <Text style={[s.fieldLabel, { marginTop: 10 }]}>СЧЁТ</Text>
    {pickerOpen ? <View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, accountId === item.id && s.targetAccountActive]} onPress={() => { setAccountId(item.id); setPickerOpen(false); }}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text></Pressable>)}</View>
      : <Pressable style={[s.targetAccount, s.targetAccountActive, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]} onPress={() => setPickerOpen(true)}>
          <Text style={s.targetAccountText}>{selectedAccount ? `${selectedAccount.name} · ${selectedAccount.currency}` : 'Выбрать счёт'}</Text>
          <Ionicons name="chevron-down" size={16} color={C.muted} />
        </Pressable>}
    {!!draft.feeAmount && <Pressable style={[s.eventRow, { minHeight: 40 }]} onPress={() => setIncludeFee((value) => !value)}>
      <Ionicons name={includeFee ? 'checkbox' : 'square-outline'} size={20} color={C.blue} />
      <Text style={[s.rowSub, { marginLeft: 8 }]}>Провести комиссию {money(draft.feeAmount, false, draft.currency)} отдельной операцией</Text>
    </Pressable>}
    <Pressable style={[s.eventRow, { minHeight: 40 }]} onPress={() => setIsTransfer((value) => !value)}>
      <Ionicons name={isTransfer ? 'checkbox' : 'square-outline'} size={20} color={C.blue} />
      <Text style={[s.rowSub, { marginLeft: 8 }]}>Это перевод между своими счетами (например, со вклада)</Text>
    </Pressable>
    {isTransfer && <>
      <Text style={[s.fieldLabel, { marginTop: 4 }]}>{draft.kind === 'income' ? 'СЧЁТ СПИСАНИЯ' : 'СЧЁТ ЗАЧИСЛЕНИЯ'}</Text>
      {!counterpartyOptions.length ? <Text style={s.rowSub}>Нет других счетов в {draft.currency}</Text>
        : counterpartyPickerOpen ? <View style={s.targetList}>{counterpartyOptions.map((item) => <Pressable key={item.id} style={[s.targetAccount, counterpartyId === item.id && s.targetAccountActive]} onPress={() => { setCounterpartyId(item.id); setCounterpartyPickerOpen(false); }}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text></Pressable>)}</View>
          : <Pressable style={[s.targetAccount, s.targetAccountActive, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]} onPress={() => setCounterpartyPickerOpen(true)}>
              <Text style={s.targetAccountText}>{selectedCounterparty ? `${selectedCounterparty.name} · ${selectedCounterparty.currency}` : 'Выбрать счёт'}</Text>
              <Ionicons name="chevron-down" size={16} color={C.muted} />
            </Pressable>}
    </>}
    <View style={[s.twoColumns, { marginTop: 10 }]}>
      <Pressable style={[s.secondaryButton, { flex: 1 }]} onPress={onDismiss}><Text style={s.secondaryText}>Отклонить</Text></Pressable>
      <Pressable style={[s.primaryButton, { flex: 1, marginTop: 0 }]} disabled={!accountId || (isTransfer && !counterpartyId)} onPress={() => accountId && onConfirm(accountId, includeFee, isTransfer ? counterpartyId : undefined)}><Text style={s.primaryText}>Подтвердить</Text></Pressable>
    </View>
  </View>;
}

const KNOWN_BANK_PACKAGE_LIST = Object.entries(KNOWN_BANK_PACKAGES);

function ImportDraftsModal({ visible, accounts, onClose }: { visible: boolean; accounts: Account[]; onClose: () => void }) {
  const [channel, setChannel] = useState<'sms' | 'push'>('sms');
  const [sender, setSender] = useState(KNOWN_SMS_SENDERS[0]!);
  const [bankKey, setBankKey] = useState(KNOWN_BANK_PACKAGE_LIST[0]![0]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [drafts, setDrafts] = useState<ImportDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const reload = async () => setDrafts(await listImportDrafts());
  useEffect(() => { if (visible) reload(); }, [visible]);
  const handleParse = async () => {
    if (!body.trim()) return;
    setLoading(true);
    try {
      if (channel === 'sms') {
        const result = parseSms(sender, body.trim());
        await createImportDraft({ source: 'sms', sender, rawBody: body.trim(), receivedAt: new Date().toISOString(), parsed: result?.parsed ?? null, parserId: result?.parserId });
      } else {
        const packageName = KNOWN_BANK_PACKAGES[bankKey]!;
        const result = parsePush(packageName, title.trim(), body.trim());
        await createImportDraft({ source: 'push', sender: packageName, rawBody: `${title.trim()}\n${body.trim()}`, receivedAt: new Date().toISOString(), parsed: result?.parsed ?? null, parserId: result?.parserId });
      }
      setTitle(''); setBody(''); await reload();
    } finally { setLoading(false); }
  };
  const handleConfirm = async (draft: ImportDraft, accountId: string, includeFee: boolean, transferCounterpartyId?: string) => {
    try {
      if (transferCounterpartyId) await confirmImportDraftAsTransfer(draft.id, { counterpartyAccountId: transferCounterpartyId });
      else await confirmImportDraft(draft.id, { accountId, title: draft.merchant || (draft.kind === 'income' ? 'Поступление' : 'Операция по карте'), category: 'Другое', feeAsSeparateOperation: includeFee });
      await reload();
      // The message reported a renewal (new rate/maturity) alongside the transaction it just
      // confirmed — offer to apply it to the account too, but never silently: the user picks.
      if (draft.renewedRate && !transferCounterpartyId) {
        const rateLabel = `${draft.renewedRate}%`;
        const untilLabel = draft.renewedMaturityDate ? ` до ${draft.renewedMaturityDate}` : '';
        Alert.alert(
          'Обновить ставку по вкладу?',
          `Банк сообщил о продлении: ${rateLabel} годовых${untilLabel}. Применить к этому счёту?`,
          [
            { text: 'Не сейчас', style: 'cancel' },
            { text: 'Обновить', onPress: () => extendDepositRate(accountId, { newRate: draft.renewedRate!, newMaturityDate: draft.renewedMaturityDate }).catch((error) => Alert.alert('Не удалось обновить ставку', describeError(error) ?? 'Попробуйте изменить счёт вручную.')) },
          ],
        );
      }
    } catch (error) { Alert.alert('Не удалось подтвердить', describeError(error) ?? 'Попробуйте ещё раз.'); }
  };
  const handleDismiss = async (draft: ImportDraft) => { await dismissImportDraft(draft.id); await reload(); };
  const [rematching, setRematching] = useState(false);
  const handleRematch = async () => {
    setRematching(true);
    try {
      const updated = await rematchImportDrafts();
      await reload();
      Alert.alert(updated > 0 ? 'Готово' : 'Нечего обновлять', updated > 0 ? `Обновлено черновиков: ${updated}.` : 'Обновлять нечего.');
    } finally { setRematching(false); }
  };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={s.modal} edges={['top', 'bottom']}>
      <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Импорт SMS и push (тест)</Text><View style={{ width: 40 }} /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
          <Text style={s.helperText}>Вставьте текст SMS или push-уведомления от банка, чтобы проверить разбор — до появления автоматического чтения с телефона.</Text>
          <Text style={s.fieldLabel}>ИСТОЧНИК</Text>
          <View style={s.choiceRow}>
            <Pressable style={[s.choice, channel === 'sms' && s.choiceActive]} onPress={() => setChannel('sms')}><Text style={[s.choiceText, channel === 'sms' && s.choiceTextActive]}>SMS</Text></Pressable>
            <Pressable style={[s.choice, channel === 'push' && s.choiceActive]} onPress={() => setChannel('push')}><Text style={[s.choiceText, channel === 'push' && s.choiceTextActive]}>Push</Text></Pressable>
          </View>
          {channel === 'sms' ? <>
            <Text style={s.fieldLabel}>ОТПРАВИТЕЛЬ</Text>
            <View style={s.choiceRow}>{KNOWN_SMS_SENDERS.map((item) => <Pressable key={item} style={[s.choice, sender === item && s.choiceActive]} onPress={() => setSender(item)}><Text style={[s.choiceText, sender === item && s.choiceTextActive]}>{item}</Text></Pressable>)}</View>
            <Text style={s.fieldLabel}>ТЕКСТ SMS</Text>
            <TextInput value={body} onChangeText={setBody} placeholder="Вставьте текст сюда" placeholderTextColor="#9BA9AF" multiline style={[s.input, { minHeight: 100, paddingTop: 12, textAlignVertical: 'top' }]} />
          </> : <>
            <Text style={s.fieldLabel}>БАНК</Text>
            <View style={s.choiceRow}>{KNOWN_BANK_PACKAGE_LIST.map(([key]) => <Pressable key={key} style={[s.choice, bankKey === key && s.choiceActive]} onPress={() => setBankKey(key)}><Text style={[s.choiceText, bankKey === key && s.choiceTextActive]}>{key}</Text></Pressable>)}</View>
            <Text style={s.fieldLabel}>ЗАГОЛОВОК УВЕДОМЛЕНИЯ</Text>
            <TextInput value={title} onChangeText={setTitle} placeholder="Например, Покупка по СБП в Rahmat" placeholderTextColor="#9BA9AF" style={s.input} />
            <Text style={s.fieldLabel}>ТЕКСТ УВЕДОМЛЕНИЯ</Text>
            <TextInput value={body} onChangeText={setBody} placeholder="Вставьте текст сюда" placeholderTextColor="#9BA9AF" multiline style={[s.input, { minHeight: 100, paddingTop: 12, textAlignVertical: 'top' }]} />
          </>}
          <Pressable style={s.primaryButton} disabled={loading || !body.trim()} onPress={handleParse}><Text style={s.primaryText}>{loading ? 'Разбираем…' : 'Разобрать'}</Text></Pressable>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26, marginBottom: 10 }}>
            <Text style={s.sectionTitle}>Черновики</Text>
            <Pressable onPress={handleRematch} disabled={rematching}><Text style={s.link}>{rematching ? 'Обновляем…' : 'Обновить счета и проверки'}</Text></Pressable>
          </View>
          {!drafts.length && <Text style={s.rowSub}>Пока пусто</Text>}
          {drafts.map((draft) => <View key={draft.id} style={{ marginBottom: 10 }}><ImportDraftCard draft={draft} accounts={accounts} onConfirm={(accountId, includeFee, transferCounterpartyId) => handleConfirm(draft, accountId, includeFee, transferCounterpartyId)} onDismiss={() => handleDismiss(draft)} /></View>)}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

// Human-readable summary of a proposal payload for the confirm card -- one line per kind, since
// each kind's fields differ (see AiProposalPayload in src/types.ts).
function describeAiProposal(proposal: AiProposal, accounts: Account[]): { title: string; amount: number; currency: string; positive: boolean } {
  const payload = proposal.payload;
  if (payload.kind === 'operation') return { title: payload.title, amount: payload.amount, currency: payload.currency, positive: payload.operationKind === 'income' };
  if (payload.kind === 'transfer') return { title: 'Перевод между счетами', amount: payload.fromAmount, currency: accounts.find((account) => account.id === payload.fromAccountId)?.currency ?? '', positive: false };
  if (payload.kind === 'debt') return { title: `Долг · ${payload.person}`, amount: payload.originalAmount, currency: payload.currency, positive: payload.direction === 'owed_to_me' };
  if (payload.kind === 'debt_payment') return { title: 'Погашение долга', amount: payload.amount, currency: accounts.find((account) => account.id === payload.accountId)?.currency ?? '', positive: false };
  if (payload.kind === 'planned_flow') return { title: payload.title, amount: payload.amount, currency: payload.currency, positive: payload.flowKind === 'income' };
  return { title: payload.title, amount: payload.totalAmount, currency: payload.currency, positive: false };
}

function AiProposalCard({ proposal, accounts, debts, onConfirmed, onDismissed }: { proposal: AiProposal; accounts: Account[]; debts: Debt[]; onConfirmed: () => void; onDismissed: () => void }) {
  const payload = proposal.payload;
  const [accountId, setAccountId] = useState<string | undefined>(
    payload.kind === 'operation' || payload.kind === 'transfer' || payload.kind === 'debt' || payload.kind === 'debt_payment' || payload.kind === 'planned_flow'
      ? (payload.kind === 'transfer' ? payload.fromAccountId : payload.accountId) : payload.kind === 'bill_split' ? payload.payingAccountId : undefined,
  );
  // Transfer is the one proposal kind with two account sides — the destination must be just as
  // visible/editable as the source before the user confirms moving money, not just implied.
  const [toAccountId, setToAccountId] = useState<string | undefined>(payload.kind === 'transfer' ? payload.toAccountId : undefined);
  const [debtId, setDebtId] = useState<string | undefined>(payload.kind === 'debt_payment' ? payload.debtId : undefined);
  const [confirming, setConfirming] = useState(false);
  const description = describeAiProposal(proposal, accounts);
  const needsAccount = payload.kind !== 'debt_payment' ? !accountId : false;
  const needsToAccount = payload.kind === 'transfer' && (!toAccountId || toAccountId === accountId);
  const needsDebt = payload.kind === 'debt_payment' && !debtId;
  const canConfirm = !needsAccount && !needsToAccount && !needsDebt;
  const handleConfirm = async () => {
    setConfirming(true);
    try {
      if (payload.kind === 'debt_payment') payload.debtId = debtId;
      else if (payload.kind === 'transfer') { payload.fromAccountId = accountId; payload.toAccountId = toAccountId; }
      else if (payload.kind === 'bill_split') payload.payingAccountId = accountId;
      else payload.accountId = accountId;
      await commitAiProposal(proposal.id);
      onConfirmed();
    } catch (error) {
      Alert.alert('Не удалось подтвердить', describeError(error) ?? 'Проверьте данные и попробуйте ещё раз.');
    } finally {
      setConfirming(false);
    }
  };
  const handleDismiss = async () => { await dismissAiProposal(proposal.id); onDismissed(); };
  return <View style={[s.card, { padding: 16, marginTop: 8 }]}>
    <View style={s.budgetTop}><Text style={s.rowTitle}>{description.title}</Text><Text style={description.positive ? s.income : s.expense}>{description.positive ? '+' : ''}{money(description.amount, false, description.currency)}</Text></View>
    {payload.kind === 'transfer' && <Text style={s.rowSub}>Зачисление: {money(payload.toAmount, false, accounts.find((account) => account.id === toAccountId)?.currency ?? '')}</Text>}
    {payload.kind === 'bill_split' && <Text style={s.rowSub}>{payload.participants.map((participant) => `${participant.name}: ${money(participant.amount ?? 0, false, payload.currency)}`).join(' · ')}</Text>}
    {needsAccount && <><Text style={[s.fieldLabel, { marginTop: 8 }]}>{payload.kind === 'transfer' ? 'СЧЁТ СПИСАНИЯ' : 'СЧЁТ'}</Text><View style={s.targetList}>{accounts.map((account) => <Pressable key={account.id} style={[s.targetAccount, accountId === account.id && s.targetAccountActive]} onPress={() => setAccountId(account.id)}><Text style={s.targetAccountText}>{account.name} · {account.currency}</Text></Pressable>)}</View></>}
    {payload.kind === 'transfer' && <><Text style={[s.fieldLabel, { marginTop: 8 }]}>СЧЁТ ЗАЧИСЛЕНИЯ</Text><View style={s.targetList}>{accounts.filter((account) => account.id !== accountId).map((account) => <Pressable key={account.id} style={[s.targetAccount, toAccountId === account.id && s.targetAccountActive]} onPress={() => setToAccountId(account.id)}><Text style={s.targetAccountText}>{account.name} · {account.currency}</Text></Pressable>)}</View></>}
    {needsDebt && <><Text style={[s.fieldLabel, { marginTop: 8 }]}>ДОЛГ</Text><View style={s.targetList}>{debts.filter((debt) => debt.status !== 'paid').map((debt) => <Pressable key={debt.id} style={[s.targetAccount, debtId === debt.id && s.targetAccountActive]} onPress={() => setDebtId(debt.id)}><Text style={s.targetAccountText}>{debt.person} · {money(debt.currentBalance, false, debt.currency)}</Text></Pressable>)}</View></>}
    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
      <Pressable style={[s.secondaryButton, { flex: 1 }]} onPress={handleDismiss}><Text style={s.secondaryText}>Отклонить</Text></Pressable>
      <Pressable style={[s.primaryButton, { flex: 1 }, (!canConfirm || confirming) && { opacity: .5 }]} disabled={!canConfirm || confirming} onPress={handleConfirm}><Text style={s.primaryText}>{confirming ? 'Подтверждаем…' : 'Подтвердить'}</Text></Pressable>
    </View>
  </View>;
}

function AiAssistantModal({ visible, accounts, debts, onClose }: { visible: boolean; accounts: Account[]; debts: Debt[]; onClose: () => void }) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const reload = async () => { setMessages(await listAiChatMessages()); setProposals(await listAiProposals('pending')); };
  useEffect(() => { if (visible) reload(); }, [visible]);
  const send = async (text: string) => {
    if (!text.trim() || sending) return;
    setInput('');
    setSending(true);
    try { await sendUserMessage(text.trim()); await reload(); }
    catch (error) { Alert.alert('Помощник не ответил', describeError(error) ?? 'Попробуйте ещё раз.'); }
    finally { setSending(false); }
  };
  const attachReceipt = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (result.canceled || !result.assets[0]?.uri) return;
    setSending(true);
    try {
      const text = await extractReceiptText(result.assets[0].uri);
      await sendUserMessage(`Текст с фото чека:\n${text}`);
      await reload();
    } catch (error) { Alert.alert('Не удалось разобрать фото', describeError(error) ?? 'Попробуйте ещё раз.'); }
    finally { setSending(false); }
  };
  const textBlocksOf = (message: AiChatMessage) => message.content.filter((block) => block.type === 'text') as { type: 'text'; text: string }[];
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}>
    <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Афина · помощник</Text><Pressable onPress={() => Alert.alert('Очистить историю?', 'Диалог с помощником будет удалён с этого устройства.', [{ text: 'Отмена', style: 'cancel' }, { text: 'Очистить', style: 'destructive', onPress: async () => { await clearAiChat(); await reload(); } }])}><Ionicons name="trash-outline" size={20} color={C.muted} /></Pressable></View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled">
        {!messages.length && <Text style={s.emptyText}>Спросите про доходы, расходы, долги или планы — например «сколько я потратила на еду в августе».</Text>}
        {messages.map((message) => {
          const text = textBlocksOf(message).map((block) => block.text).join('\n');
          const relatedProposals = proposals.filter((proposal) => proposal.messageId === message.id);
          if (!text && !relatedProposals.length) return null;
          return <View key={message.id} style={{ marginBottom: 12, alignItems: message.role === 'user' ? 'flex-end' : 'flex-start' }}>
            {!!text && <View style={[s.card, { padding: 12, backgroundColor: message.role === 'user' ? C.navy : C.card, maxWidth: '85%' }]}><Text style={{ color: message.role === 'user' ? 'white' : C.ink, fontSize: 14 }}>{text}</Text></View>}
            {relatedProposals.map((proposal) => <AiProposalCard key={proposal.id} proposal={proposal} accounts={accounts} debts={debts} onConfirmed={reload} onDismissed={reload} />)}
          </View>;
        })}
        {sending && <ActivityIndicator style={{ marginTop: 8 }} color={C.blue} />}
      </ScrollView>
      <View style={{ flexDirection: 'row', gap: 8, padding: 16, borderTopWidth: 1, borderTopColor: C.line, alignItems: 'flex-end' }}>
        <Pressable onPress={attachReceipt} disabled={sending} style={{ padding: 8 }}><Ionicons name="camera-outline" size={24} color={C.blue} /></Pressable>
        <TextInput value={input} onChangeText={setInput} placeholder="Спросите что-нибудь…" placeholderTextColor="#9BA9AF" style={[s.input, { flex: 1 }]} multiline editable={!sending} onSubmitEditing={() => send(input)} />
        <Pressable onPress={() => send(input)} disabled={sending || !input.trim()} style={{ padding: 8, opacity: sending || !input.trim() ? .5 : 1 }}><Ionicons name="send" size={22} color={C.blue} /></Pressable>
      </View>
    </KeyboardAvoidingView>
  </SafeAreaView></Modal>;
}

function LegacyAnalytics() {
  const maxBar = 11.2;
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow="АВГУСТ 2026" title="Аналитика" />
    <View style={s.segment}><View style={s.segmentActive}><Text style={s.segmentActiveText}>Месяц</Text></View><Text style={s.segmentText}>3 месяца</Text><Text style={s.segmentText}>Год</Text></View>
    <SectionTitle title="Доходы и расходы" />
    <View style={s.chartCard}>
      <View style={s.chartTop}><View><Text style={s.chartLabel}>БАЛАНС ПЕРИОДА</Text><Text style={s.chartValue}>+9 758 000 сум</Text></View><View style={s.chartBadge}><Text style={s.chartBadgeText}>+18%</Text></View></View>
      <View style={s.bars}>
        {[['Май', 8.2, 6.1], ['Июн', 9.8, 7.3], ['Июл', 11.2, 8.6], ['Авг', 10.2, 4.4]].map(([month, inc, exp]) => <View key={String(month)} style={s.barGroup}>
          <View style={s.barPair}><View style={[s.bar, { height: (Number(inc) / maxBar) * 100, backgroundColor: C.green }]} /><View style={[s.bar, { height: (Number(exp) / maxBar) * 100, backgroundColor: '#9FBFD0' }]} /></View><Text style={s.barMonth}>{month}</Text>
        </View>)}
      </View>
      <View style={s.chartLegend}><Text style={s.legendText}>● Доходы 16,9 млн</Text><Text style={s.legendText}>● Расходы 7,1 млн</Text></View>
    </View>
    <View style={s.metricRow}><View style={s.metric}><Text style={s.metricLabel}>В ДЕНЬ</Text><Text style={s.metricValue}>236 тыс</Text><Text style={s.metricSub}>средние траты</Text></View><View style={s.metric}><Text style={s.metricLabel}>ПАССИВНО</Text><Text style={s.metricValue}>372 тыс</Text><Text style={s.metricSub}>2,2% дохода</Text></View></View>

    <SectionTitle title="Бюджеты" action="Настроить" />
    <View style={s.card}>{budgets.map((budget, i) => <View key={budget.name} style={[s.budgetRow, i > 0 && s.budgetBorder]}>
      <View style={s.budgetTop}><Text style={s.rowTitle}>{budget.name}</Text><Text style={s.budgetAmount}>{money(budget.spent, true)} <Text style={s.rowSub}>из {money(budget.limit, true)}</Text></Text></View>
      <Progress value={(budget.spent / budget.limit) * 100} color={budget.spent / budget.limit > .9 ? C.red : budget.color} />
      <Text style={s.budgetHint}>{Math.round((budget.spent / budget.limit) * 100)}% использовано</Text>
    </View>)}</View>

    <SectionTitle title="Финансовые цели" action="+ Цель" />
    {goals.map((goal) => { const p = percent(goal.current, goal.target); return <View key={goal.id} style={s.goalCard}>
      <View style={s.goalTop}><View style={[s.goalIcon, { backgroundColor: `${goal.color}18` }]}><Ionicons name={goal.id === 'reserve' ? 'shield-checkmark-outline' : 'sparkles-outline'} size={22} color={goal.color} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{goal.title}</Text><Text style={s.rowSub}>{goal.deadline}</Text></View><Text style={[s.goalPercent, { color: goal.color }]}>{p}%</Text></View>
      <Progress value={p} color={goal.color} /><View style={s.goalAmounts}><Text style={s.rowSub}>{money(goal.current, true)}</Text><Text style={s.rowSub}>{money(goal.target, true)}</Text></View>
    </View>})}
    <View style={{ height: 20 }} />
  </ScrollView>;
}

function Analytics({ accounts, plannedExpenses, plannedOccurrences, debts, currencySettings, operations, transfers, userBudgets, financialGoals, onAddBudget, onEditBudget, onAddGoal, onEditGoal, onProfile }: { accounts: Account[]; plannedExpenses: PlannedExpense[]; plannedOccurrences: PlannedOccurrence[]; debts: Debt[]; currencySettings: CurrencySettings; operations: FinancialOperation[]; transfers: Transfer[]; userBudgets: Budget[]; financialGoals: FinancialGoal[]; onAddBudget: () => void; onEditBudget: (budget: Budget) => void; onAddGoal: () => void; onEditGoal: (goal: FinancialGoal) => void; onProfile: () => void }) {
  const now = new Date();
  const totals = getCurrencyTotals(accounts);
  const currencies = Array.from(new Set([currencySettings.baseCurrency, ...Object.keys(totals), ...plannedExpenses.map((item) => item.currency), ...debts.map((item) => item.currency), ...operations.map((item) => item.currency), ...financialGoals.map((item) => item.currency)])).sort((a, b) => a === 'UZS' ? -1 : b === 'UZS' ? 1 : a.localeCompare(b));
  const [currency, setCurrency] = useState(currencies[0] ?? 'UZS');
  const [period, setPeriod] = useState<AnalyticsPeriod>('month');
  const [customRange, setCustomRange] = useState({ from: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`, to: localToday() });
  const [dateTarget, setDateTarget] = useState<'from' | 'to' | null>(null);
  const [drilldownKind, setDrilldownKind] = useState<'income' | 'expense' | 'passive' | null>(null);
  const [celebratingGoal, setCelebratingGoal] = useState<FinancialGoal | null>(null);
  useEffect(() => { if (currencies.length && !currencies.includes(currency)) setCurrency(currencies[0] ?? 'UZS'); }, [accounts, plannedExpenses, debts]);
  // Celebrate a completed goal exactly once per device, the first time this screen is visited
  // after it crosses 100% — `getCelebratedGoalIds` (SecureStore) is the source of truth for "already
  // shown", so this stays correct even if the screen remounts on every tab switch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const celebrated = await getCelebratedGoalIds();
      for (const goal of financialGoals) {
        if (celebrated.includes(goal.id)) continue;
        const progress = calculateGoalProgress(goal, accounts, operations, debts, currencySettings, now);
        if (progress.percent >= 100) {
          if (!cancelled) setCelebratingGoal(goal);
          await addCelebratedGoalId(goal.id);
          break;
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const relevant = accounts.filter((account) => account.currency === currency);
  const total = totals[currency] ?? 0;
  const projection = buildMonthProjection(accounts, currency, now.getFullYear(), now.getMonth(), plannedExpenses, debts, currencySettings, localToday(), plannedOccurrences, operations, transfers);
  const consolidated = consolidatedNetWorth(accounts, debts, currencySettings);
  const weightedRates = weightedAssetRates(accounts, currencySettings);
  const earliest = [...operations.map((item) => item.date), ...plannedExpenses.map((item) => item.startDate)].sort()[0];
  const range = analyticsRange(period, localToday(), customRange, earliest);
  const actual = summarizeOperations(operations, currency, range, currencySettings);
  const planned = summarizePlannedFlows(plannedExpenses, accounts, currency, range, currencySettings);
  const byAccount = actual.byInterestAccount;
  // Accounts that earned interest but aren't in the currently selected display currency —
  // still worth surfacing (already converted into `currency`), just outside the balance list above.
  const otherInterestAccountIds = Object.keys(byAccount).filter((id) => !relevant.some((account) => account.id === id));
  const visibleBudgets = userBudgets.filter((budget) => budget.currency === currency);
  const spentForBudget = (budget: Budget) => operations.filter((operation) => operation.status !== 'reversed' && !operation.relatedOperationId && operation.kind === 'expense' && operation.category === budget.category && operation.date >= range.from && operation.date <= range.to).map((operation) => operationConversionBasis(operation)).filter((basis) => basis.currency === budget.currency).reduce((sum, basis) => sum + basis.amount, 0);
  // Same live-operation rule as summarizeOperations (exclude reversed + reversals-of-reversed) so
  // this breakdown's totals agree with the "РАСХОДЫ" tile above rather than a raw sum that
  // includes struck-through rows.
  const reversedOperationIds = new Set(operations.filter((operation) => operation.status === 'reversed').map((operation) => operation.id));
  const categoryTotals = new Map<string, number>();
  for (const operation of operations) {
    if (operation.status === 'reversed' || (operation.relatedOperationId && reversedOperationIds.has(operation.relatedOperationId))) continue;
    if (operation.kind !== 'expense' || operation.date < range.from || operation.date > range.to) continue;
    const basis = operationConversionBasis(operation);
    const converted = convertCurrency(basis.amount, basis.currency, currency, currencySettings);
    if (converted === null) continue;
    categoryTotals.set(operation.category, (categoryTotals.get(operation.category) ?? 0) + converted);
  }
  const categoryBreakdown = Array.from(categoryTotals.entries()).map(([category, amount]) => ({ category, amount, percent: actual.expense ? amount / actual.expense * 100 : 0 })).sort((a, b) => b.amount - a.amount);
  const [categoryDrilldown, setCategoryDrilldown] = useState<string | null>(null);
  return <>
  <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <Header eyebrow={`${range.from} — ${range.to}`} title="Аналитика" onAvatarPress={onProfile} />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{([['month', 'Месяц'], ['quarter', 'Квартал'], ['year', 'Год'], ['all', 'Всё время'], ['custom', 'Свой период']] as [AnalyticsPeriod, string][]).map(([value, label]) => <Pressable key={value} style={[s.currencyFilter, period === value && s.currencyFilterActive]} onPress={() => setPeriod(value)}><Text style={[s.currencyFilterText, period === value && s.currencyFilterTextActive]}>{label}</Text></Pressable>)}</ScrollView>
    {period === 'custom' && <View style={s.twoColumns}><View style={{ flex: 1 }}><DateField value={customRange.from} onPress={() => setDateTarget('from')} /></View><View style={{ flex: 1 }}><DateField value={customRange.to} onPress={() => setDateTarget('to')} /></View></View>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.currencyRail}>{(currencies.length ? currencies : ['UZS']).map((item) => <Pressable key={item} style={[s.currencyFilter, currency === item && s.currencyFilterActive]} onPress={() => setCurrency(item)}><Text style={[s.currencyFilterText, currency === item && s.currencyFilterTextActive]}>{item}</Text></Pressable>)}</ScrollView>
    <View style={s.chartCard}><Text style={s.chartLabel}>АКТИВЫ · {currency}</Text><Text style={s.chartValue}>{money(total, false, currency)}</Text><Text style={[s.rowSub, { marginTop: 7 }]}>Прогноз к концу месяца: {money(projection.closingBalance, false, currency)}</Text><Text style={[s.rowSub, { marginTop: 4 }]}>Общий капитал: {money(consolidated.total, false, currencySettings.baseCurrency)}</Text>{!!consolidated.missing.length && <Text style={[s.rowSub, { marginTop: 4 }]}>Без курса: {consolidated.missing.join(', ')}</Text>}</View>
    <SectionTitle title="Активы" />
    <View style={s.chartCard}><View style={s.chartTop}><View><Text style={s.chartLabel}>ТЕКУЩИЙ БАЛАНС · {currency}</Text><Text style={s.chartValue}>{money(total, false, currency)}</Text></View><View style={s.chartBadge}><Text style={s.chartBadgeText}>{relevant.length} сч.</Text></View></View><Text style={[s.rowSub, { marginTop: 8 }]}>К концу месяца: {money(projection.closingBalance, false, currency)}</Text>
      {relevant.map((account) => { const earned = byAccount[account.id]; return <View key={account.id} style={s.assetRow}><View style={s.budgetTop}><Text style={s.rowTitle}>{account.name}</Text><Text style={s.budgetAmount}>{money(account.balance, false, currency)}</Text></View><Progress value={total ? account.balance / total * 100 : 0} color={account.accent} />{!!earned && <Text style={[s.rowSub, { marginTop: 4 }]}>{account.rate ?? 0}% годовых · +{money(earned, true, currency)} за период</Text>}</View>; })}
      {otherInterestAccountIds.map((accountId) => { const account = accounts.find((item) => item.id === accountId); return <View key={accountId} style={s.assetRow}><View style={s.budgetTop}><Text style={s.rowTitle}>{account?.name ?? 'Проценты'}</Text><Text style={s.income}>+{money(byAccount[accountId] ?? 0, false, currency)}</Text></View><Text style={s.rowSub}>Проценты в {currency} · счёт в другой валюте</Text></View>; })}
    </View>
    <SectionTitle title="Средневзвешенная ставка" /><View style={s.chartCard}><View style={s.budgetTop}><Text style={s.rowTitle}>Все активы · {currencySettings.baseCurrency}</Text><Text style={s.budgetAmount}>{weightedRates.all.toFixed(2)}%</Text></View>{Object.entries(weightedRates.byCurrency).sort(([left], [right]) => left.localeCompare(right)).map(([code, value]) => <View key={code} style={[s.budgetTop, { marginTop: 12 }]}><Text style={s.rowSub}>{code} · {money(value.assets, true, code)}</Text><Text style={s.budgetAmount}>{value.rate.toFixed(2)}%</Text></View>)}</View>
    <View style={s.metricRow}>
      <Pressable style={s.metric} onPress={() => setDrilldownKind('passive')}><Text style={s.metricLabel}>ПАССИВНО</Text><Text style={s.metricValue}>{money(actual.passive, true, currency)}</Text><Text style={s.metricSub}>факт за период</Text></Pressable>
      <Pressable style={s.metric} onPress={() => setDrilldownKind('income')}><Text style={s.metricLabel}>ДОХОДЫ</Text><Text style={s.metricValue}>{money(actual.income, true, currency)}</Text><Text style={s.metricSub}>факт · план {money(planned.income, true, currency)}</Text></Pressable>
      <Pressable style={s.metric} onPress={() => setDrilldownKind('expense')}><Text style={s.metricLabel}>РАСХОДЫ</Text><Text style={s.metricValue}>{money(actual.expense, true, currency)}</Text><Text style={s.metricSub}>факт · план {money(planned.expense, true, currency)}</Text></Pressable>
    </View>
    <AnalyticsDrilldownModal visible={drilldownKind !== null} kind={drilldownKind ?? 'income'} operations={operations} plannedExpenses={plannedExpenses} accounts={accounts} currency={currency} range={range} settings={currencySettings} onClose={() => setDrilldownKind(null)} />
    {!!actual.missing.length && <Text style={[s.helperText, { color: C.red, marginBottom: 14 }]}>Не учтены операции без курса: {actual.missing.join(', ')}</Text>}
    <SectionTitle title="Планы" />
    <Text style={s.fieldLabel}>РАСХОДЫ ПО КАТЕГОРИЯМ</Text>
    {categoryBreakdown.length ? <View style={s.card}>{categoryBreakdown.map((item, index) => <Pressable key={item.category} style={[s.budgetRow, index > 0 && s.budgetBorder]} onPress={() => setCategoryDrilldown(item.category)}><View style={s.budgetTop}><Text style={s.rowTitle}>{item.category}</Text><Text style={s.budgetAmount}>{money(item.amount, true, currency)}</Text></View><Progress value={item.percent} color={C.blue} /><Text style={s.budgetHint}>{item.percent.toFixed(1)}% от расходов</Text></Pressable>)}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Расходов за период нет</Text></View>}
    <AnalyticsDrilldownModal visible={categoryDrilldown !== null} kind="expense" category={categoryDrilldown ?? undefined} operations={operations} plannedExpenses={plannedExpenses} accounts={accounts} currency={currency} range={range} settings={currencySettings} onClose={() => setCategoryDrilldown(null)} />
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={s.fieldLabel}>БЮДЖЕТЫ</Text><Pressable onPress={onAddBudget}><Text style={s.link}>+ Бюджет</Text></Pressable></View>
    {visibleBudgets.length ? <View style={s.card}>{visibleBudgets.map((budget, index) => { const spent = spentForBudget(budget); const ratio = budget.limit ? spent / budget.limit * 100 : 0; return <Pressable key={budget.id} style={[s.budgetRow, index > 0 && s.budgetBorder]} onPress={() => onEditBudget(budget)}><View style={s.budgetTop}><Text style={s.rowTitle}>{budget.category}</Text><Text style={s.budgetAmount}>{money(spent, true, currency)} <Text style={s.rowSub}>из {money(budget.limit, true, currency)}</Text></Text></View><Progress value={ratio} color={ratio > 100 ? C.red : C.blue} /><Text style={s.budgetHint}>{Math.round(ratio)}% использовано</Text></Pressable>; })}</View> : <Pressable style={s.emptyCard} onPress={onAddBudget}><Ionicons name="pie-chart-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Бюджетов в {currency} пока нет</Text><Text style={s.emptyText}>Задайте месячный лимит для категории</Text></Pressable>}
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}><Text style={s.fieldLabel}>ФИНАНСОВЫЕ ЦЕЛИ</Text><Pressable onPress={onAddGoal}><Text style={s.link}>+ Цель</Text></Pressable></View>
    {financialGoals.length ? financialGoals.map((goal) => { const progress = calculateGoalProgress(goal, accounts, operations, debts, currencySettings, now); const color = progress.overdue ? C.red : progress.percent >= 100 ? C.green : C.blue; const typeLabel = goal.type === 'balance' ? 'Остаток' : goal.type === 'monthly_income' ? 'Доход в месяц' : 'Погашение долга'; const scopeLabel = goal.type === 'balance' && !goal.accountId ? (goal.includeAllCurrencies ? `все счета в пересчёте · ${progress.includedAccountIds.length} счёт.` : `счета в ${goal.currency} · ${progress.includedAccountIds.length} счёт.`) : null; return <Pressable key={goal.id} style={s.goalCard} onPress={() => onEditGoal(goal)}><View style={s.goalTop}><View style={[s.goalIcon, { backgroundColor: `${color}18` }]}><Ionicons name={goal.type === 'debt_payoff' ? 'checkmark-circle-outline' : goal.type === 'monthly_income' ? 'trending-up-outline' : 'flag-outline'} size={22} color={color} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{goal.title}</Text><Text style={[s.rowSub, progress.overdue && { color: C.red }]}>{typeLabel} · до {goal.deadline}{progress.overdue ? ' · срок истёк' : ''}</Text>{!!scopeLabel && <Text style={s.rowSub}>{scopeLabel}</Text>}{!!progress.missing.length && <Text style={[s.rowSub, { color: C.red }]}>Нет курса: {progress.missing.join(', ')}</Text>}</View><Text style={[s.goalPercent, { color }]}>{Math.round(progress.rawPercent)}%</Text></View><Progress value={progress.percent} color={color} /><View style={s.goalAmounts}><Text style={s.rowSub}>{money(progress.current, true, goal.currency)}</Text><Text style={s.rowSub}>{money(goal.target, true, goal.currency)}</Text></View></Pressable>; }) : <Pressable style={s.emptyCard} onPress={onAddGoal}><Ionicons name="flag-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Финансовых целей пока нет</Text><Text style={s.emptyText}>Создайте цель по остатку, доходу или погашению долга</Text></Pressable>}
    <Text style={s.fieldLabel}>ПЛАН РАСХОДОВ</Text>
    {planned.expense > 0 ? <View style={s.chartCard}><Text style={s.chartLabel}>ЗАПЛАНИРОВАНО · {currency}</Text><Text style={s.chartValue}>{money(planned.expense, false, currency)}</Text><Text style={[s.rowSub, { marginTop: 7 }]}>За выбранный период</Text></View> : <View style={s.emptyCard}><Ionicons name="receipt-outline" size={24} color={C.blue} /><Text style={s.emptyTitle}>Расходы ещё не запланированы</Text><Text style={s.emptyText}>Добавьте разовый или повторяющийся платёж в календаре</Text></View>}
    <DatePickerModal visible={dateTarget !== null} value={dateTarget ? customRange[dateTarget] : undefined} onClose={() => setDateTarget(null)} onSelect={(value) => { if (dateTarget === 'from') setCustomRange((current) => ({ from: value, to: value > current.to ? value : current.to })); else if (dateTarget === 'to') setCustomRange((current) => ({ from: value < current.from ? value : current.from, to: value })); setDateTarget(null); }} />
    <View style={{ height: 20 }} />
  </ScrollView>
  {celebratingGoal && <ConfettiOverlay caption={celebratingGoal.title} onDone={() => setCelebratingGoal(null)} />}
  </>;
}

function AnalyticsDrilldownModal({ visible, kind, category, operations, plannedExpenses, accounts, currency, range, settings, onClose }: {
  visible: boolean; kind: 'income' | 'expense' | 'passive'; category?: string; operations: FinancialOperation[]; plannedExpenses: PlannedExpense[]; accounts: Account[];
  currency: string; range: DateRange; settings: CurrencySettings; onClose: () => void;
}) {
  const kindTitle = category ?? (kind === 'passive' ? 'Пассивные доходы' : kind === 'income' ? 'Доходы' : 'Расходы');
  const reversedIds = new Set(operations.filter((operation) => operation.status === 'reversed').map((operation) => operation.id));
  const factRows = operations
    .filter((operation) => operation.status !== 'reversed' && !(operation.relatedOperationId && reversedIds.has(operation.relatedOperationId)) && operation.date >= range.from && operation.date <= range.to)
    .filter((operation) => kind === 'passive' ? (operation.kind === 'income' && operation.source === 'interest') : operation.kind === kind)
    .filter((operation) => !category || operation.category === category)
    .map((operation) => {
      const basis = operationConversionBasis(operation);
      const converted = convertCurrency(basis.amount, basis.currency, currency, settings);
      return converted === null ? null : { operation, amount: converted };
    })
    .filter((item): item is { operation: FinancialOperation; amount: number } => item !== null)
    .sort((a, b) => b.operation.date.localeCompare(a.operation.date));
  const activeFact = kind === 'income' ? factRows.filter((item) => item.operation.source !== 'interest') : factRows;
  const passiveFact = kind === 'income' ? factRows.filter((item) => item.operation.source === 'interest') : [];
  const plannedRows: { flow: PlannedExpense; date: string; amount: number }[] = [];
  if (kind !== 'passive') {
    const start = parseLocalDate(range.from); const end = parseLocalDate(range.to);
    if (start && end) for (let cursor = range.from; cursor <= range.to; cursor = addLocalDays(cursor, 1)) {
      const date = parseLocalDate(cursor);
      if (!date) break;
      for (const flow of plannedExpenses) {
        if (flow.kind !== kind || (category && flow.category !== category) || !occursOn(flow, date)) continue;
        const account = accounts.find((item) => item.id === flow.accountId);
        const amount = flowAmountInCurrency(flow, account, currency, settings);
        if (amount === null) continue;
        plannedRows.push({ flow, date: cursor, amount });
      }
    }
  }
  const factTotal = factRows.reduce((sum, item) => sum + item.amount, 0);
  const plannedTotal = plannedRows.reduce((sum, item) => sum + item.amount, 0);
  const renderFactRow = (item: { operation: FinancialOperation; amount: number }, isLast: boolean) => {
    const account = accounts.find((acc) => acc.id === item.operation.accountId);
    return <View key={item.operation.id}><View style={s.eventRow}>
      <View style={[s.roundIcon, { backgroundColor: item.operation.kind === 'income' ? C.sageSoft : C.redSoft }]}><Ionicons name={item.operation.kind === 'income' ? 'sparkles-outline' : 'receipt-outline'} size={19} color={item.operation.kind === 'income' ? C.green : C.red} /></View>
      <View style={{ flex: 1 }}><Text style={s.rowTitle}>{item.operation.title || item.operation.category}</Text><Text style={s.rowSub}>{item.operation.date} · {account?.name ?? 'Счёт удалён'}</Text></View>
      <Text style={item.operation.kind === 'income' ? s.income : s.expense}>{item.operation.kind === 'income' ? '+' : '−'}{money(item.amount, false, currency)}</Text>
    </View>{!isLast && <View style={s.divider} />}</View>;
  };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}>
    <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{kindTitle}</Text><View style={{ width: 40 }} /></View>
    <ScrollView contentContainerStyle={s.formBody}>
      <View style={s.chartCard}><Text style={s.chartLabel}>ИТОГО ФАКТ · {currency}</Text><Text style={s.chartValue}>{money(factTotal, false, currency)}</Text><Text style={[s.rowSub, { marginTop: 7 }]}>{range.from} — {range.to}</Text></View>
      {kind === 'income' ? <>
        <SectionTitle title="Активные доходы" />
        {activeFact.length ? <View style={s.card}>{activeFact.map((item, index) => renderFactRow(item, index === activeFact.length - 1))}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Нет активных доходов за период</Text></View>}
        <SectionTitle title="Пассивные доходы" />
        {passiveFact.length ? <View style={s.card}>{passiveFact.map((item, index) => renderFactRow(item, index === passiveFact.length - 1))}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Нет пассивных доходов за период</Text></View>}
      </> : <>
        <SectionTitle title="Фактические операции" />
        {factRows.length ? <View style={s.card}>{factRows.map((item, index) => renderFactRow(item, index === factRows.length - 1))}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Операций за период нет</Text></View>}
      </>}
      {kind !== 'passive' && <>
        <SectionTitle title="Плановые события" />
        {plannedRows.length ? <View style={s.card}>{plannedRows.map((item, index) => <View key={`${item.flow.id}-${item.date}`}><View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: C.bg }]}><Ionicons name="repeat-outline" size={19} color={C.muted} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>{item.flow.title}</Text><Text style={s.rowSub}>{item.date}</Text></View><Text style={item.flow.kind === 'income' ? s.income : s.expense}>{item.flow.kind === 'income' ? '+' : '−'}{money(item.amount, false, currency)}</Text></View>{index < plannedRows.length - 1 && <View style={s.divider} />}</View>)}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>Плановых событий в этом периоде нет</Text></View>}
        <Text style={[s.rowSub, { marginTop: 8 }]}>План за период: {money(plannedTotal, false, currency)}</Text>
      </>}
    </ScrollView>
  </SafeAreaView></Modal>;
}

function Profile({ email, accounts, currencySettings, onCurrencySettings, onBack, pendingSmsDrafts, onSmsDraftsChanged, onOpenAssistant, pendingAiProposals }: { email?: string; accounts: Account[]; currencySettings: CurrencySettings; onCurrencySettings: () => void; onBack: () => void; pendingSmsDrafts: number; onSmsDraftsChanged: () => void; onOpenAssistant: () => void; pendingAiProposals: number }) {
  const [lockEnabled, setLockEnabledState] = useState(false);
  const [lockLoaded, setLockLoaded] = useState(false);
  const [pinSetupOpen, setPinSetupOpen] = useState(false);
  const [smsImportOpen, setSmsImportOpen] = useState(false);
  const [smsPermissionGranted, setSmsPermissionGranted] = useState(false);
  useEffect(() => { getLockEnabled().then((value) => { setLockEnabledState(value); setLockLoaded(true); }); }, []);
  useEffect(() => { if (isSmsReaderAvailable) hasSmsPermission().then(setSmsPermissionGranted); }, []);
  const handleEnableSms = async () => {
    const granted = await requestSmsPermission();
    setSmsPermissionGranted(granted);
    if (granted) { await scanSmsInbox(); onSmsDraftsChanged(); }
    else Alert.alert('Разрешение не выдано', 'Без доступа к SMS автоматическое чтение недоступно — можно вставлять текст вручную.');
  };
  const handleToggleLock = (value: boolean) => {
    if (value) { setPinSetupOpen(true); return; }
    Alert.alert('Отключить вход по PIN/биометрии?', 'Приложение больше не будет запрашивать вход при открытии.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Отключить', style: 'destructive', onPress: () => { Promise.all([setLockEnabledStored(false), setStoredPin(null)]).then(() => setLockEnabledState(false)); } },
    ]);
  };
  const handleSignOut = () => {
    Alert.alert('Выйти из аккаунта?', email ? `Вы выйдете из ${email} на этом устройстве.` : 'На этом устройстве понадобится войти заново.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Выйти', style: 'destructive', onPress: () => { supabase?.auth.signOut(); } },
    ]);
  };
  return <ScrollView contentContainerStyle={s.page} showsVerticalScrollIndicator={false}>
    <View style={s.header}>
      <Pressable onPress={onBack} hitSlop={10}><Ionicons name="chevron-back" size={26} color={C.ink} /></Pressable>
      <Text style={s.title}>Профиль</Text>
      <View style={{ width: 26 }} />
    </View>
    <View style={[s.card, { alignItems: 'center', paddingVertical: 26 }]}>
      <View style={[s.avatar, { width: 64, height: 64, borderRadius: 32, marginBottom: 12 }]}><Text style={[s.avatarText, { fontSize: 24 }]}>А</Text></View>
      <Text style={s.rowTitle}>{email ?? 'Аккаунт'}</Text>
    </View>
    <SectionTitle title="Настройки" />
    <Pressable style={s.accountCard} onPress={onCurrencySettings}>
      <View style={[s.roundIcon, { backgroundColor: `${C.blue}18` }]}><Ionicons name="swap-horizontal-outline" size={20} color={C.blue} /></View>
      <View style={{ flex: 1 }}><Text style={s.rowTitle}>Базовая валюта и курсы</Text><Text style={s.rowSub}>Сейчас: {currencySettings.baseCurrency}</Text></View>
      <Ionicons name="chevron-forward" size={19} color={C.muted} />
    </Pressable>
    <SectionTitle title="Защита входа" />
    <View style={s.card}>
      <View style={s.eventRow}>
        <View style={[s.roundIcon, { backgroundColor: `${C.blue}18` }]}><Ionicons name="lock-closed-outline" size={19} color={C.blue} /></View>
        <View style={{ flex: 1 }}><Text style={s.rowTitle}>PIN-код и биометрия</Text><Text style={s.rowSub}>Запрашивать вход при каждом открытии</Text></View>
        <Switch value={lockEnabled} onValueChange={handleToggleLock} disabled={!lockLoaded} trackColor={{ true: C.blue }} />
      </View>
      {lockEnabled && <><View style={s.divider} /><Pressable style={s.eventRow} onPress={() => setPinSetupOpen(true)}><View style={{ flex: 1 }}><Text style={s.rowTitle}>Изменить PIN-код</Text></View><Ionicons name="chevron-forward" size={19} color={C.muted} /></Pressable></>}
    </View>
    <SectionTitle title="Автоматизация" />
    {isSmsReaderAvailable && <View style={[s.card, { marginBottom: 10 }]}>
      <View style={s.eventRow}>
        <View style={[s.roundIcon, { backgroundColor: `${C.green}18` }]}><Ionicons name="chatbubble-ellipses-outline" size={19} color={C.green} /></View>
        <View style={{ flex: 1 }}><Text style={s.rowTitle}>Автоматическое чтение SMS</Text><Text style={s.rowSub}>{smsPermissionGranted ? 'Включено — сканируется при открытии приложения' : 'Нужно разрешение на чтение SMS'}</Text></View>
        {!smsPermissionGranted && <Pressable onPress={handleEnableSms}><Text style={s.link}>Включить</Text></Pressable>}
      </View>
    </View>}
    <Pressable style={s.accountCard} onPress={() => setSmsImportOpen(true)}>
      <View style={[s.roundIcon, { backgroundColor: `${C.green}18` }]}><Ionicons name="chatbox-ellipses-outline" size={20} color={C.green} /></View>
      <View style={{ flex: 1 }}><Text style={s.rowTitle}>Черновики из SMS</Text><Text style={s.rowSub}>{pendingSmsDrafts > 0 ? `${pendingSmsDrafts} ждут подтверждения` : 'Посмотреть черновики или вставить текст вручную'}</Text></View>
      {pendingSmsDrafts > 0 && <View style={[s.chartBadge, { marginRight: 8 }]}><Text style={s.chartBadgeText}>{pendingSmsDrafts}</Text></View>}
      <Ionicons name="chevron-forward" size={19} color={C.muted} />
    </Pressable>
    <SectionTitle title="Помощник" />
    <Pressable style={s.accountCard} onPress={onOpenAssistant}>
      <View style={[s.roundIcon, { backgroundColor: `${C.blue}18` }]}><Ionicons name="sparkles-outline" size={20} color={C.blue} /></View>
      <View style={{ flex: 1 }}><Text style={s.rowTitle}>Афина · помощник</Text><Text style={s.rowSub}>{pendingAiProposals > 0 ? `${pendingAiProposals} предложений ждут подтверждения` : 'Спросите про доходы, расходы, долги или планы'}</Text></View>
      {pendingAiProposals > 0 && <View style={[s.chartBadge, { marginRight: 8 }]}><Text style={s.chartBadgeText}>{pendingAiProposals}</Text></View>}
      <Ionicons name="chevron-forward" size={19} color={C.muted} />
    </Pressable>
    <SectionTitle title="О приложении" />
    <View style={s.card}>
      <View style={s.eventRow}><View style={[s.roundIcon, { backgroundColor: C.sageSoft }]}><Ionicons name="sparkles-outline" size={19} color={C.green} /></View><View style={{ flex: 1 }}><Text style={s.rowTitle}>Афина</Text><Text style={s.rowSub}>Версия {APP_VERSION}</Text></View></View>
    </View>
    <Pressable style={s.deleteButton} onPress={handleSignOut}><Ionicons name="log-out-outline" size={18} color={C.red} /><Text style={s.deleteText}>Выйти из аккаунта</Text></Pressable>
    <View style={{ height: 20 }} />
    <PinSetupModal visible={pinSetupOpen} onClose={() => setPinSetupOpen(false)} onSaved={() => { setLockEnabledState(true); setPinSetupOpen(false); }} />
    <ImportDraftsModal visible={smsImportOpen} accounts={accounts} onClose={() => { setSmsImportOpen(false); onSmsDraftsChanged(); }} />
  </ScrollView>;
}

const accountTypeOptions: { type: AccountType; label: string; accent: string }[] = [
  { type: 'card', label: 'Карта', accent: '#263C4A' },
  { type: 'credit_card', label: 'Кредитная карта', accent: '#A85E59' },
  { type: 'savings', label: 'Накопительный', accent: '#788D7B' },
  { type: 'deposit', label: 'Вклад', accent: '#5C91AA' },
  { type: 'cash', label: 'Наличные', accent: '#78A0B3' },
];

const commonCurrencies = ['UZS', 'USD', 'RUB', 'EUR', 'CNY', 'KZT', 'AED', 'GBP'];

function CurrencyPicker({ value, onChange }: { value: string; onChange: (currency: string) => void }) {
  return <>
    <View style={s.currencyGrid}>{commonCurrencies.map((item) => <Pressable key={item} style={[s.currencyChip, value === item && s.currencyChipActive]} onPress={() => onChange(item)}><Text style={[s.currencyChipText, value === item && s.currencyActiveText]}>{item}</Text></Pressable>)}</View>
    <TextInput value={commonCurrencies.includes(value) ? '' : value} onChangeText={(text) => onChange(text.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3))} placeholder="Другая валюта: код ISO, например CHF" placeholderTextColor="#9BA9AF" autoCapitalize="characters" maxLength={3} style={[s.input, { marginTop: 8 }]} />
  </>;
}

function DecimalInput({ value, onChange, placeholder, style }: { value?: number; onChange: (value?: number) => void; placeholder?: string; style?: object }) {
  const editableNumber = (input?: number) => {
    if (input === undefined) return '';
    const [integer = '0', fraction] = String(input).split('.');
    return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}${fraction ? `,${fraction}` : ''}`;
  };
  const [text, setText] = useState(editableNumber(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(editableNumber(value)); }, [value, focused]);
  return <TextInput
    value={text}
    onFocus={() => setFocused(true)}
    onBlur={() => setFocused(false)}
    onChangeText={(next) => {
      const cleaned = next.replace(/[^\d.,]/g, '').replace('.', ',');
      const separator = cleaned.includes(',');
      const [rawInteger = '', rawFraction = ''] = cleaned.split(',');
      const integer = rawInteger.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      const fraction = rawFraction.replace(/\D/g, '').slice(0, 2);
      const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
      setText(`${grouped}${separator ? `,${fraction}` : ''}`);
      const normalized = `${integer}${separator ? `.${fraction}` : ''}`;
      if (/^\d+(?:\.\d*)?$/.test(normalized)) {
        const parsed = Number(normalized);
        if (Number.isFinite(parsed)) onChange(parsed);
      } else if (!normalized) onChange(undefined);
    }}
    keyboardType="decimal-pad"
    placeholder={placeholder}
    placeholderTextColor="#9BA9AF"
    style={[s.input, style]}
  />;
}

const dateFromIso = (value?: string) => {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : new Date();
};
const localIso = toLocalIso;

function DateField({ value, onPress, placeholder = 'Выбрать дату' }: { value?: string; onPress: () => void; placeholder?: string }) {
  return <Pressable style={s.dateField} onPress={onPress}><Ionicons name="calendar-outline" size={19} color={C.blue} /><Text style={[s.dateFieldText, !value && { color: C.muted }]}>{value || placeholder}</Text><Ionicons name="chevron-down" size={17} color={C.muted} /></Pressable>;
}

function DatePickerModal({ visible, value, onClose, onSelect }: { visible: boolean; value?: string; onClose: () => void; onSelect: (value: string) => void }) {
  const [monthDate, setMonthDate] = useState(dateFromIso(value));
  useEffect(() => { if (visible) setMonthDate(dateFromIso(value)); }, [visible, value]);
  const year = monthDate.getFullYear(); const month = monthDate.getMonth();
  const offset = (new Date(year, month, 1).getDay() + 6) % 7; const count = new Date(year, month + 1, 0).getDate();
  return <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}><View style={s.dateOverlay}><Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} /><View style={s.datePickerCard}>
    <View style={s.monthBar}><Pressable onPress={() => setMonthDate(new Date(year, month - 1, 1))}><Ionicons name="chevron-back" size={21} color={C.ink} /></Pressable><Text style={s.month}>{monthDate.toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}</Text><Pressable onPress={() => setMonthDate(new Date(year, month + 1, 1))}><Ionicons name="chevron-forward" size={21} color={C.ink} /></Pressable></View>
    <View style={s.weekHead}>{['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'].map((item) => <Text key={item} style={s.weekDay}>{item}</Text>)}</View>
    <View style={s.dateGrid}>{Array.from({ length: offset }, (_, index) => <View key={`blank-${index}`} style={s.datePickerDay} />)}{Array.from({ length: count }, (_, index) => { const day = index + 1; const date = localIso(new Date(year, month, day, 12)); const active = date === value; return <Pressable key={day} style={[s.datePickerDay, active && s.datePickerDayActive]} onPress={() => { onSelect(date); onClose(); }}><Text style={[s.dayNumber, active && { color: 'white' }]}>{day}</Text></Pressable>; })}</View>
  </View></View></Modal>;
}

function InterestSettings({
  startDate, maturityDate, nextInterestDate, schedule, destination, destinationAccountId, currency,
  autoRenewal, rateReviewReminder, withdrawalPolicy, minimumBalance, replenishmentAllowed,
  accounts, currentAccountId, onChange,
}: {
  startDate?: string; maturityDate?: string; nextInterestDate?: string; schedule?: InterestSchedule; destination?: 'same' | 'other';
  destinationAccountId?: string; currency: string; accounts: Account[]; currentAccountId?: string;
  autoRenewal?: boolean; rateReviewReminder?: boolean; withdrawalPolicy?: WithdrawalPolicy;
  minimumBalance?: number; replenishmentAllowed?: boolean;
  onChange: (patch: Partial<AccountInput>) => void;
}) {
  const targets = accounts.filter((account) => account.id !== currentAccountId && account.currency === currency);
  const [dateTarget, setDateTarget] = useState<'start' | 'maturity' | null>(null);
  const automaticMonthlyDate = nextInterestDate ?? (startDate ? nextMonthlyDate(startDate) : undefined);
  return <View style={s.interestBox}>
    <Text style={s.fieldLabel}>СРОК</Text>
    <Text style={s.miniFieldLabel}>Дата открытия</Text><DateField value={startDate} onPress={() => setDateTarget('start')} />
    <Text style={[s.miniFieldLabel, { marginTop: 10 }]}>Дата окончания</Text><DateField value={maturityDate} onPress={() => setDateTarget('maturity')} />
    <Text style={s.fieldLabel}>КОГДА НАЧИСЛЯЮТСЯ ПРОЦЕНТЫ</Text>
    <View style={s.choiceRow}><Pressable style={[s.choice, schedule === 'daily' && s.choiceActive]} onPress={() => onChange({ interestSchedule: 'daily' })}><Text style={[s.choiceText, schedule === 'daily' && s.choiceTextActive]}>Ежедневно</Text></Pressable><Pressable style={[s.choice, schedule === 'monthly' && s.choiceActive]} onPress={() => onChange({ interestSchedule: 'monthly' })}><Text style={[s.choiceText, schedule === 'monthly' && s.choiceTextActive]}>Раз в месяц</Text></Pressable><Pressable style={[s.choice, schedule === 'maturity' && s.choiceActive]} onPress={() => onChange({ interestSchedule: 'maturity' })}><Text style={[s.choiceText, schedule === 'maturity' && s.choiceTextActive]}>В конце срока</Text></Pressable></View>
    {schedule === 'monthly' && <><Text style={s.fieldLabel}>БЛИЖАЙШАЯ ВЫПЛАТА ПРОЦЕНТОВ</Text><Text style={s.helperText}>{automaticMonthlyDate ?? 'Сначала выберите дату открытия'} · определяется автоматически по дню открытия</Text></>}
    <Text style={s.fieldLabel}>КАПИТАЛИЗАЦИЯ ПРОЦЕНТОВ</Text>
    <View style={s.choiceRow}><Pressable style={[s.choice, destination === 'same' && s.choiceActive]} onPress={() => onChange({ interestDestination: 'same', destinationAccountId: undefined })}><Text style={[s.choiceText, destination === 'same' && s.choiceTextActive]}>Да, на вклад</Text></Pressable><Pressable style={[s.choice, destination === 'other' && s.choiceActive]} onPress={() => onChange({ interestDestination: 'other' })}><Text style={[s.choiceText, destination === 'other' && s.choiceTextActive]}>Нет, отдельно</Text></Pressable></View>
    {destination === 'other' && <><Text style={s.fieldLabel}>СЧЁТ ЗАЧИСЛЕНИЯ</Text>{targets.length ? <View style={s.targetList}>{targets.map((target) => <Pressable key={target.id} style={[s.targetAccount, destinationAccountId === target.id && s.targetAccountActive]} onPress={() => onChange({ destinationAccountId: target.id })}><Text style={[s.targetAccountText, destinationAccountId === target.id && { color: C.navy }]}>{target.name}</Text><Text style={s.rowSub}>{money(target.balance, false, target.currency)}</Text></Pressable>)}</View> : <Text style={s.helperText}>Сначала добавьте карту или счёт в валюте {currency}. Пока счёт зачисления не выбран, проценты не начисляются — как только вы его укажете, будут доначислены за весь пропущенный период.</Text>}</>}
    <Text style={s.fieldLabel}>АВТОПРОЛОНГАЦИЯ</Text>
    <View style={s.choiceRow}><Pressable style={[s.choice, autoRenewal === true && s.choiceActive]} onPress={() => onChange({ autoRenewal: true, rateReviewReminder: rateReviewReminder !== false })}><Text style={[s.choiceText, autoRenewal === true && s.choiceTextActive]}>Да</Text></Pressable><Pressable style={[s.choice, autoRenewal !== true && s.choiceActive]} onPress={() => onChange({ autoRenewal: false })}><Text style={[s.choiceText, autoRenewal !== true && s.choiceTextActive]}>Нет</Text></Pressable></View>
    {autoRenewal && <><Text style={s.fieldLabel}>НАПОМНИТЬ ПРОВЕРИТЬ СТАВКУ</Text><View style={s.choiceRow}><Pressable style={[s.choice, rateReviewReminder !== false && s.choiceActive]} onPress={() => onChange({ rateReviewReminder: true })}><Text style={[s.choiceText, rateReviewReminder !== false && s.choiceTextActive]}>Да</Text></Pressable><Pressable style={[s.choice, rateReviewReminder === false && s.choiceActive]} onPress={() => onChange({ rateReviewReminder: false })}><Text style={[s.choiceText, rateReviewReminder === false && s.choiceTextActive]}>Нет</Text></Pressable></View><Text style={s.helperText}>Напоминание появится в календаре в дату пролонгации.</Text></>}
    <Text style={s.fieldLabel}>УСЛОВИЯ СНЯТИЯ</Text>
    <View style={s.targetList}>{([
      ['to_zero', 'Можно снять до 0'], ['minimum_balance', 'До неснижаемого остатка'],
      ['interest_only', 'Только проценты'], ['none', 'Снятие запрещено'],
    ] as [WithdrawalPolicy, string][]).map(([value, label]) => <Pressable key={value} style={[s.targetAccount, withdrawalPolicy === value && s.targetAccountActive]} onPress={() => onChange({ withdrawalPolicy: value })}><Text style={[s.targetAccountText, withdrawalPolicy === value && { color: C.navy }]}>{label}</Text></Pressable>)}</View>
    {withdrawalPolicy === 'minimum_balance' && <><Text style={s.fieldLabel}>НЕСНИЖАЕМЫЙ ОСТАТОК, {currency}</Text><DecimalInput value={minimumBalance} onChange={(value) => onChange({ minimumBalance: value })} placeholder="800000,00" /></>}
    <Text style={s.fieldLabel}>ПОПОЛНЕНИЕ ВКЛАДА</Text>
    <View style={s.choiceRow}><Pressable style={[s.choice, replenishmentAllowed === true && s.choiceActive]} onPress={() => onChange({ replenishmentAllowed: true })}><Text style={[s.choiceText, replenishmentAllowed === true && s.choiceTextActive]}>Разрешено</Text></Pressable><Pressable style={[s.choice, replenishmentAllowed === false && s.choiceActive]} onPress={() => onChange({ replenishmentAllowed: false })}><Text style={[s.choiceText, replenishmentAllowed === false && s.choiceTextActive]}>Запрещено</Text></Pressable></View>
    <DatePickerModal visible={dateTarget !== null} value={dateTarget === 'maturity' ? maturityDate : startDate} onClose={() => setDateTarget(null)} onSelect={(value) => onChange(dateTarget === 'maturity' ? { maturityDate: value } : { startDate: value, nextInterestDate: nextMonthlyDate(value) })} />
  </View>;
}

function AccountEditor({
  visible, account, accounts, rateHistory, onClose, onSave, onDelete,
}: {
  visible: boolean;
  account: Account | null;
  accounts: Account[];
  rateHistory: DepositRateHistory[];
  onClose: () => void;
  onSave: (input: AccountInput) => Promise<void>;
  onDelete: (account: Account) => void;
}) {
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [type, setType] = useState<AccountType>('card');
  const [balance, setBalance] = useState<number | undefined>();
  const [currency, setCurrency] = useState('UZS');
  const [rate, setRate] = useState<number | undefined>();
  const [startDate, setStartDate] = useState('');
  const [maturityDate, setMaturityDate] = useState('');
  const [interestSchedule, setInterestSchedule] = useState<InterestSchedule>('daily');
  const [interestDestination, setInterestDestination] = useState<'same' | 'other'>('same');
  const [destinationAccountId, setDestinationAccountId] = useState<string | undefined>();
  const [nextInterestDate, setNextInterestDate] = useState('');
  const [autoRenewal, setAutoRenewal] = useState(false);
  const [rateReviewReminder, setRateReviewReminder] = useState(true);
  const [withdrawalPolicy, setWithdrawalPolicy] = useState<WithdrawalPolicy>('none');
  const [minimumBalance, setMinimumBalance] = useState<number | undefined>();
  const [replenishmentAllowed, setReplenishmentAllowed] = useState(false);
  const [creditLimit, setCreditLimit] = useState<number | undefined>();
  const [statementDay, setStatementDay] = useState<number | undefined>();
  const [paymentDueDay, setPaymentDueDay] = useState<number | undefined>();
  const [gracePeriodDays, setGracePeriodDays] = useState<number | undefined>();
  const [minimumPaymentPercent, setMinimumPaymentPercent] = useState<number | undefined>();
  const [cardLast4, setCardLast4] = useState('');
  const [taxRate, setTaxRate] = useState<number | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName(account?.name ?? '');
    setSubtitle(account?.subtitle ?? '');
    setType(account?.type ?? 'card');
    setBalance(account?.type === 'credit_card' ? Math.abs(Math.min(0, account.balance)) : account?.balance);
    setCurrency(account?.currency ?? 'UZS');
    setRate(account?.rate);
    setStartDate(account?.startDate ?? localToday());
    setMaturityDate(account?.maturityDate ?? '');
    setInterestSchedule(account?.interestSchedule ?? 'daily');
    setInterestDestination(account?.interestDestination ?? 'same');
    setDestinationAccountId(account?.destinationAccountId);
    setNextInterestDate(account?.nextInterestDate ?? '');
    setAutoRenewal(account?.autoRenewal ?? false);
    setRateReviewReminder(account?.rateReviewReminder ?? true);
    setWithdrawalPolicy(account?.withdrawalPolicy ?? 'none');
    setMinimumBalance(account?.minimumBalance);
    setReplenishmentAllowed(account?.replenishmentAllowed ?? false);
    setCreditLimit(account?.creditLimit); setStatementDay(account?.statementDay); setPaymentDueDay(account?.paymentDueDay);
    setGracePeriodDays(account?.gracePeriodDays); setMinimumPaymentPercent(account?.minimumPaymentPercent ?? 5);
    setCardLast4(account?.cardLast4 ?? '');
    setTaxRate(account?.taxRate);
  }, [visible, account]);

  const submit = async () => {
    const numericBalance = balance;
    const numericRate = rate;
    if (!name.trim()) { Alert.alert('Укажите название счёта'); return; }
    if (numericBalance === undefined || !Number.isFinite(numericBalance)) { Alert.alert('Проверьте начальный баланс'); return; }
    if (!/^[A-Z]{3}$/.test(currency)) { Alert.alert('Укажите трёхбуквенный код валюты, например UZS, RUB или EUR'); return; }
    if (cardLast4.trim() && !/^\d{4}$/.test(cardLast4.trim())) { Alert.alert('Последние 4 цифры карты — ровно 4 цифры'); return; }
    if (type === 'deposit' && !maturityDate) { Alert.alert('Укажите дату окончания вклада'); return; }
    if (type === 'credit_card' && (!creditLimit || creditLimit <= 0)) { Alert.alert('Укажите кредитный лимит'); return; }
    if (type === 'credit_card' && (!statementDay || statementDay < 1 || statementDay > 31 || !paymentDueDay || paymentDueDay < 1 || paymentDueDay > 31)) { Alert.alert('Укажите дни выписки и платежа от 1 до 31'); return; }
    if (type === 'credit_card' && (!minimumPaymentPercent || minimumPaymentPercent <= 0 || minimumPaymentPercent > 100)) { Alert.alert('Укажите минимальный платёж от 0 до 100%'); return; }
    if (withdrawalPolicy === 'minimum_balance' && (!Number.isFinite(minimumBalance) || (minimumBalance ?? -1) < 0)) { Alert.alert('Укажите неснижаемый остаток'); return; }
    if (taxRate !== undefined && (taxRate < 0 || taxRate > 100)) { Alert.alert('Налог на проценты — от 0 до 100%'); return; }
    const option = accountTypeOptions.find((item) => item.type === type) ?? accountTypeOptions[0];
    if (!option) return;
    setSaving(true);
    try {
      await onSave({
        name: name.trim(), subtitle: subtitle.trim() || option.label, type,
        balance: type === 'credit_card' ? -Math.abs(numericBalance) : numericBalance, currency, rate: numericRate,
        rateCaption: numericRate ? 'годовых' : undefined,
        startDate: type === 'deposit' || type === 'savings' ? startDate : undefined,
        maturityDate: type === 'deposit' || type === 'savings' ? maturityDate || undefined : undefined,
        interestSchedule: type === 'deposit' || type === 'savings' ? interestSchedule : undefined,
        interestDestination: type === 'deposit' || type === 'savings' ? interestDestination : undefined,
        destinationAccountId: type === 'deposit' || type === 'savings' ? destinationAccountId : undefined,
        nextInterestDate: type === 'deposit' || type === 'savings' ? (interestSchedule === 'monthly' ? nextInterestDate || nextMonthlyDate(startDate) : nextInterestDate || undefined) : undefined,
        autoRenewal: type === 'deposit' || type === 'savings' ? autoRenewal : undefined,
        rateReviewReminder: type === 'deposit' || type === 'savings' ? rateReviewReminder : undefined,
        withdrawalPolicy: type === 'deposit' || type === 'savings' ? withdrawalPolicy : undefined,
        minimumBalance: type === 'deposit' || type === 'savings' ? minimumBalance : undefined,
        replenishmentAllowed: type === 'deposit' || type === 'savings' ? replenishmentAllowed : undefined,
        creditLimit: type === 'credit_card' ? creditLimit : undefined,
        statementDay: type === 'credit_card' ? Math.round(statementDay ?? 1) : undefined,
        paymentDueDay: type === 'credit_card' ? Math.round(paymentDueDay ?? 1) : undefined,
        gracePeriodDays: type === 'credit_card' ? Math.round(gracePeriodDays ?? 0) : undefined,
        minimumPaymentPercent: type === 'credit_card' ? minimumPaymentPercent : undefined,
        accent: option.accent,
        cardLast4: cardLast4.trim() || undefined,
        taxRate: type === 'deposit' || type === 'savings' ? taxRate : undefined,
      });
    } finally { setSaving(false); }
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={s.modal} edges={['top', 'bottom']}>
      <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{account ? 'Редактировать счёт' : 'Новый счёт'}</Text><View style={{ width: 40 }} /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
          <Text style={s.fieldLabel}>ТИП СЧЁТА</Text>
          <View style={s.typeGrid}>{accountTypeOptions.map((option) => <Pressable key={option.type} style={[s.typeOption, type === option.type && s.typeOptionActive]} onPress={() => setType(option.type)}><Ionicons name={iconForType[option.type]} size={20} color={type === option.type ? C.navy : C.muted} /><Text style={[s.typeLabel, type === option.type && s.typeLabelActive]}>{option.label}</Text></Pressable>)}</View>

          <Text style={s.fieldLabel}>НАЗВАНИЕ</Text>
          <TextInput value={name} onChangeText={setName} placeholder="Например, Основная карта" placeholderTextColor="#9BA9AF" style={s.input} />
          <Text style={s.fieldLabel}>БАНК ИЛИ ОПИСАНИЕ</Text>
          <TextInput value={subtitle} onChangeText={setSubtitle} placeholder="Например, Kapitalbank • 4821" placeholderTextColor="#9BA9AF" style={s.input} />
          <Text style={s.fieldLabel}>ПОСЛЕДНИЕ 4 ЦИФРЫ КАРТЫ · НЕОБЯЗАТЕЛЬНО</Text>
          <TextInput value={cardLast4} onChangeText={(text) => setCardLast4(text.replace(/\D/g, '').slice(0, 4))} placeholder="0000" placeholderTextColor="#9BA9AF" keyboardType="number-pad" maxLength={4} style={s.input} />
          <Text style={s.helperText}>Нужно, чтобы Афина сама находила этот счёт по SMS от банка или фото чека.</Text>
          <Text style={s.fieldLabel}>{type === 'credit_card' ? 'ТЕКУЩАЯ ЗАДОЛЖЕННОСТЬ' : 'БАЛАНС'}</Text><DecimalInput value={balance} onChange={setBalance} placeholder="0,00" />
          <Text style={s.fieldLabel}>ВАЛЮТА</Text><CurrencyPicker value={currency} onChange={(value) => { setCurrency(value); setDestinationAccountId(undefined); }} />
          {type === 'credit_card' && <><Text style={s.fieldLabel}>КРЕДИТНЫЙ ЛИМИТ</Text><DecimalInput value={creditLimit} onChange={setCreditLimit} placeholder="0,00" /><View style={s.twoColumns}><View style={{ flex: 1 }}><Text style={s.fieldLabel}>ДЕНЬ ВЫПИСКИ</Text><DecimalInput value={statementDay} onChange={setStatementDay} placeholder="Например, 5" /></View><View style={{ flex: 1 }}><Text style={s.fieldLabel}>ДЕНЬ ПЛАТЕЖА</Text><DecimalInput value={paymentDueDay} onChange={setPaymentDueDay} placeholder="Например, 25" /></View></View><View style={s.twoColumns}><View style={{ flex: 1 }}><Text style={s.fieldLabel}>ЛЬГОТНЫЙ ПЕРИОД, ДНЕЙ</Text><DecimalInput value={gracePeriodDays} onChange={setGracePeriodDays} placeholder="Например, 55" /></View><View style={{ flex: 1 }}><Text style={s.fieldLabel}>МИН. ПЛАТЁЖ, %</Text><DecimalInput value={minimumPaymentPercent} onChange={setMinimumPaymentPercent} placeholder="Например, 5" /></View></View><Text style={s.fieldLabel}>СТАВКА ПОСЛЕ ЛЬГОТНОГО ПЕРИОДА, %</Text><DecimalInput value={rate} onChange={setRate} placeholder="Например, 36" /></>}
          {(type === 'deposit' || type === 'savings') && <><Text style={s.fieldLabel}>ПРОЦЕНТНАЯ СТАВКА, % ГОДОВЫХ</Text><DecimalInput value={rate} onChange={setRate} placeholder="Например, 17" /><Text style={s.fieldLabel}>НАЛОГ НА ПРОЦЕНТЫ, % (ЕСЛИ БАНК УДЕРЖИВАЕТ)</Text><DecimalInput value={taxRate} onChange={setTaxRate} placeholder="Например, 20 — если не удерживают, оставьте пустым" /><InterestSettings startDate={startDate} maturityDate={maturityDate} nextInterestDate={nextInterestDate} schedule={interestSchedule} destination={interestDestination} destinationAccountId={destinationAccountId} autoRenewal={autoRenewal} rateReviewReminder={rateReviewReminder} withdrawalPolicy={withdrawalPolicy} minimumBalance={minimumBalance} replenishmentAllowed={replenishmentAllowed} currency={currency} accounts={accounts} currentAccountId={account?.id} onChange={(patch) => { if (patch.startDate !== undefined) setStartDate(patch.startDate); if (patch.maturityDate !== undefined) setMaturityDate(patch.maturityDate); if ('nextInterestDate' in patch) setNextInterestDate(patch.nextInterestDate ?? ''); if (patch.interestSchedule) setInterestSchedule(patch.interestSchedule); if (patch.interestDestination) setInterestDestination(patch.interestDestination); if ('destinationAccountId' in patch) setDestinationAccountId(patch.destinationAccountId); if ('autoRenewal' in patch) setAutoRenewal(patch.autoRenewal ?? false); if ('rateReviewReminder' in patch) setRateReviewReminder(patch.rateReviewReminder ?? true); if (patch.withdrawalPolicy) setWithdrawalPolicy(patch.withdrawalPolicy); if ('minimumBalance' in patch) setMinimumBalance(patch.minimumBalance); if ('replenishmentAllowed' in patch) setReplenishmentAllowed(patch.replenishmentAllowed ?? false); }} /></>}
          {(type === 'deposit' || type === 'savings') && rateHistory.length > 0 && <>
            <Text style={s.fieldLabel}>ИСТОРИЯ СТАВОК</Text>
            <View style={s.targetList}>{rateHistory.map((event) => <View key={event.id} style={s.historyRow}><View style={{ flex: 1 }}><Text style={s.rowTitle}>{event.oldRate !== undefined ? `${event.oldRate}% → ` : ''}{event.newRate}%</Text><Text style={s.rowSub}>{event.occurredAt.slice(0, 10)}{event.newMaturityDate ? ` · до ${event.newMaturityDate}` : ''}</Text></View></View>)}</View>
          </>}

          <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={submit}><Text style={s.primaryText}>{saving ? 'Сохраняем…' : account ? 'Сохранить изменения' : 'Добавить счёт'}</Text></Pressable>
          {account && <Pressable style={s.deleteButton} onPress={() => onDelete(account)}><Ionicons name="trash-outline" size={18} color={C.red} /><Text style={s.deleteText}>Удалить счёт</Text></Pressable>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function OperationEditor({ visible, accounts, onClose, onSave }: { visible: boolean; accounts: Account[]; onClose: () => void; onSave: (input: FinancialOperationInput) => Promise<void> }) {
  const [kind, setKind] = useState<'income' | 'expense'>('expense'); const [title, setTitle] = useState(''); const [category, setCategory] = useState('Другое');
  const [amount, setAmount] = useState<number | undefined>(); const [accountId, setAccountId] = useState<string | undefined>();
  const [date, setDate] = useState(localIso(new Date())); const [dateOpen, setDateOpen] = useState(false); const [saving, setSaving] = useState(false);
  const [receiptUri, setReceiptUri] = useState<string | undefined>();
  useEffect(() => { if (visible) { setKind('expense'); setTitle(''); setCategory('Другое'); setAmount(undefined); setAccountId(accounts[0]?.id); setDate(localIso(new Date())); setReceiptUri(undefined); } }, [visible]);
  const account = accounts.find((item) => item.id === accountId);
  const attachReceipt = async (fromCamera: boolean) => {
    const result = fromCamera
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!result.canceled && result.assets[0]?.uri) setReceiptUri(result.assets[0].uri);
  };
  const submit = async () => {
    if (!account || !title.trim() || !amount || amount <= 0) { Alert.alert('Заполните счёт, название и сумму'); return; }
    setSaving(true); try { await onSave({ title: title.trim(), category: category.trim() || 'Другое', amount, currency: account.currency, accountId: account.id, date, kind, receiptPhotoUri: receiptUri }); } finally { setSaving(false); }
  };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}><View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Новая операция</Text><View style={{ width: 40 }} /></View><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={s.fieldLabel}>ТИП</Text><View style={s.choiceRow}><Pressable style={[s.choice, kind === 'expense' && s.choiceActive]} onPress={() => setKind('expense')}><Text style={[s.choiceText, kind === 'expense' && s.choiceTextActive]}>Расход</Text></Pressable><Pressable style={[s.choice, kind === 'income' && s.choiceActive]} onPress={() => setKind('income')}><Text style={[s.choiceText, kind === 'income' && s.choiceTextActive]}>Доход</Text></Pressable></View>
    <Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} placeholder="Например, супермаркет" placeholderTextColor="#9BA9AF" style={s.input} /><Text style={s.fieldLabel}>КАТЕГОРИЯ</Text><TextInput value={category} onChangeText={setCategory} placeholder="Продукты, жильё…" placeholderTextColor="#9BA9AF" style={s.input} /><Text style={s.fieldLabel}>СУММА</Text><DecimalInput value={amount} onChange={setAmount} placeholder="0,00" />
    <Text style={s.fieldLabel}>СЧЁТ</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, accountId === item.id && s.targetAccountActive]} onPress={() => setAccountId(item.id)}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}</View>
    <Text style={s.fieldLabel}>ДАТА</Text><DateField value={date} onPress={() => setDateOpen(true)} />
    <Text style={s.fieldLabel}>ФОТО ЧЕКА · НЕОБЯЗАТЕЛЬНО</Text>
    {receiptUri ? <View style={{ marginBottom: 12 }}>
      <Image source={{ uri: receiptUri }} style={{ width: '100%', height: 160, borderRadius: 14, backgroundColor: '#DDD' }} resizeMode="cover" />
      <Pressable style={[s.secondaryButton, { marginTop: 8 }]} onPress={() => setReceiptUri(undefined)}><Text style={s.secondaryText}>Убрать фото</Text></Pressable>
    </View> : <View style={s.twoColumns}>
      <Pressable style={[s.manualAccountButton, { flex: 1 }]} onPress={() => attachReceipt(true)}><Ionicons name="camera-outline" size={18} color={C.blue} /><Text style={s.manualAccountText}>Сделать фото</Text></Pressable>
      <Pressable style={[s.manualAccountButton, { flex: 1 }]} onPress={() => attachReceipt(false)}><Ionicons name="images-outline" size={18} color={C.blue} /><Text style={s.manualAccountText}>Из галереи</Text></Pressable>
    </View>}
    <Pressable style={s.primaryButton} disabled={saving} onPress={submit}><Text style={s.primaryText}>{saving ? 'Сохраняем…' : 'Добавить операцию'}</Text></Pressable>
  </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateOpen} value={date} onClose={() => setDateOpen(false)} onSelect={setDate} /></SafeAreaView></Modal>;
}

function TransferModal({ visible, accounts, currencySettings, onClose, onSave }: {
  visible: boolean; accounts: Account[]; currencySettings: CurrencySettings;
  onClose: () => void; onSave: (input: TransferInput) => Promise<void>;
}) {
  const [fromAccountId, setFromAccountId] = useState<string | undefined>();
  const [toAccountId, setToAccountId] = useState<string | undefined>();
  const [fromAmount, setFromAmount] = useState<number | undefined>();
  const [toAmount, setToAmount] = useState<number | undefined>();
  const [rate, setRate] = useState<number | undefined>();
  const [date, setDate] = useState(localToday());
  const [note, setNote] = useState('');
  const [dateOpen, setDateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toAmountTouched, setToAmountTouched] = useState(false);
  const submitLock = useRef(false);

  useEffect(() => {
    if (!visible) return;
    const first = accounts[0]?.id;
    setFromAccountId(first);
    setToAccountId(accounts.find((item) => item.id !== first)?.id);
    setFromAmount(undefined); setToAmount(undefined); setRate(undefined); setToAmountTouched(false);
    setDate(localToday()); setNote(''); setSaving(false); submitLock.current = false;
  }, [visible]);
  // A stale rate/amount from a previous account pair must not silently carry over —
  // if either side's currency changes, the conversion has to be re-entered.
  useEffect(() => { setToAmount(undefined); setRate(undefined); setToAmountTouched(false); }, [fromAccountId, toAccountId]);

  const fromAccount = accounts.find((item) => item.id === fromAccountId);
  const toAccount = accounts.find((item) => item.id === toAccountId);
  const sameCurrency = !!fromAccount && !!toAccount && fromAccount.currency === toAccount.currency;
  const sourceRate = fromAccount?.currency === currencySettings.baseCurrency ? 1 : fromAccount ? currencySettings.rates[fromAccount.currency] : undefined;
  const targetRate = toAccount?.currency === currencySettings.baseCurrency ? 1 : toAccount ? currencySettings.rates[toAccount.currency] : undefined;
  const automaticRate = !sameCurrency && sourceRate && targetRate ? sourceRate / targetRate : undefined;
  const round = (value: number) => Math.round(value * 1e6) / 1e6;

  const changeFromAmount = (value?: number) => {
    setFromAmount(value);
    if (sameCurrency) { setToAmount(value); return; }
    // Don't overwrite an amount the user typed directly into "сумма зачисления" — that can
    // happen if they filled it in before this field, and clobbering it would silently save a
    // different number than what they last entered.
    if (toAmountTouched) return;
    const effectiveRate = rate ?? automaticRate;
    if (value !== undefined && effectiveRate) setToAmount(round(value * effectiveRate));
  };
  const changeToAmount = (value?: number) => {
    setToAmount(value);
    setToAmountTouched(true);
    if (sameCurrency) { setFromAmount(value); return; }
    if (value !== undefined && fromAmount) setRate(round(value / fromAmount));
  };
  const changeRate = (value?: number) => {
    setRate(value);
    setToAmountTouched(false);
    if (value !== undefined && fromAmount !== undefined) setToAmount(round(fromAmount * value));
  };

  const submit = async () => {
    if (submitLock.current) return;
    if (!fromAccountId || !toAccountId) { Alert.alert('Выберите счета списания и зачисления'); return; }
    if (!fromAmount || fromAmount <= 0) { Alert.alert('Укажите сумму списания'); return; }
    const finalToAmount = sameCurrency ? fromAmount : toAmount;
    if (!finalToAmount || finalToAmount <= 0) { Alert.alert('Укажите курс или сумму зачисления'); return; }
    submitLock.current = true;
    setSaving(true);
    try {
      await onSave({
        fromAccountId, toAccountId, fromAmount, toAmount: finalToAmount,
        exchangeRate: sameCurrency ? undefined : rate ?? automaticRate, note: note.trim() || undefined, date,
      });
    } finally { setSaving(false); submitLock.current = false; }
  };

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}><View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Перевод между счетами</Text><View style={{ width: 40 }} /></View><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={s.fieldLabel}>СЧЁТ СПИСАНИЯ</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, fromAccountId === item.id && s.targetAccountActive]} onPress={() => { setFromAccountId(item.id); if (item.id === toAccountId) setToAccountId(undefined); }}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}</View>
    <Text style={s.fieldLabel}>СЧЁТ ЗАЧИСЛЕНИЯ</Text><View style={s.targetList}>{accounts.filter((item) => item.id !== fromAccountId).map((item) => <Pressable key={item.id} style={[s.targetAccount, toAccountId === item.id && s.targetAccountActive]} onPress={() => setToAccountId(item.id)}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}</View>
    <Text style={s.fieldLabel}>СУММА СПИСАНИЯ{fromAccount ? ` · ${fromAccount.currency}` : ''}</Text><DecimalInput value={fromAmount} onChange={changeFromAmount} placeholder="0,00" />
    {!sameCurrency && fromAccount && toAccount && <>
      <Text style={s.fieldLabel}>КУРС · 1 {fromAccount.currency} В {toAccount.currency}</Text>
      <DecimalInput value={rate} onChange={changeRate} placeholder={automaticRate ? `Автоматически: ${automaticRate.toFixed(6)}` : 'Введите курс'} />
      <Text style={s.helperText}>{rate ? 'Используется указанный вручную курс.' : automaticRate ? `Будет использован сохранённый курс: 1 ${fromAccount.currency} = ${automaticRate.toFixed(6)} ${toAccount.currency}.` : 'Для пересчёта нужен курс — введите его или сумму зачисления вручную.'}</Text>
      <Text style={s.fieldLabel}>СУММА ЗАЧИСЛЕНИЯ · {toAccount.currency}</Text><DecimalInput value={toAmount} onChange={changeToAmount} placeholder="0,00" />
    </>}
    <Text style={s.fieldLabel}>ДАТА</Text><DateField value={date} onPress={() => setDateOpen(true)} />
    <Text style={s.fieldLabel}>ЗАМЕТКА</Text><TextInput value={note} onChangeText={setNote} placeholder="Необязательно" placeholderTextColor="#9BA9AF" style={s.input} />
    <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={submit}><Text style={s.primaryText}>{saving ? 'Сохраняем…' : 'Перевести'}</Text></Pressable>
  </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateOpen} value={date} onClose={() => setDateOpen(false)} onSelect={setDate} /></SafeAreaView></Modal>;
}

function ExecuteOccurrenceModal({ visible, occurrence, flow, accounts, currencySettings, onClose, onExecute }: {
  visible: boolean; occurrence: PlannedOccurrence | null; flow: PlannedExpense | null; accounts: Account[]; currencySettings: CurrencySettings;
  onClose: () => void; onExecute: (input: PlannedExecutionInput) => Promise<void>;
}) {
  const [title, setTitle] = useState(''); const [category, setCategory] = useState('');
  const [amount, setAmount] = useState<number | undefined>(); const [currency, setCurrency] = useState('UZS');
  const [date, setDate] = useState(localToday()); const [accountId, setAccountId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false); const [dateOpen, setDateOpen] = useState(false);
  // Defaulting the fact amount to the plan's raw number when the fact currency differs (e.g. a
  // plan in USD executed into a RUB account) would silently treat 1 USD as 1 RUB — convert using
  // the current stored rate instead, and only fall back to the unconverted number when no rate is
  // available at all, so the user is never shown a default that quietly assumes parity.
  const defaultAmountFor = (targetCurrency: string) => {
    if (!occurrence) return undefined;
    if (targetCurrency === occurrence.currency) return occurrence.amount;
    const converted = convertCurrency(occurrence.amount, occurrence.currency, targetCurrency, currencySettings);
    return converted === null ? occurrence.amount : Math.round(converted * 100) / 100;
  };
  useEffect(() => {
    if (!visible || !flow || !occurrence) return;
    const initialAccount = accounts.find((item) => item.id === flow.accountId);
    // The fact currency always follows the selected account, never the plan's currency — that's
    // the actual point of this feature (the two are allowed to differ), and it's what keeps a
    // cross-currency mismatch from ever reaching the balance update in executePlannedOccurrence.
    const initialCurrency = initialAccount?.currency ?? occurrence.currency;
    setTitle(flow.title); setCategory(flow.category);
    setAmount(defaultAmountFor(initialCurrency));
    setCurrency(initialCurrency);
    setDate(occurrence.occurrenceDate); setAccountId(flow.accountId); setSaving(false);
  }, [visible, flow, occurrence]);
  if (!flow || !occurrence) return null;
  const account = accounts.find((item) => item.id === accountId);
  const selectAccount = (item: Account | undefined) => {
    setAccountId(item?.id);
    const nextCurrency = item?.currency ?? currency;
    setCurrency(nextCurrency);
    setAmount(defaultAmountFor(nextCurrency));
  };
  const submit = async () => {
    if (!title.trim() || !amount || amount <= 0) { Alert.alert('Укажите название и сумму'); return; }
    setSaving(true);
    try { await onExecute({ title: title.trim(), category: category.trim() || 'Другое', amount, currency, accountId, date }); }
    finally { setSaving(false); }
  };
  const deviates = amount !== undefined && (Math.abs(amount - occurrence.amount) > 0.005 || currency !== occurrence.currency);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}><View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Провести плановое событие</Text><View style={{ width: 40 }} /></View><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={s.fieldLabel}>ЗАПЛАНИРОВАНО НА {occurrence.occurrenceDate}</Text><Text style={s.helperText}>{money(occurrence.amount, false, occurrence.currency)}</Text>
    <Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} style={s.input} />
    <Text style={s.fieldLabel}>КАТЕГОРИЯ</Text><TextInput value={category} onChangeText={setCategory} style={s.input} />
    <Text style={s.fieldLabel}>{flow.kind === 'income' ? 'СЧЁТ ЗАЧИСЛЕНИЯ' : 'СЧЁТ СПИСАНИЯ'}</Text>
    <View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, accountId === item.id && s.targetAccountActive]} onPress={() => selectAccount(item)}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}<Pressable style={[s.targetAccount, !accountId && s.targetAccountActive]} onPress={() => selectAccount(undefined)}><Text style={s.targetAccountText}>Без движения по счёту</Text></Pressable></View>
    <Text style={s.fieldLabel}>ФАКТИЧЕСКАЯ СУММА{account ? ` · ${account.currency}` : ''}</Text><DecimalInput value={amount} onChange={setAmount} placeholder="0,00" />
    {!account && <><Text style={s.fieldLabel}>ФАКТИЧЕСКАЯ ВАЛЮТА</Text><CurrencyPicker value={currency} onChange={setCurrency} /></>}
    {deviates && <Text style={s.helperText}>Отклонение от плана: {money(occurrence.amount, false, occurrence.currency)} → {money(amount ?? 0, false, currency)}</Text>}
    <Text style={s.fieldLabel}>ДАТА</Text><DateField value={date} onPress={() => setDateOpen(true)} />
    <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={submit}><Text style={s.primaryText}>{saving ? 'Проводим…' : 'Провести'}</Text></Pressable>
  </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateOpen} value={date} onClose={() => setDateOpen(false)} onSelect={(value) => { setDate(value); setDateOpen(false); }} /></SafeAreaView></Modal>;
}

function BudgetEditor({ visible, budget, currencies, onClose, onSave, onDelete }: { visible: boolean; budget: Budget | null; currencies: string[]; onClose: () => void; onSave: (input: BudgetInput) => Promise<void>; onDelete: (budget: Budget) => void }) {
  const [category, setCategory] = useState(''); const [currency, setCurrency] = useState('UZS'); const [limit, setLimit] = useState<number | undefined>();
  useEffect(() => { if (visible) { setCategory(budget?.category ?? ''); setCurrency(budget?.currency ?? currencies[0] ?? 'UZS'); setLimit(budget?.limit); } }, [visible, budget]);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}><View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{budget ? 'Изменить бюджет' : 'Новый бюджет'}</Text><View style={{ width: 40 }} /></View><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={s.fieldLabel}>КАТЕГОРИЯ</Text><TextInput value={category} onChangeText={setCategory} placeholder="Например, продукты" placeholderTextColor="#9BA9AF" style={s.input} /><Text style={s.fieldLabel}>ВАЛЮТА</Text><CurrencyPicker value={currency} onChange={setCurrency} /><Text style={s.fieldLabel}>ЛИМИТ НА МЕСЯЦ</Text><DecimalInput value={limit} onChange={setLimit} placeholder="0,00" /><Pressable style={s.primaryButton} onPress={() => category.trim() && limit && limit > 0 ? onSave({ category: category.trim(), currency, limit }) : Alert.alert('Укажите категорию и лимит')}><Text style={s.primaryText}>Сохранить бюджет</Text></Pressable>{budget && <Pressable style={s.deleteButton} onPress={() => onDelete(budget)}><Ionicons name="trash-outline" size={18} color={C.red} /><Text style={s.deleteText}>Удалить бюджет</Text></Pressable>}
  </ScrollView></KeyboardAvoidingView></SafeAreaView></Modal>;
}

function GoalEditor({ visible, goal, accounts, debts, onClose, onSave, onDelete }: { visible: boolean; goal: FinancialGoal | null; accounts: Account[]; debts: Debt[]; onClose: () => void; onSave: (input: FinancialGoalInput) => Promise<void>; onDelete: (goal: FinancialGoal) => void }) {
  const [title, setTitle] = useState(''); const [type, setType] = useState<GoalType>('balance'); const [target, setTarget] = useState<number | undefined>();
  const [currency, setCurrency] = useState('UZS'); const [deadline, setDeadline] = useState(localIso(new Date(new Date().getFullYear() + 1, new Date().getMonth(), new Date().getDate(), 12)));
  const [accountId, setAccountId] = useState<string | undefined>(); const [debtId, setDebtId] = useState<string | undefined>(); const [dateOpen, setDateOpen] = useState(false);
  const [includeAllCurrencies, setIncludeAllCurrencies] = useState(false);
  useEffect(() => { if (visible) { setTitle(goal?.title ?? ''); setType(goal?.type ?? 'balance'); setTarget(goal?.target); setCurrency(goal?.currency ?? accounts[0]?.currency ?? 'UZS'); setDeadline(goal?.deadline ?? localIso(new Date(new Date().getFullYear() + 1, new Date().getMonth(), new Date().getDate(), 12))); setAccountId(goal?.accountId); setDebtId(goal?.debtId); setIncludeAllCurrencies(goal?.includeAllCurrencies ?? false); } }, [visible, goal]);
  const selectDebt = (debt: Debt) => { setDebtId(debt.id); setCurrency(debt.currency); setTarget(debt.originalAmount); if (!title) setTitle(`Погасить долг · ${debt.person}`); };
  const submit = () => {
    if (!title.trim() || !target || target <= 0) { Alert.alert('Укажите название и целевую сумму'); return; }
    if (type === 'debt_payoff' && !debtId) { Alert.alert('Выберите долг для погашения'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) { Alert.alert('Проверьте срок достижения цели'); return; }
    onSave({ title: title.trim(), type, target, currency, deadline, accountId: type === 'balance' ? accountId : undefined, debtId: type === 'debt_payoff' ? debtId : undefined, includeAllCurrencies: type === 'balance' && !accountId ? includeAllCurrencies : undefined });
  };
  const typeOptions: { value: GoalType; label: string }[] = [{ value: 'balance', label: 'Накопить остаток' }, { value: 'monthly_income', label: 'Доход в месяц' }, { value: 'debt_payoff', label: 'Погасить долг' }];
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}><View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{goal ? 'Изменить цель' : 'Новая цель'}</Text><View style={{ width: 40 }} /></View><KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
    <Text style={s.fieldLabel}>ТИП ЦЕЛИ</Text><View style={s.repeatGrid}>{typeOptions.map((option) => <Pressable key={option.value} style={[s.repeatChoice, type === option.value && s.choiceActive]} onPress={() => { setType(option.value); setAccountId(undefined); setDebtId(undefined); }}><Text style={[s.choiceText, type === option.value && s.choiceTextActive]}>{option.label}</Text></Pressable>)}</View>
    <Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} placeholder="Например, финансовая подушка" placeholderTextColor="#9BA9AF" style={s.input} />
    {type === 'debt_payoff' ? <><Text style={s.fieldLabel}>ДОЛГ</Text><View style={s.targetList}>{debts.filter((debt) => debt.status !== 'paid').map((debt) => <Pressable key={debt.id} style={[s.targetAccount, debtId === debt.id && s.targetAccountActive]} onPress={() => selectDebt(debt)}><Text style={s.targetAccountText}>{debt.person} · {debt.title}</Text><Text style={s.rowSub}>{money(debt.currentBalance, false, debt.currency)}</Text></Pressable>)}</View></> : <><Text style={s.fieldLabel}>ВАЛЮТА</Text><CurrencyPicker value={currency} onChange={(value) => { setCurrency(value); setAccountId(undefined); }} /></>}
    {type === 'balance' && <><Text style={s.fieldLabel}>КАКОЙ ОСТАТОК СЧИТАТЬ</Text><View style={s.targetList}>
      <Pressable style={[s.targetAccount, !accountId && !includeAllCurrencies && s.targetAccountActive]} onPress={() => { setAccountId(undefined); setIncludeAllCurrencies(false); }}><Text style={s.targetAccountText}>Все счета в {currency}</Text><Text style={s.rowSub}>Только счета в этой валюте, без пересчёта</Text></Pressable>
      <Pressable style={[s.targetAccount, !accountId && includeAllCurrencies && s.targetAccountActive]} onPress={() => { setAccountId(undefined); setIncludeAllCurrencies(true); }}><Text style={s.targetAccountText}>Все счета в пересчёте в {currency}</Text><Text style={s.rowSub}>Счета в любых валютах, конвертированные по текущему курсу</Text></Pressable>
      {accounts.filter((account) => account.currency === currency).map((account) => <Pressable key={account.id} style={[s.targetAccount, accountId === account.id && s.targetAccountActive]} onPress={() => setAccountId(account.id)}><Text style={s.targetAccountText}>{account.name}</Text><Text style={s.rowSub}>{money(account.balance, false, currency)}</Text></Pressable>)}
    </View></>}
    <Text style={s.fieldLabel}>ЦЕЛЕВАЯ СУММА · {currency}</Text><DecimalInput value={target} onChange={setTarget} placeholder="0,00" /><Text style={s.fieldLabel}>СРОК ДОСТИЖЕНИЯ</Text><DateField value={deadline} onPress={() => setDateOpen(true)} /><Pressable style={s.primaryButton} onPress={submit}><Text style={s.primaryText}>Сохранить цель</Text></Pressable>{goal && <Pressable style={s.deleteButton} onPress={() => onDelete(goal)}><Ionicons name="trash-outline" size={18} color={C.red} /><Text style={s.deleteText}>Удалить цель</Text></Pressable>}
  </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateOpen} value={deadline} onClose={() => setDateOpen(false)} onSelect={setDeadline} /></SafeAreaView></Modal>;
}

function DebtEditor({ visible, debt, history, accounts, currencySettings, onClose, onCreate, onUpdate, onPayment, onReversePayment, onExtend, onOverdue }: {
  visible: boolean; debt: Debt | null; history: DebtHistory[]; accounts: Account[]; currencySettings: CurrencySettings; onClose: () => void;
  onCreate: (input: DebtInput) => Promise<void>; onUpdate: (input: DebtInput) => Promise<void>;
  onPayment: (amount: number, date: string, accountId?: string, exchangeRate?: number, note?: string) => Promise<void>;
  onReversePayment: (event: DebtHistory, fallbackAccountId?: string) => void;
  onExtend: (date: string, note?: string) => Promise<void>; onOverdue: () => Promise<void>;
}) {
  const today = localToday();
  const [person, setPerson] = useState(''); const [title, setTitle] = useState('');
  const [direction, setDirection] = useState<DebtDirection>('owed_to_me');
  const [amount, setAmount] = useState<number | undefined>(); const [currency, setCurrency] = useState('UZS');
  const [accountId, setAccountId] = useState<string | undefined>(); const [startDate, setStartDate] = useState(today);
  const [dueDate, setDueDate] = useState(today); const [note, setNote] = useState('');
  const [paymentAmount, setPaymentAmount] = useState<number | undefined>(); const [paymentDate, setPaymentDate] = useState(today);
  const [paymentAccountId, setPaymentAccountId] = useState<string | undefined>();
  const [paymentExchangeRate, setPaymentExchangeRate] = useState<number | undefined>(); const [payingSubmitting, setPayingSubmitting] = useState(false);
  const [newDueDate, setNewDueDate] = useState(''); const [actionNote, setActionNote] = useState(''); const [saving, setSaving] = useState(false); const [editingDetails, setEditingDetails] = useState(false);
  const [dateTarget, setDateTarget] = useState<'start' | 'due' | 'payment' | 'extension' | null>(null);
  useEffect(() => {
    if (!visible) return;
    setPerson(debt?.person ?? ''); setTitle(debt?.title ?? ''); setDirection(debt?.direction ?? 'owed_to_me'); setAmount(debt?.originalAmount);
    setCurrency(debt?.currency ?? accounts[0]?.currency ?? 'UZS'); setAccountId(debt?.accountId ?? accounts[0]?.id); setStartDate(debt?.startDate ?? today); setDueDate(debt?.dueDate ?? today); setNote(debt?.note ?? ''); setEditingDetails(false);
    setPaymentAmount(undefined); setPaymentDate(today); setPaymentAccountId(debt?.accountId ?? accounts[0]?.id); setPaymentExchangeRate(undefined); setPayingSubmitting(false); setNewDueDate(debt?.dueDate ?? ''); setActionNote('');
  }, [visible, debt]);
  const paymentAccount = accounts.find((item) => item.id === paymentAccountId);
  const paymentSourceRate = debt && debt.currency === currencySettings.baseCurrency ? 1 : debt ? currencySettings.rates[debt.currency] : undefined;
  const paymentTargetRate = paymentAccount?.currency === currencySettings.baseCurrency ? 1 : paymentAccount ? currencySettings.rates[paymentAccount.currency] : undefined;
  const automaticPaymentRate = debt && paymentAccount && paymentAccount.currency !== debt.currency && paymentSourceRate && paymentTargetRate ? paymentSourceRate / paymentTargetRate : undefined;
  const effectivePaymentRate = !debt || !paymentAccount ? undefined : paymentAccount.currency === debt.currency ? 1 : paymentExchangeRate ?? automaticPaymentRate;
  const submitPayment = async () => {
    if (!debt || !paymentAmount) return;
    setPayingSubmitting(true);
    try { await onPayment(paymentAmount, paymentDate, paymentAccountId, paymentAccountId ? paymentExchangeRate ?? automaticPaymentRate : undefined, actionNote || undefined); }
    finally { setPayingSubmitting(false); }
  };
  const chooseAccount = (account?: Account) => setAccountId(account?.id);
  const create = async () => {
    if (!person.trim() || !title.trim()) { Alert.alert('Укажите человека и название долга'); return; }
    if (!amount || amount <= 0) { Alert.alert('Укажите сумму долга'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) { Alert.alert('Проверьте даты в формате ГГГГ-ММ-ДД'); return; }
    setSaving(true); try { await onCreate({ person: person.trim(), title: title.trim(), direction, originalAmount: amount, currency, accountId, startDate, dueDate, note: note.trim() || undefined }); } finally { setSaving(false); }
  };
  const saveDetails = async () => {
    if (!person.trim() || !title.trim() || !amount || amount <= 0) { Alert.alert('Заполните человека, название и сумму'); return; }
    setSaving(true); try { await onUpdate({ person: person.trim(), title: title.trim(), direction, originalAmount: amount, currency, accountId, startDate, dueDate, note: note.trim() || undefined }); setEditingDetails(false); } finally { setSaving(false); }
  };
  const reversedHistoryIds = new Set(history.filter((event) => event.type === 'payment_reversed' && event.relatedHistoryId).map((event) => event.relatedHistoryId));
  const historyRows = history.map((event, index) => <View key={event.id} style={[s.historyRow, index > 0 && s.budgetBorder]}><View style={{ flex: 1 }}><Text style={s.rowTitle}>{debtHistoryLabel(event)}</Text><Text style={s.rowSub}>{event.occurredAt.slice(0, 10)}{event.fromDate && event.toDate ? ` · ${event.fromDate} → ${event.toDate}` : ''}{event.note ? ` · ${event.note}` : ''}</Text>{(event.type === 'payment' || event.type === 'early_payment') && !reversedHistoryIds.has(event.id) && <Pressable onPress={() => onReversePayment(event, paymentAccountId)}><Text style={[s.link, { marginTop: 6 }]}>Отменить ошибочное погашение</Text></Pressable>}</View>{event.amount !== undefined && <Text style={[s.budgetAmount, event.type === 'payment_reversed' && { color: C.red }]}>{event.type === 'payment_reversed' ? '↩ ' : ''}{money(event.amount, false, debt?.currency ?? currency)}</Text>}</View>);
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}>
    <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{debt ? 'Долг и история' : 'Новый долг'}</Text><View style={{ width: 40 }} /></View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      {!debt ? <>
        <Text style={s.fieldLabel}>НАПРАВЛЕНИЕ</Text><View style={s.choiceRow}><Pressable style={[s.choice, direction === 'owed_to_me' && s.choiceActive]} onPress={() => setDirection('owed_to_me')}><Text style={[s.choiceText, direction === 'owed_to_me' && s.choiceTextActive]}>Мне должны</Text></Pressable><Pressable style={[s.choice, direction === 'i_owe' && s.choiceActive]} onPress={() => setDirection('i_owe')}><Text style={[s.choiceText, direction === 'i_owe' && s.choiceTextActive]}>Я должна</Text></Pressable></View>
        <Text style={s.fieldLabel}>КТО</Text><TextInput value={person} onChangeText={setPerson} placeholder="Имя или организация" placeholderTextColor="#9BA9AF" style={s.input} />
        <Text style={s.fieldLabel}>ЗА ЧТО / НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} placeholder="Например, заём" placeholderTextColor="#9BA9AF" style={s.input} />
        <Text style={s.fieldLabel}>СУММА</Text><DecimalInput value={amount} onChange={setAmount} placeholder="0,00" />
        <Text style={s.fieldLabel}>ВАЛЮТА ДОЛГА</Text><CurrencyPicker value={currency} onChange={setCurrency} />
        <Text style={s.fieldLabel}>СЧЁТ ДЛЯ ПОГАШЕНИЙ</Text><View style={s.targetList}>{accounts.map((account) => <Pressable key={account.id} style={[s.targetAccount, accountId === account.id && s.targetAccountActive]} onPress={() => chooseAccount(account)}><Text style={s.targetAccountText}>{account.name} · {account.currency}</Text></Pressable>)}<Pressable style={[s.targetAccount, !accountId && s.targetAccountActive]} onPress={() => chooseAccount(undefined)}><Text style={s.targetAccountText}>Без привязки к счёту</Text></Pressable></View>
        {accountId && accounts.find((account) => account.id === accountId)?.currency !== currency && <Text style={s.helperText}>Валюта долга отличается от валюты счёта. При погашении будет нужен курс пересчёта.</Text>}
        <View style={s.twoColumns}><View style={{ flex: 1 }}><Text style={s.fieldLabel}>ДАТА НАЧАЛА</Text><DateField value={startDate} onPress={() => setDateTarget('start')} /></View><View style={{ flex: 1 }}><Text style={s.fieldLabel}>СРОК ПОГАШЕНИЯ</Text><DateField value={dueDate} onPress={() => setDateTarget('due')} /></View></View>
        <Text style={s.fieldLabel}>КОММЕНТАРИЙ</Text><TextInput value={note} onChangeText={setNote} placeholder="Необязательно" placeholderTextColor="#9BA9AF" style={s.input} />
        <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={create}><Text style={s.primaryText}>Добавить долг</Text></Pressable>
      </> : <>
        <View style={[s.totalLine, debt.status === 'overdue' && { backgroundColor: '#873A35' }]}><Text style={s.totalLabel}>{debt.direction === 'owed_to_me' ? 'МНЕ ДОЛЖНЫ' : 'Я ДОЛЖНА'} · {debtStatusLabel(debt)}</Text><Text style={s.totalAmount}>{money(debt.currentBalance, false, debt.currency)}</Text><Text style={s.heroOtherCurrency}>{debt.person} · {debt.title}</Text></View>
        <Pressable style={s.secondaryAction} onPress={() => setEditingDetails((value) => !value)}><Ionicons name="create-outline" size={18} color={C.blue} /><Text style={s.manualAccountText}>{editingDetails ? 'Закрыть редактирование' : 'Редактировать условия'}</Text></Pressable>
        {editingDetails && <View style={s.editDebtBox}><Text style={s.fieldLabel}>НАПРАВЛЕНИЕ</Text><View style={s.choiceRow}><Pressable style={[s.choice, direction === 'owed_to_me' && s.choiceActive]} onPress={() => setDirection('owed_to_me')}><Text style={[s.choiceText, direction === 'owed_to_me' && s.choiceTextActive]}>Мне должны</Text></Pressable><Pressable style={[s.choice, direction === 'i_owe' && s.choiceActive]} onPress={() => setDirection('i_owe')}><Text style={[s.choiceText, direction === 'i_owe' && s.choiceTextActive]}>Я должна</Text></Pressable></View><Text style={s.fieldLabel}>КТО</Text><TextInput value={person} onChangeText={setPerson} style={s.input} /><Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} style={s.input} /><Text style={s.fieldLabel}>ПЕРВОНАЧАЛЬНАЯ СУММА</Text><DecimalInput value={amount} onChange={setAmount} /><Text style={s.fieldLabel}>ВАЛЮТА</Text><CurrencyPicker value={currency} onChange={setCurrency} /><Text style={s.fieldLabel}>СЧЁТ</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, accountId === item.id && s.targetAccountActive]} onPress={() => chooseAccount(item)}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text></Pressable>)}</View><View style={s.twoColumns}><View style={{ flex: 1 }}><Text style={s.fieldLabel}>НАЧАЛО</Text><DateField value={startDate} onPress={() => setDateTarget('start')} /></View><View style={{ flex: 1 }}><Text style={s.fieldLabel}>СРОК</Text><DateField value={dueDate} onPress={() => setDateTarget('due')} /></View></View><Text style={s.fieldLabel}>КОММЕНТАРИЙ</Text><TextInput value={note} onChangeText={setNote} style={s.input} /><Pressable style={s.primaryButton} disabled={saving} onPress={saveDetails}><Text style={s.primaryText}>Сохранить условия</Text></Pressable></View>}
        {debt.status !== 'paid' && <><Text style={s.fieldLabel}>ПОГАШЕНИЕ</Text><Text style={s.helperText}>Введите именно сумму платежа. Остаток долга изменится автоматически.</Text><DecimalInput value={paymentAmount} onChange={setPaymentAmount} placeholder="Сумма платежа" /><View style={{ marginTop: 8 }}><DateField value={paymentDate} onPress={() => setDateTarget('payment')} /></View><Text style={s.fieldLabel}>{debt.direction === 'owed_to_me' ? 'СЧЁТ ЗАЧИСЛЕНИЯ' : 'СЧЁТ СПИСАНИЯ'}</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, paymentAccountId === item.id && s.targetAccountActive]} onPress={() => { setPaymentAccountId(item.id); setPaymentExchangeRate(undefined); }}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}<Pressable style={[s.targetAccount, !paymentAccountId && s.targetAccountActive]} onPress={() => { setPaymentAccountId(undefined); setPaymentExchangeRate(undefined); }}><Text style={s.targetAccountText}>Не менять баланс счёта</Text></Pressable></View>
        {paymentAccount && paymentAccount.currency !== debt.currency && <><Text style={s.fieldLabel}>КУРС · 1 {debt.currency} В {paymentAccount.currency}</Text><DecimalInput value={paymentExchangeRate} onChange={setPaymentExchangeRate} placeholder={automaticPaymentRate ? `Автоматически: ${automaticPaymentRate.toFixed(6)}` : 'Введите курс'} /><Text style={s.helperText}>{paymentExchangeRate ? 'Используется указанный вручную курс.' : automaticPaymentRate ? `Будет использован сохранённый курс: 1 ${debt.currency} = ${automaticPaymentRate.toFixed(6)} ${paymentAccount.currency}.` : 'Для пересчёта нужен курс — введите вручную.'}</Text></>}
        {paymentAccount && !!paymentAmount && <Text style={s.helperText}>{effectivePaymentRate ? `Баланс «${paymentAccount.name}»: ${money(paymentAccount.balance, false, paymentAccount.currency)} → ${money(paymentAccount.balance + (debt.direction === 'owed_to_me' ? 1 : -1) * paymentAmount * effectivePaymentRate, false, paymentAccount.currency)}` : 'Нет курса для пересчёта баланса счёта.'}</Text>}
        <Pressable style={[s.primaryButton, (payingSubmitting || !!(paymentAccountId && paymentAccount && paymentAccount.currency !== debt.currency && !effectivePaymentRate)) && { opacity: .6 }]} disabled={payingSubmitting || !!(paymentAccountId && paymentAccount && paymentAccount.currency !== debt.currency && !effectivePaymentRate)} onPress={submitPayment}><Text style={s.primaryText}>{payingSubmitting ? 'Сохраняем…' : paymentAmount && paymentAmount < debt.currentBalance ? 'Записать частичное погашение' : 'Записать погашение'}</Text></Pressable>
        <Text style={s.fieldLabel}>ПРОЛОНГАЦИЯ</Text><DateField value={newDueDate} onPress={() => setDateTarget('extension')} placeholder="Выбрать новый срок" /><TextInput value={actionNote} onChangeText={setActionNote} placeholder="Причина или комментарий" placeholderTextColor="#9BA9AF" style={[s.input, { marginTop: 8 }]} /><Pressable style={s.secondaryAction} onPress={() => onExtend(newDueDate, actionNote || undefined)}><Ionicons name="calendar-outline" size={18} color={C.blue} /><Text style={s.manualAccountText}>Пролонгировать</Text></Pressable>
        {debt.status === 'active' && <Pressable style={s.overdueButton} onPress={onOverdue}><Ionicons name="alert-circle-outline" size={18} color={C.red} /><Text style={s.deleteText}>Отметить просроченным</Text></Pressable>}</>}
        {debt.status === 'paid' && <><Text style={s.fieldLabel}>СЧЁТ ДЛЯ ИСПРАВЛЕНИЯ СТАРОГО ПОГАШЕНИЯ</Text><Text style={s.helperText}>Для новых погашений Афина помнит исходный счёт автоматически. Здесь можно выбрать счёт для записей из старых версий.</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, paymentAccountId === item.id && s.targetAccountActive]} onPress={() => setPaymentAccountId(item.id)}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text></Pressable>)}<Pressable style={[s.targetAccount, !paymentAccountId && s.targetAccountActive]} onPress={() => setPaymentAccountId(undefined)}><Text style={s.targetAccountText}>Исправить только остаток долга</Text></Pressable></View></>}
        <SectionTitle title="История" />{historyRows.length ? <View style={s.card}>{historyRows}</View> : <View style={s.emptyCard}><Text style={s.emptyText}>История пока пуста</Text></View>}
      </>}
    </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateTarget !== null} value={dateTarget === 'start' ? startDate : dateTarget === 'due' ? dueDate : dateTarget === 'payment' ? paymentDate : newDueDate} onClose={() => setDateTarget(null)} onSelect={(value) => { if (dateTarget === 'start') setStartDate(value); else if (dateTarget === 'due') setDueDate(value); else if (dateTarget === 'payment') setPaymentDate(value); else setNewDueDate(value); }} />
  </SafeAreaView></Modal>;
}

function CurrencySettingsEditor({ visible, currencies, settings, onClose, onSave }: { visible: boolean; currencies: string[]; settings: CurrencySettings; onClose: () => void; onSave: (settings: CurrencySettings) => Promise<void> }) {
  const [draft, setDraft] = useState(settings); const [saving, setSaving] = useState(false); const [updating, setUpdating] = useState(false);
  useEffect(() => { if (visible) setDraft(settings); }, [visible, settings]);
  const allCurrencies = Array.from(new Set([draft.baseCurrency, ...currencies, ...commonCurrencies])).sort();
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}>
    <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Объединение валют</Text><View style={{ width: 40 }} /></View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets><View style={s.privacy}><Ionicons name="information-circle-outline" size={18} color={C.green} /><Text style={s.privacyText}>Выберите валюту общего итога. Курсы можно получить из Центрального банка Узбекистана или исправить вручную.</Text></View>
      <Pressable style={s.planExpenseButton} disabled={updating} onPress={async () => { setUpdating(true); try { const fresh = await fetchOfficialCurrencyRates(draft.baseCurrency); setDraft({ ...fresh, autoUpdate: draft.autoUpdate !== false }); Alert.alert('Курсы обновлены', 'Получены официальные курсы Центрального банка Узбекистана. Нажмите «Сохранить».'); } catch { Alert.alert('Не удалось обновить курсы', 'Проверьте интернет. Последние сохранённые курсы продолжат работать.'); } finally { setUpdating(false); } }}>{updating ? <ActivityIndicator color="white" /> : <Ionicons name="cloud-download-outline" size={19} color="white" />}<Text style={s.importAccountText}>{updating ? 'Получаем курсы…' : 'Обновить из ЦБ Узбекистана'}</Text></Pressable>
      <Text style={s.helperText}>{draft.source === 'cbu' ? 'Источник: Центральный банк Узбекистана' : 'Источник: ручные курсы'}{draft.lastUpdated ? ` · ${draft.lastUpdated.slice(0, 10)}` : ''}</Text>
      <Text style={s.fieldLabel}>АВТООБНОВЛЕНИЕ РАЗ В ДЕНЬ</Text><View style={s.choiceRow}><Pressable style={[s.choice, draft.autoUpdate !== false && s.choiceActive]} onPress={() => setDraft((current) => ({ ...current, autoUpdate: true }))}><Text style={[s.choiceText, draft.autoUpdate !== false && s.choiceTextActive]}>Включено</Text></Pressable><Pressable style={[s.choice, draft.autoUpdate === false && s.choiceActive]} onPress={() => setDraft((current) => ({ ...current, autoUpdate: false }))}><Text style={[s.choiceText, draft.autoUpdate === false && s.choiceTextActive]}>Выключено</Text></Pressable></View>
      <Text style={s.fieldLabel}>БАЗОВАЯ ВАЛЮТА</Text><View style={s.currencyGrid}>{allCurrencies.map((currency) => <Pressable key={currency} style={[s.currencyChip, currency === draft.baseCurrency && s.currencyChipActive]} onPress={() => setDraft((current) => rebaseRates(current, currency))}><Text style={[s.currencyChipText, currency === draft.baseCurrency && s.currencyActiveText]}>{currency}</Text></Pressable>)}</View>
      <Text style={s.fieldLabel}>КУРСЫ К {draft.baseCurrency}</Text>{allCurrencies.filter((currency) => currency !== draft.baseCurrency).map((currency) => <View key={currency} style={s.rateSettingRow}><View style={{ flex: 1 }}><Text style={s.rowTitle}>1 {currency}</Text><Text style={s.rowSub}>= единиц {draft.baseCurrency}</Text></View><DecimalInput value={draft.rates[currency]} onChange={(rate) => setDraft((current) => ({ ...current, source: 'manual', lastUpdated: undefined, rates: { ...current.rates, [currency]: rate ?? 0 } }))} placeholder="Курс" style={{ width: 145 }} /></View>)}
      <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={async () => { setSaving(true); try { await onSave(draft); } finally { setSaving(false); } }}><Text style={s.primaryText}>Сохранить валюту и курсы</Text></Pressable>
    </ScrollView></KeyboardAvoidingView>
  </SafeAreaView></Modal>;
}

function PlannedExpenseEditor({ visible, expense, initialDate, accounts, currencySettings, onClose, onSave, onDelete }: {
  visible: boolean; expense: PlannedExpense | null; initialDate?: string; accounts: Account[]; currencySettings: CurrencySettings; onClose: () => void;
  onSave: (input: PlannedExpenseInput) => Promise<void>; onDelete: (expense: PlannedExpense) => void;
}) {
  const [kind, setKind] = useState<CashFlowKind>('expense'); const [title, setTitle] = useState(''); const [category, setCategory] = useState('Другое');
  const [amount, setAmount] = useState<number | undefined>(); const [currency, setCurrency] = useState('UZS'); const [accountId, setAccountId] = useState<string | undefined>();
  const [exchangeRate, setExchangeRate] = useState<number | undefined>(); const [startDate, setStartDate] = useState(localToday()); const [endDate, setEndDate] = useState('');
  const [repeat, setRepeat] = useState<ExpenseRepeat>('once'); const [repeatInterval, setRepeatInterval] = useState<number | undefined>(1); const [repeatUnit, setRepeatUnit] = useState<RecurrenceUnit>('month');
  const [weekdays, setWeekdays] = useState<number[]>([]); const [sourceTransactionId, setSourceTransactionId] = useState<string | undefined>(); const [saving, setSaving] = useState(false); const [dateTarget, setDateTarget] = useState<'start' | 'end' | null>(null);
  useEffect(() => {
    if (!visible) return;
    setKind(expense?.kind ?? 'expense'); setTitle(expense?.title ?? ''); setCategory(expense?.category ?? 'Другое'); setAmount(expense?.amount);
    setCurrency(expense?.currency ?? accounts[0]?.currency ?? 'UZS'); setAccountId(expense?.accountId ?? accounts[0]?.id); setExchangeRate(expense?.exchangeRate);
    setStartDate(expense?.startDate ?? initialDate ?? localToday()); setEndDate(expense?.endDate ?? ''); setRepeat(expense?.repeat ?? 'once');
    setRepeatInterval(expense?.repeatInterval ?? 1); setRepeatUnit(expense?.repeatUnit ?? 'month'); setWeekdays(expense?.weekdays ?? []); setSourceTransactionId(expense?.sourceTransactionId);
  }, [visible, expense, initialDate]);
  const account = accounts.find((item) => item.id === accountId);
  const sourceRate = currency === currencySettings.baseCurrency ? 1 : currencySettings.rates[currency];
  const targetRate = account?.currency === currencySettings.baseCurrency ? 1 : account ? currencySettings.rates[account.currency] : undefined;
  const automaticRate = account && account.currency !== currency && sourceRate && targetRate ? sourceRate / targetRate : undefined;
  const choosePreset = (value: ExpenseRepeat) => { setRepeat(value); setRepeatInterval(1); if (value !== 'once' && value !== 'custom') setRepeatUnit(value === 'daily' ? 'day' : value === 'weekly' ? 'week' : value === 'monthly' ? 'month' : 'year'); };
  const submit = async () => {
    if (!title.trim() || !amount || amount <= 0) { Alert.alert('Укажите название и сумму'); return; }
    if (endDate && endDate < startDate) { Alert.alert('Дата окончания не может быть раньше даты начала'); return; }
    if (repeat === 'custom' && (!repeatInterval || repeatInterval < 1)) { Alert.alert('Укажите интервал повторения'); return; }
    if (account && account.currency !== currency && !exchangeRate && !automaticRate) { Alert.alert('Нет курса между валютами', 'Введите курс вручную или обновите курсы валют.'); return; }
    setSaving(true); try { await onSave({ title: title.trim(), category: category.trim() || 'Другое', amount, currency, accountId, startDate, endDate: repeat === 'once' ? undefined : endDate || undefined, repeat, kind, repeatInterval: repeat === 'once' ? undefined : repeatInterval ?? 1, repeatUnit: repeat === 'once' ? undefined : repeatUnit, weekdays: repeatUnit === 'week' ? weekdays : undefined, exchangeRate: account?.currency !== currency ? exchangeRate : undefined, sourceTransactionId }); } finally { setSaving(false); }
  };
  const presets: { value: ExpenseRepeat; label: string }[] = [{ value: 'once', label: 'Один раз' }, { value: 'daily', label: 'Ежедневно' }, { value: 'weekly', label: 'Еженедельно' }, { value: 'monthly', label: 'Ежемесячно' }, { value: 'yearly', label: 'Ежегодно' }, { value: 'custom', label: 'Настроить' }];
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}><SafeAreaView style={s.modal} edges={['top', 'bottom']}>
    <View style={s.modalHead}><Pressable onPress={onClose} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>{expense ? 'Изменить план' : 'Запланировать движение'}</Text><View style={{ width: 40 }} /></View>
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.formBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
      <Text style={s.fieldLabel}>ТИП</Text><View style={s.choiceRow}><Pressable style={[s.choice, kind === 'expense' && s.choiceActive]} onPress={() => setKind('expense')}><Text style={[s.choiceText, kind === 'expense' && s.choiceTextActive]}>Расход</Text></Pressable><Pressable style={[s.choice, kind === 'income' && s.choiceActive]} onPress={() => setKind('income')}><Text style={[s.choiceText, kind === 'income' && s.choiceTextActive]}>Доход</Text></Pressable></View>
      <Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={title} onChangeText={setTitle} placeholder={kind === 'income' ? 'Например, зарплата' : 'Например, аренда'} placeholderTextColor="#9BA9AF" style={s.input} />
      <Text style={s.fieldLabel}>КАТЕГОРИЯ</Text><TextInput value={category} onChangeText={setCategory} placeholder="Категория" placeholderTextColor="#9BA9AF" style={s.input} />
      <Text style={s.fieldLabel}>СУММА</Text><DecimalInput value={amount} onChange={setAmount} placeholder="0,00" />
      <Text style={s.fieldLabel}>ВАЛЮТА ДВИЖЕНИЯ</Text><CurrencyPicker value={currency} onChange={setCurrency} />
      <Text style={s.fieldLabel}>{kind === 'income' ? 'СЧЁТ ЗАЧИСЛЕНИЯ' : 'СЧЁТ СПИСАНИЯ'}</Text><View style={s.targetList}>{accounts.map((item) => <Pressable key={item.id} style={[s.targetAccount, accountId === item.id && s.targetAccountActive]} onPress={() => { setAccountId(item.id); setExchangeRate(undefined); }}><Text style={s.targetAccountText}>{item.name} · {item.currency}</Text><Text style={s.rowSub}>{money(item.balance, false, item.currency)}</Text></Pressable>)}<Pressable style={[s.targetAccount, !accountId && s.targetAccountActive]} onPress={() => setAccountId(undefined)}><Text style={s.targetAccountText}>Без привязки к счёту</Text></Pressable></View>
      {account && account.currency !== currency && <><Text style={s.fieldLabel}>КУРС · 1 {currency} В {account.currency}</Text><DecimalInput value={exchangeRate} onChange={setExchangeRate} placeholder={automaticRate ? `Автоматически: ${automaticRate.toFixed(6)}` : 'Введите курс'} /><Text style={s.helperText}>{exchangeRate ? 'Используется указанный вручную курс.' : automaticRate ? `Будет использован сохранённый курс: 1 ${currency} = ${automaticRate.toFixed(6)} ${account.currency}.` : 'Для пересчёта нужен курс.'}</Text></>}
      <Text style={s.fieldLabel}>ПЕРИОДИЧНОСТЬ</Text><View style={s.repeatGrid}>{presets.map((option) => <Pressable key={option.value} style={[s.repeatChoice, repeat === option.value && s.choiceActive]} onPress={() => choosePreset(option.value)}><Text style={[s.choiceText, repeat === option.value && s.choiceTextActive]}>{option.label}</Text></Pressable>)}</View>
      {repeat === 'custom' && <><Text style={s.fieldLabel}>ПОВТОРЯТЬ КАЖДЫЕ</Text><View style={s.twoColumns}><DecimalInput value={repeatInterval} onChange={setRepeatInterval} placeholder="1" style={{ flex: 1 }} /><View style={[s.choiceRow, { flex: 2 }]}>{(['day', 'week', 'month', 'year'] as RecurrenceUnit[]).map((unit) => <Pressable key={unit} style={[s.choice, repeatUnit === unit && s.choiceActive]} onPress={() => setRepeatUnit(unit)}><Text style={[s.choiceText, repeatUnit === unit && s.choiceTextActive]}>{unit === 'day' ? 'дней' : unit === 'week' ? 'недель' : unit === 'month' ? 'месяцев' : 'лет'}</Text></Pressable>)}</View></View></>}
      {repeat !== 'once' && repeatUnit === 'week' && <><Text style={s.fieldLabel}>ДНИ НЕДЕЛИ</Text><View style={s.weekdayRow}>{['Пн','Вт','Ср','Чт','Пт','Сб','Вс'].map((label, index) => { const day = index + 1; const active = weekdays.includes(day); return <Pressable key={label} style={[s.weekday, active && s.choiceActive]} onPress={() => setWeekdays((current) => active ? current.filter((item) => item !== day) : [...current, day])}><Text style={[s.choiceText, active && s.choiceTextActive]}>{label}</Text></Pressable>; })}</View></>}
      <Text style={s.fieldLabel}>{repeat === 'once' ? 'ДАТА' : 'ДАТА ПЕРВОГО ДВИЖЕНИЯ'}</Text><DateField value={startDate} onPress={() => setDateTarget('start')} />
      {repeat !== 'once' && <><Text style={s.fieldLabel}>ПОВТОРЯТЬ ДО</Text><DateField value={endDate} onPress={() => setDateTarget('end')} placeholder="Без даты окончания" />{endDate && <Pressable onPress={() => setEndDate('')}><Text style={s.link}>Очистить дату окончания</Text></Pressable>}</>}
      <Pressable style={[s.primaryButton, saving && { opacity: .6 }]} disabled={saving} onPress={submit}><Text style={s.primaryText}>{saving ? 'Сохраняем…' : 'Сохранить план'}</Text></Pressable>
      {expense && <Pressable style={s.deleteButton} onPress={() => onDelete(expense)}><Ionicons name="trash-outline" size={18} color={C.red} /><Text style={s.deleteText}>Удалить план</Text></Pressable>}
    </ScrollView></KeyboardAvoidingView><DatePickerModal visible={dateTarget !== null} value={dateTarget === 'end' ? endDate : startDate} onClose={() => setDateTarget(null)} onSelect={(value) => dateTarget === 'end' ? setEndDate(value) : setStartDate(value)} />
  </SafeAreaView></Modal>;
}

function LegacyImportModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const choose = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    if (!result.canceled) { setImageUri(result.assets[0]?.uri ?? null); setConfirmed(false); }
  };
  const close = () => { setImageUri(null); setConfirmed(false); onClose(); };
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView style={s.modal} edges={['top', 'bottom']}>
      <View style={s.modalHead}><Pressable onPress={close} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Импорт скриншота</Text><View style={{ width: 40 }} /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.modalBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
        {!imageUri ? <>
          <View style={s.uploadHero}><View style={s.scanLarge}><Ionicons name="scan" size={34} color={C.navy} /></View><Text style={s.uploadTitle}>Загрузите скриншот банка</Text><Text style={s.uploadText}>Афина распознает баланс, операции, даты и категории. Вам останется только проверить результат.</Text></View>
          <Pressable style={s.primaryButton} onPress={choose}><Ionicons name="images-outline" size={20} color="white" /><Text style={s.primaryText}>Выбрать из галереи</Text></Pressable>
          <View style={s.privacy}><Ionicons name="lock-closed-outline" size={17} color={C.green} /><Text style={s.privacyText}>Изображение используется только для распознавания финансовых данных.</Text></View>
        </> : confirmed ? <View style={s.success}><View style={s.successIcon}><Ionicons name="checkmark" size={38} color="white" /></View><Text style={s.uploadTitle}>Данные добавлены</Text><Text style={s.uploadText}>Баланс обновлён, 3 новые операции учтены в календаре и аналитике.</Text><Pressable style={s.primaryButton} onPress={close}><Text style={s.primaryText}>Готово</Text></Pressable></View> : <>
          <Image source={{ uri: imageUri }} style={{ width: '100%', height: 180, borderRadius: 18, backgroundColor: '#DDD' }} resizeMode="cover" />
          <View style={s.recognitionHead}><View><Text style={s.sectionTitle}>Распознано</Text><Text style={s.rowSub}>Проверьте данные перед добавлением</Text></View><View style={s.confidence}><Text style={s.confidenceText}>96% точно</Text></View></View>
          <View style={s.card}>
            <View style={s.detectRow}><Text style={s.detectLabel}>Счёт</Text><Text style={s.detectValue}>Основная карта • 4821</Text></View>
            <View style={s.divider} /><View style={s.detectRow}><Text style={s.detectLabel}>Баланс</Text><Text style={s.detectValue}>8 450 000 сум</Text></View>
          </View>
          <Text style={[s.sectionTitle, { marginTop: 22, marginBottom: 10 }]}>Новые операции · 3</Text>
          <View style={s.card}>{transactions.slice(1, 4).map((t, i) => <View key={t.id} style={[s.detectTx, i > 0 && s.budgetBorder]}><View style={{ flex: 1 }}><Text style={s.rowTitle}>{t.title}</Text><Text style={s.rowSub}>{t.category} · {t.date}</Text></View><Text style={t.kind === 'income' ? s.income : s.expense}>{t.kind === 'income' ? '+' : '−'}{money(t.amount)}</Text></View>)}</View>
          <Pressable style={s.primaryButton} onPress={() => setConfirmed(true)}><Text style={s.primaryText}>Подтвердить и добавить</Text></Pressable>
          <Pressable style={s.secondaryButton} onPress={choose}><Text style={s.secondaryText}>Выбрать другой скриншот</Text></Pressable>
        </>}
      </ScrollView></KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function ImportModal({ visible, onClose, accounts, onAccountSaved }: { visible: boolean; onClose: () => void; accounts: Account[]; onAccountSaved: (input: AccountInput) => Promise<void> }) {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [detected, setDetected] = useState<DetectedAccount | null>(null);
  const [scanning, setScanning] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingDetected, setEditingDetected] = useState(false);

  const choose = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets[0]?.uri) return;
    const uri = result.assets[0].uri;
    setImageUri(uri); setDetected(null); setError(null); setConfirmed(false); setEditingDetected(false); setScanning(true);
    try {
      const value = await recognizeAccountScreenshot(uri);
      setDetected(value);
      if (value.account.type === 'deposit' || value.account.type === 'savings') setEditingDetected(true);
      if (!value.account.balance) setError('Баланс не найден. Попробуйте скриншот главного экрана счёта, где одновременно видны сумма и валюта.');
    } catch (cause) {
      const message = String(cause);
      setError(/linked|managed workflow|NativeModules/i.test(message)
        ? 'Локальное распознавание работает в установленной APK-версии Афины. В Expo Go этот модуль недоступен.'
        : 'Не удалось прочитать этот скриншот. Попробуйте другое изображение.');
    } finally { setScanning(false); }
  };

  const confirm = async () => {
    if (!detected || !detected.account.balance) return;
    if (!/^[A-Z]{3}$/.test(detected.account.currency)) { Alert.alert('Проверьте код валюты'); return; }
    if (detected.account.type === 'deposit' && !detected.account.maturityDate) { Alert.alert('Укажите дату окончания вклада'); setEditingDetected(true); return; }
    await onAccountSaved(detected.account);
    setConfirmed(true);
  };
  const updateDetectedAccount = (patch: Partial<AccountInput>) => {
    setDetected((current) => current ? { ...current, account: { ...current.account, ...patch } } : current);
  };
  const changeDetectedType = (nextType: AccountType) => {
    if (!detected) return;
    const option = accountTypeOptions.find((item) => item.type === nextType);
    if (!option) return;
    const labels: Record<AccountType, string> = { card: 'Банковская карта', credit_card: 'Кредитная карта', savings: 'Накопительный счёт', deposit: 'Вклад', cash: 'Наличные' };
    const name = detected.account.name.replace(/^(Банковская карта|Накопительный счёт|Вклад|Наличные)/, labels[nextType]);
    updateDetectedAccount({ type: nextType, name, accent: option.accent, rate: nextType === 'cash' ? undefined : detected.account.rate });
  };
  const close = () => { setImageUri(null); setDetected(null); setError(null); setConfirmed(false); setEditingDetected(false); setScanning(false); onClose(); };
  const typeLabel = detected?.account.type === 'deposit' ? 'Вклад' : detected?.account.type === 'savings' ? 'Накопительный счёт' : 'Банковская карта';

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
    <SafeAreaView style={s.modal} edges={['top', 'bottom']}>
      <View style={s.modalHead}><Pressable onPress={close} style={s.close}><Ionicons name="close" size={22} color={C.ink} /></Pressable><Text style={s.modalTitle}>Счёт со скриншота</Text><View style={{ width: 40 }} /></View>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}><ScrollView contentContainerStyle={s.modalBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" automaticallyAdjustKeyboardInsets>
        {!imageUri ? <>
          <View style={s.uploadHero}><View style={s.scanLarge}><Ionicons name="scan" size={34} color={C.navy} /></View><Text style={s.uploadTitle}>Загрузите скриншот банка</Text><Text style={s.uploadText}>Афина локально распознает тип счёта, банк, баланс, валюту и процентную ставку.</Text></View>
          <Pressable style={s.primaryButton} onPress={choose}><Ionicons name="images-outline" size={20} color="white" /><Text style={s.primaryText}>Выбрать из галереи</Text></Pressable>
          <View style={s.privacy}><Ionicons name="phone-portrait-outline" size={17} color={C.green} /><Text style={s.privacyText}>Распознавание выполняется на телефоне. Скриншот не отправляется на внешний сервер.</Text></View>
        </> : confirmed ? <View style={s.success}><View style={s.successIcon}><Ionicons name="checkmark" size={38} color="white" /></View><Text style={s.uploadTitle}>Счёт добавлен</Text><Text style={s.uploadText}>Баланс сохранён в локальной базе и уже учтён на главном экране.</Text><Pressable style={s.primaryButton} onPress={close}><Text style={s.primaryText}>Готово</Text></Pressable></View> : <>
          <Image source={{ uri: imageUri }} style={{ width: '100%', height: 180, borderRadius: 18, backgroundColor: '#DCEBF1' }} resizeMode="cover" />
          {scanning && <View style={s.scanningBox}><ActivityIndicator size="large" color={C.blue} /><Text style={s.uploadText}>Распознаём данные…</Text></View>}
          {error && !scanning && <View style={s.ocrError}><Ionicons name="information-circle-outline" size={21} color={C.red} /><Text style={s.ocrErrorText}>{error}</Text></View>}
          {detected && !scanning && <>
            <View style={s.recognitionHead}><View><Text style={s.sectionTitle}>Распознано</Text><Text style={s.rowSub}>Проверьте перед сохранением · OCR v3</Text></View>{!editingDetected && <Pressable style={s.editDetectedButton} onPress={() => setEditingDetected(true)}><Ionicons name="pencil-outline" size={14} color={C.blue} /><Text style={s.editDetectedText}>Изменить</Text></Pressable>}</View>
            {editingDetected ? <View style={s.reviewForm}>
              <Text style={s.fieldLabel}>ТИП СЧЁТА</Text>
              <View style={s.typeGrid}>{accountTypeOptions.map((option) => <Pressable key={option.type} style={[s.typeOption, detected.account.type === option.type && s.typeOptionActive]} onPress={() => changeDetectedType(option.type)}><Ionicons name={iconForType[option.type]} size={19} color={detected.account.type === option.type ? C.navy : C.muted} /><Text style={[s.typeLabel, detected.account.type === option.type && s.typeLabelActive]}>{option.label}</Text></Pressable>)}</View>
              <Text style={s.fieldLabel}>НАЗВАНИЕ</Text><TextInput value={detected.account.name} onChangeText={(name) => updateDetectedAccount({ name })} style={s.input} />
              <Text style={s.fieldLabel}>БАНК ИЛИ ОПИСАНИЕ</Text><TextInput value={detected.account.subtitle} onChangeText={(subtitle) => updateDetectedAccount({ subtitle })} style={s.input} />
              <Text style={s.fieldLabel}>БАЛАНС</Text><DecimalInput value={detected.account.balance} onChange={(balance) => updateDetectedAccount({ balance: balance ?? 0 })} placeholder="0,00" />
              <Text style={s.fieldLabel}>ВАЛЮТА</Text><CurrencyPicker value={detected.account.currency} onChange={(currency) => updateDetectedAccount({ currency, destinationAccountId: undefined })} />
              {(detected.account.type === 'deposit' || detected.account.type === 'savings') && <><Text style={s.fieldLabel}>СТАВКА, % ГОДОВЫХ</Text><DecimalInput value={detected.account.rate} onChange={(rate) => updateDetectedAccount({ rate })} placeholder="Необязательно" /><Text style={s.fieldLabel}>НАЛОГ НА ПРОЦЕНТЫ, % (ЕСЛИ БАНК УДЕРЖИВАЕТ)</Text><DecimalInput value={detected.account.taxRate} onChange={(taxRate) => updateDetectedAccount({ taxRate })} placeholder="Необязательно" /><InterestSettings startDate={detected.account.startDate} maturityDate={detected.account.maturityDate} nextInterestDate={detected.account.nextInterestDate} schedule={detected.account.interestSchedule} destination={detected.account.interestDestination} destinationAccountId={detected.account.destinationAccountId} autoRenewal={detected.account.autoRenewal} rateReviewReminder={detected.account.rateReviewReminder} withdrawalPolicy={detected.account.withdrawalPolicy} minimumBalance={detected.account.minimumBalance} replenishmentAllowed={detected.account.replenishmentAllowed} currency={detected.account.currency} accounts={accounts} onChange={updateDetectedAccount} /></>}
              <Pressable style={s.reviewDoneButton} onPress={() => setEditingDetected(false)}><Ionicons name="checkmark" size={17} color={C.blue} /><Text style={s.reviewDoneText}>Готово</Text></Pressable>
            </View> : <View style={s.card}>
              <View style={s.detectRow}><Text style={s.detectLabel}>Тип</Text><Text style={s.detectValue}>{typeLabel}</Text></View><View style={s.divider} />
              <View style={s.detectRow}><Text style={s.detectLabel}>Счёт</Text><Text style={s.detectValue}>{detected.account.subtitle}</Text></View><View style={s.divider} />
              <View style={s.detectRow}><Text style={s.detectLabel}>Баланс</Text><Text style={s.detectValue}>{money(detected.account.balance, false, detected.account.currency)}</Text></View>
              {detected.account.rate && <><View style={s.divider} /><View style={s.detectRow}><Text style={s.detectLabel}>Ставка</Text><Text style={s.detectValue}>{detected.account.rate}% годовых</Text></View></>}
              {detected.account.interestSchedule && <><View style={s.divider} /><View style={s.detectRow}><Text style={s.detectLabel}>Выплата</Text><Text style={s.detectValue}>{scheduleLabel(detected.account.interestSchedule)}</Text></View></>}
            </View>}
            <Pressable style={[s.primaryButton, !detected.account.balance && { opacity: .45 }]} disabled={!detected.account.balance} onPress={confirm}><Text style={s.primaryText}>Подтвердить и добавить</Text></Pressable>
          </>}
          {!scanning && <Pressable style={s.secondaryButton} onPress={choose}><Text style={s.secondaryText}>Выбрать другой скриншот</Text></Pressable>}
        </>}
      </ScrollView></KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const tabs: { key: Tab; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'home', label: 'Обзор', icon: 'home-outline' }, { key: 'accounts', label: 'Счета', icon: 'wallet-outline' },
  { key: 'calendar', label: 'Календарь', icon: 'calendar-clear-outline' }, { key: 'operations', label: 'Операции', icon: 'receipt-outline' },
  { key: 'analytics', label: 'Аналитика', icon: 'pie-chart-outline' },
];

function AppContent({ userId, email }: { userId: string; email?: string }) {
  const [tab, setTab] = useState<Tab>('home');
  const [importOpen, setImportOpen] = useState(false);
  const [accountEditorOpen, setAccountEditorOpen] = useState(false);
  const [expenseEditorOpen, setExpenseEditorOpen] = useState(false);
  const [debtEditorOpen, setDebtEditorOpen] = useState(false);
  const [currencySettingsOpen, setCurrencySettingsOpen] = useState(false);
  const [operationEditorOpen, setOperationEditorOpen] = useState(false);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [budgetEditorOpen, setBudgetEditorOpen] = useState(false);
  const [goalEditorOpen, setGoalEditorOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [depositRateHistory, setDepositRateHistory] = useState<DepositRateHistory[]>([]);
  const [editingExpense, setEditingExpense] = useState<PlannedExpense | null>(null);
  const [newExpenseInitialDate, setNewExpenseInitialDate] = useState<string | undefined>();
  const [editingDebt, setEditingDebt] = useState<Debt | null>(null);
  const [editingBudget, setEditingBudget] = useState<Budget | null>(null);
  const [editingGoal, setEditingGoal] = useState<FinancialGoal | null>(null);
  const [executingOccurrence, setExecutingOccurrence] = useState<{ occurrence: PlannedOccurrence; flow: PlannedExpense } | null>(null);
  const [debtHistory, setDebtHistory] = useState<DebtHistory[]>([]);
  const [userAccounts, setUserAccounts] = useState<Account[]>([]);
  const [plannedExpenses, setPlannedExpenses] = useState<PlannedExpense[]>([]);
  const [debts, setDebts] = useState<Debt[]>([]);
  const [operations, setOperations] = useState<FinancialOperation[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [plannedOccurrences, setPlannedOccurrences] = useState<PlannedOccurrence[]>([]);
  const [userBudgets, setUserBudgets] = useState<Budget[]>([]);
  const [financialGoals, setFinancialGoals] = useState<FinancialGoal[]>([]);
  const [currencySettings, setCurrencySettings] = useState<CurrencySettings>({ baseCurrency: 'UZS', rates: { UZS: 1 }, autoUpdate: true });
  const [databaseReady, setDatabaseReady] = useState(false);
  const [pendingSmsDrafts, setPendingSmsDrafts] = useState(0);
  const [pendingAiProposals, setPendingAiProposals] = useState(0);
  const [aiAssistantOpen, setAiAssistantOpen] = useState(false);
  useEffect(() => { countPendingAiProposals().then(setPendingAiProposals); }, []);
  const refreshAiProposals = () => countPendingAiProposals().then(setPendingAiProposals);

  const reloadAccounts = async () => setUserAccounts(await listAccounts());
  const reloadExpenses = async () => setPlannedExpenses(await listPlannedExpenses());
  const reloadDebts = async () => {
    const next = await listDebts(); setDebts(next);
    setEditingDebt((current) => current ? next.find((item) => item.id === current.id) ?? current : null);
  };
  const reloadCurrencySettings = async () => setCurrencySettings(await getCurrencySettings());
  const reloadOperations = async () => setOperations(await listOperations());
  const reloadTransfers = async () => setTransfers(await listTransfers());
  const reloadPlannedOccurrences = async () => setPlannedOccurrences(await listPlannedOccurrences());
  const reloadBudgets = async () => setUserBudgets(await listBudgets());
  const reloadGoals = async () => setFinancialGoals(await listFinancialGoals());

  useEffect(() => {
    initializeDatabase().then(async () => {
      try {
        await initializeCloudData(userId);
      } catch (error) {
        const message = describeError(error);
        Alert.alert(
          'Облако временно недоступно',
          `Данные на телефоне сохранены. Афина повторит синхронизацию позже.${message ? `\n\n${message}` : ''}`,
        );
      }
      await synchronizeInterestPostings();
      await synchronizePlannedOccurrences();
      await Promise.all([reloadAccounts(), reloadExpenses(), reloadDebts(), reloadOperations(), reloadTransfers(), reloadPlannedOccurrences(), reloadBudgets(), reloadGoals()]);
      const stored = await getCurrencySettings(); setCurrencySettings(stored);
      const today = localToday();
      if (stored.autoUpdate !== false && stored.lastUpdated?.slice(0, 10) !== today) {
        try {
          const fresh = await fetchOfficialCurrencyRates(stored.baseCurrency);
          const next = { ...fresh, autoUpdate: true }; await saveCurrencySettings(next); setCurrencySettings(next);
        } catch { /* Офлайн: продолжаем использовать последний сохранённый курс. */ }
      }
      setDatabaseReady(true);
      scanSmsInbox().then(() => countPendingImportDrafts().then(setPendingSmsDrafts)).catch(() => { /* Permission not granted yet, or reader unavailable on this platform. */ });
    }).catch((error) => Alert.alert(
      'Не удалось открыть локальную базу',
      `Перезапустите приложение и попробуйте снова. Если не помогает — проверьте свободное место на устройстве.${describeError(error) ? `\n\n${describeError(error)}` : ''}`,
    ));
  }, [userId]);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && databaseReady) scanSmsInbox().then(() => countPendingImportDrafts().then(setPendingSmsDrafts)).catch(() => { /* Same as above. */ });
    });
    return () => subscription.remove();
  }, [databaseReady]);
  useEffect(() => {
    if (!databaseReady) return;
    const timer = setTimeout(() => {
      uploadLocalDataToCloud(userId).catch(() => { /* Offline changes remain queued in SQLite. */ });
    }, 1200);
    return () => clearTimeout(timer);
  }, [databaseReady, userId, userAccounts, plannedExpenses, debts, operations, transfers, plannedOccurrences, userBudgets, financialGoals, currencySettings]);
  useEffect(() => {
    let knownDate = localToday();
    const timer = setInterval(async () => {
      const currentDate = localToday();
      if (currentDate === knownDate) return;
      knownDate = currentDate;
      await synchronizeInterestPostings(currentDate);
      await synchronizePlannedOccurrences(currentDate);
      await Promise.all([reloadAccounts(), reloadOperations(), reloadDebts(), reloadPlannedOccurrences()]);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);

  const openNewAccount = () => { setEditingAccount(null); setDepositRateHistory([]); setAccountEditorOpen(true); };
  const openAccount = (account: Account) => { setEditingAccount(account); setAccountEditorOpen(true); listDepositRateHistory(account.id).then(setDepositRateHistory); };
  const openNewExpense = (date?: string) => { setEditingExpense(null); setNewExpenseInitialDate(date); setExpenseEditorOpen(true); };
  const openExpense = (expense: PlannedExpense) => { setEditingExpense(expense); setNewExpenseInitialDate(undefined); setExpenseEditorOpen(true); };
  const openNewDebt = () => { setEditingDebt(null); setDebtHistory([]); setDebtEditorOpen(true); };
  const openDebt = async (debt: Debt) => { setEditingDebt(debt); setDebtHistory(await listDebtHistory(debt.id)); setDebtEditorOpen(true); };
  const handleSaveAccount = async (input: AccountInput) => {
    await saveAccount(input, editingAccount?.id);
    await synchronizeInterestPostings();
    await Promise.all([reloadAccounts(), reloadOperations()]);
    setAccountEditorOpen(false);
  };
  const handleDeleteAccount = (account: Account) => {
    Alert.alert('Удалить счёт?', `Счёт «${account.name}» будет удалён с этого устройства.`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: async () => { await deleteAccount(account.id); await reloadAccounts(); setAccountEditorOpen(false); } },
    ]);
  };
  const handleSaveExpense = async (input: PlannedExpenseInput) => {
    await savePlannedExpense(input, editingExpense?.id);
    await reloadExpenses();
    setExpenseEditorOpen(false);
  };
  const handleDeleteExpense = (expense: PlannedExpense) => {
    Alert.alert('Удалить запланированный расход?', `«${expense.title}» больше не будет учитываться в календаре.`, [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: async () => { await deletePlannedExpense(expense.id); await Promise.all([reloadExpenses(), reloadPlannedOccurrences()]); setExpenseEditorOpen(false); } },
    ]);
  };
  const handleCreateDebt = async (input: DebtInput) => { await createDebt(input); await reloadDebts(); setDebtEditorOpen(false); };
  const handleUpdateDebt = async (input: DebtInput) => { if (!editingDebt) return; await updateDebt(editingDebt.id, input); await reloadDebts(); setDebtHistory(await listDebtHistory(editingDebt.id)); };
  const refreshOpenDebt = async () => {
    await Promise.all([reloadAccounts(), reloadDebts(), reloadOperations()]);
    if (editingDebt) setDebtHistory(await listDebtHistory(editingDebt.id));
  };
  const handleDebtPayment = async (amount: number, date: string, accountId?: string, exchangeRate?: number, note?: string) => {
    if (!editingDebt) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { Alert.alert('Проверьте дату погашения'); return; }
    const execute = async () => { try { await recordDebtPayment(editingDebt.id, amount, date, accountId ?? null, exchangeRate, note); await refreshOpenDebt(); } catch (error) { Alert.alert('Не удалось записать погашение', describeError(error) ?? 'Проверьте валютные курсы.'); } };
    if (Math.abs(amount - editingDebt.currentBalance) < 0.000001) {
      const account = userAccounts.find((item) => item.id === accountId);
      Alert.alert('Полностью погасить долг?', `${money(amount, false, editingDebt.currency)}${account ? ` · ${account.name}` : ' · без движения по счёту'}`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Погасить', onPress: execute }]);
    } else await execute();
  };
  const handleReverseDebtPayment = (event: DebtHistory, fallbackAccountId?: string) => {
    if (!editingDebt || event.amount === undefined) return;
    Alert.alert('Отменить погашение?', `${money(event.amount, false, editingDebt.currency)} вернётся в остаток долга. Баланс связанного счёта будет исправлен обратной проводкой.`, [
      { text: 'Не отменять', style: 'cancel' },
      { text: 'Отменить погашение', style: 'destructive', onPress: async () => { try { await reverseDebtPayment(editingDebt.id, event.id, fallbackAccountId); await refreshOpenDebt(); } catch (error) { Alert.alert('Не удалось отменить погашение', describeError(error) ?? 'Проверьте данные операции.'); } } },
    ]);
  };
  const handleDebtExtension = async (date: string, note?: string) => {
    if (!editingDebt) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date <= editingDebt.dueDate) { Alert.alert('Новый срок должен быть позже текущего'); return; }
    await extendDebt(editingDebt.id, date, note); await refreshOpenDebt();
  };
  const handleDebtOverdue = async () => { if (editingDebt) { await markDebtOverdue(editingDebt.id); await refreshOpenDebt(); } };
  const handleCurrencySettings = async (settings: CurrencySettings) => { await saveCurrencySettings(settings); await reloadCurrencySettings(); setCurrencySettingsOpen(false); };
  const handleCreateOperation = async (input: FinancialOperationInput) => { await createOperation(input); await Promise.all([reloadOperations(), reloadAccounts()]); setOperationEditorOpen(false); };
  const handleCreateTransfer = async (input: TransferInput) => {
    try { await recordTransfer(input); await Promise.all([reloadTransfers(), reloadAccounts()]); setTransferModalOpen(false); }
    catch (error) { Alert.alert('Не удалось выполнить перевод', describeError(error) ?? 'Проверьте счета и суммы.'); }
  };
  const handleReverseTransfer = async (transfer: Transfer) => {
    try { await reverseTransfer(transfer.id); await Promise.all([reloadTransfers(), reloadAccounts()]); }
    catch (error) { Alert.alert('Не удалось отменить перевод', describeError(error) ?? 'Попробуйте ещё раз.'); }
  };
  const handleOpenOccurrence = (occurrence: PlannedOccurrence, flow: PlannedExpense) => setExecutingOccurrence({ occurrence, flow });
  const handleExecuteOccurrence = async (input: PlannedExecutionInput) => {
    if (!executingOccurrence) return;
    try {
      await executePlannedOccurrence(executingOccurrence.occurrence.id, input);
      await Promise.all([reloadPlannedOccurrences(), reloadOperations(), reloadAccounts()]);
      setExecutingOccurrence(null);
    } catch (error) { Alert.alert('Не удалось провести событие', describeError(error) ?? 'Попробуйте ещё раз.'); }
  };
  const handleCancelOccurrence = (occurrence: PlannedOccurrence) => {
    Alert.alert('Отменить плановое событие?', 'Операция создана не будет.', [
      { text: 'Не отменять', style: 'cancel' },
      { text: 'Отменить', style: 'destructive', onPress: async () => { await cancelPlannedOccurrence(occurrence.id); await reloadPlannedOccurrences(); } },
    ]);
  };
  const openNewBudget = () => { setEditingBudget(null); setBudgetEditorOpen(true); };
  const openBudget = (budget: Budget) => { setEditingBudget(budget); setBudgetEditorOpen(true); };
  const handleSaveBudget = async (input: BudgetInput) => { await saveBudget(input, editingBudget?.id); await reloadBudgets(); setBudgetEditorOpen(false); };
  const handleDeleteBudget = (budget: Budget) => Alert.alert('Удалить бюджет?', `Лимит «${budget.category}» будет удалён.`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: async () => { await deleteBudget(budget.id); await reloadBudgets(); setBudgetEditorOpen(false); } }]);
  const openNewGoal = () => { setEditingGoal(null); setGoalEditorOpen(true); };
  const openGoal = (goal: FinancialGoal) => { setEditingGoal(goal); setGoalEditorOpen(true); };
  const handleSaveGoal = async (input: FinancialGoalInput) => { await saveFinancialGoal(input, editingGoal?.id); await reloadGoals(); setGoalEditorOpen(false); };
  const handleDeleteGoal = (goal: FinancialGoal) => Alert.alert('Удалить цель?', `Цель «${goal.title}» будет удалена.`, [{ text: 'Отмена', style: 'cancel' }, { text: 'Удалить', style: 'destructive', onPress: async () => { await deleteFinancialGoal(goal.id); await reloadGoals(); setGoalEditorOpen(false); } }]);
  const usedCurrencies = Array.from(new Set([...userAccounts.map((item) => item.currency), ...plannedExpenses.map((item) => item.currency), ...debts.map((item) => item.currency), ...operations.map((item) => item.currency), ...userBudgets.map((item) => item.currency), ...financialGoals.map((item) => item.currency)]));

  const screen = useMemo(() => {
    const onProfile = () => setTab('profile');
    if (tab === 'profile') return <Profile email={email} accounts={userAccounts} currencySettings={currencySettings} onCurrencySettings={() => setCurrencySettingsOpen(true)} onBack={() => setTab('home')} pendingSmsDrafts={pendingSmsDrafts} onSmsDraftsChanged={() => countPendingImportDrafts().then(setPendingSmsDrafts)} onOpenAssistant={() => setAiAssistantOpen(true)} pendingAiProposals={pendingAiProposals} />;
    if (tab === 'accounts') return <Accounts accounts={userAccounts} onAdd={openNewAccount} onImport={() => setImportOpen(true)} onEdit={openAccount} debts={debts} onAddDebt={openNewDebt} onOpenDebt={openDebt} currencySettings={currencySettings} onCurrencySettings={() => setCurrencySettingsOpen(true)} onProfile={onProfile} />;
    if (tab === 'calendar') return <Calendar accounts={userAccounts} plannedExpenses={plannedExpenses} plannedOccurrences={plannedOccurrences} debts={debts} currencySettings={currencySettings} onAddExpense={openNewExpense} onEditExpense={openExpense} onExecuteOccurrence={handleOpenOccurrence} onCancelOccurrence={handleCancelOccurrence} onProfile={onProfile} operations={operations} transfers={transfers} />;
    if (tab === 'operations') return <Operations operations={operations} transfers={transfers} plannedOccurrences={plannedOccurrences} plannedExpenses={plannedExpenses} accounts={userAccounts} onAdd={() => setOperationEditorOpen(true)} onTransfer={() => setTransferModalOpen(true)} onReverseTransfer={handleReverseTransfer} onExecuteOccurrence={handleOpenOccurrence} onCancelOccurrence={handleCancelOccurrence} onProfile={onProfile} />;
    if (tab === 'analytics') return <Analytics accounts={userAccounts} plannedExpenses={plannedExpenses} plannedOccurrences={plannedOccurrences} debts={debts} currencySettings={currencySettings} operations={operations} transfers={transfers} userBudgets={userBudgets} financialGoals={financialGoals} onAddBudget={openNewBudget} onEditBudget={openBudget} onAddGoal={openNewGoal} onEditGoal={openGoal} onProfile={onProfile} />;
    return <Home onImport={() => setImportOpen(true)} go={setTab} accounts={userAccounts} plannedExpenses={plannedExpenses} plannedOccurrences={plannedOccurrences} debts={debts} currencySettings={currencySettings} onCurrencySettings={() => setCurrencySettingsOpen(true)} onProfile={onProfile} pendingImportDrafts={pendingSmsDrafts} operations={operations} transfers={transfers} onEditAccount={openAccount} />;
  }, [tab, userAccounts, plannedExpenses, plannedOccurrences, debts, currencySettings, operations, transfers, userBudgets, financialGoals, email, pendingSmsDrafts]);
  return <SafeAreaView style={s.safe} edges={['top']}>
    <StatusBar style="dark" />
    <View style={s.screen}>{screen}</View>
    <View style={s.tabBar}>{tabs.map((item) => { const active = tab === item.key; return <Pressable key={item.key} style={s.tab} onPress={() => setTab(item.key)}><Ionicons name={active ? item.icon.replace('-outline', '') as keyof typeof Ionicons.glyphMap : item.icon} size={21} color={active ? C.navy : '#98A1A4'} /><Text style={[s.tabText, active && s.tabTextActive]}>{item.label}</Text></Pressable> })}</View>
    <ImportModal visible={importOpen} onClose={() => setImportOpen(false)} accounts={userAccounts} onAccountSaved={async (input) => { await saveAccount(input); await synchronizeInterestPostings(); await Promise.all([reloadAccounts(), reloadOperations()]); }} />
    <AiAssistantModal visible={aiAssistantOpen} accounts={userAccounts} debts={debts} onClose={async () => {
      setAiAssistantOpen(false);
      await Promise.all([reloadAccounts(), reloadOperations(), reloadDebts(), reloadTransfers(), reloadExpenses(), reloadPlannedOccurrences()]);
      await refreshAiProposals();
    }} />
    <AccountEditor visible={accountEditorOpen} account={editingAccount} accounts={userAccounts} rateHistory={depositRateHistory} onClose={() => setAccountEditorOpen(false)} onSave={handleSaveAccount} onDelete={handleDeleteAccount} />
    <PlannedExpenseEditor visible={expenseEditorOpen} expense={editingExpense} initialDate={newExpenseInitialDate} accounts={userAccounts} currencySettings={currencySettings} onClose={() => setExpenseEditorOpen(false)} onSave={handleSaveExpense} onDelete={handleDeleteExpense} />
    <DebtEditor visible={debtEditorOpen} debt={editingDebt} history={debtHistory} accounts={userAccounts} currencySettings={currencySettings} onClose={() => setDebtEditorOpen(false)} onCreate={handleCreateDebt} onUpdate={handleUpdateDebt} onPayment={handleDebtPayment} onReversePayment={handleReverseDebtPayment} onExtend={handleDebtExtension} onOverdue={handleDebtOverdue} />
    <CurrencySettingsEditor visible={currencySettingsOpen} currencies={usedCurrencies} settings={currencySettings} onClose={() => setCurrencySettingsOpen(false)} onSave={handleCurrencySettings} />
    <OperationEditor visible={operationEditorOpen} accounts={userAccounts} onClose={() => setOperationEditorOpen(false)} onSave={handleCreateOperation} />
    <TransferModal visible={transferModalOpen} accounts={userAccounts} currencySettings={currencySettings} onClose={() => setTransferModalOpen(false)} onSave={handleCreateTransfer} />
    <ExecuteOccurrenceModal visible={!!executingOccurrence} occurrence={executingOccurrence?.occurrence ?? null} flow={executingOccurrence?.flow ?? null} accounts={userAccounts} currencySettings={currencySettings} onClose={() => setExecutingOccurrence(null)} onExecute={handleExecuteOccurrence} />
    <BudgetEditor visible={budgetEditorOpen} budget={editingBudget} currencies={usedCurrencies} onClose={() => setBudgetEditorOpen(false)} onSave={handleSaveBudget} onDelete={handleDeleteBudget} />
    <GoalEditor visible={goalEditorOpen} goal={editingGoal} accounts={userAccounts} debts={debts} onClose={() => setGoalEditorOpen(false)} onSave={handleSaveGoal} onDelete={handleDeleteGoal} />
  </SafeAreaView>;
}

function AuthScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const submit = async () => {
    if (!supabase || !email.trim() || password.length < 6) {
      setMessage('Введите email и пароль не короче 6 символов.');
      return;
    }
    setBusy(true); setMessage('');
    const result = register
      ? await supabase.auth.signUp({ email: email.trim(), password })
      : await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (result.error) setMessage(result.error.message);
    else if (register && !result.data.session) setMessage('Проверьте почту и подтвердите регистрацию.');
  };

  return <SafeAreaView style={s.authSafe}>
    <StatusBar style="dark" />
    <KeyboardAvoidingView style={s.authKeyboard} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={s.authPage} keyboardShouldPersistTaps="handled">
        <View style={s.authMark}><Text style={s.authMarkText}>А</Text></View>
        <Text style={s.authTitle}>Афина</Text>
        <Text style={s.authSubtitle}>Ваши финансы синхронизируются с защищённым облаком</Text>
        <View style={s.authCard}>
          <Text style={s.fieldLabel}>Email</Text>
          <TextInput style={s.input} value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
          <Text style={s.fieldLabel}>Пароль</Text>
          <TextInput style={s.input} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoComplete={register ? 'new-password' : 'current-password'} />
          {!!message && <Text style={s.authMessage}>{message}</Text>}
          <Pressable style={[s.primaryButton, busy && { opacity: .55 }]} disabled={busy} onPress={submit}>
            {busy ? <ActivityIndicator color="white" /> : <Text style={s.primaryText}>{register ? 'Создать аккаунт' : 'Войти'}</Text>}
          </Pressable>
          <Pressable style={s.secondaryButton} onPress={() => { setRegister((value) => !value); setMessage(''); }}>
            <Text style={s.secondaryText}>{register ? 'Уже есть аккаунт — войти' : 'Первый вход — зарегистрироваться'}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

const LOCK_ENABLED_KEY = 'afina_lock_enabled';
const LOCK_PIN_KEY = 'afina_lock_pin';
const PIN_LENGTH = 4;

const getLockEnabled = async () => (await SecureStore.getItemAsync(LOCK_ENABLED_KEY)) === '1';
const setLockEnabledStored = (value: boolean) => SecureStore.setItemAsync(LOCK_ENABLED_KEY, value ? '1' : '0');
const getStoredPin = () => SecureStore.getItemAsync(LOCK_PIN_KEY);
const setStoredPin = (pin: string | null) => pin ? SecureStore.setItemAsync(LOCK_PIN_KEY, pin) : SecureStore.deleteItemAsync(LOCK_PIN_KEY);

// "Already celebrated this goal" is deliberately device-local, not synced — it's a one-time UI
// treat, not financial data, so a plain SecureStore-backed id list is enough (no schema/migration).
const CELEBRATED_GOALS_KEY = 'afina_celebrated_goals';
const getCelebratedGoalIds = async (): Promise<string[]> => {
  const raw = await SecureStore.getItemAsync(CELEBRATED_GOALS_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
};
const addCelebratedGoalId = async (id: string) => {
  const existing = await getCelebratedGoalIds();
  if (existing.includes(id)) return;
  await SecureStore.setItemAsync(CELEBRATED_GOALS_KEY, JSON.stringify([...existing, id]));
};

const CONFETTI_COLORS = [C.blue, C.green, C.red, C.navy, '#F2C94C'];

function ConfettiOverlay({ caption, onDone }: { caption?: string; onDone: () => void }) {
  const { width, height } = Dimensions.get('window');
  const captionOpacity = useRef(new Animated.Value(0)).current;
  const pieces = useRef(Array.from({ length: 36 }, (_, i) => ({
    x: Math.random() * width,
    delay: Math.random() * 250,
    duration: 1800 + Math.random() * 900,
    rotateStart: Math.random() * 360,
    rotateEnd: Math.random() * 720 - 360,
    drift: (Math.random() - 0.5) * 120,
    size: 6 + Math.random() * 6,
    color: CONFETTI_COLORS[i % CONFETTI_COLORS.length]!,
    progress: new Animated.Value(0),
  }))).current;
  useEffect(() => {
    const animations = pieces.map((piece) => Animated.timing(piece.progress, {
      toValue: 1, duration: piece.duration, delay: piece.delay, useNativeDriver: true,
    }));
    Animated.stagger(20, animations).start();
    Animated.sequence([
      Animated.timing(captionOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
      Animated.delay(1900),
      Animated.timing(captionOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(onDone, 2800);
    return () => clearTimeout(timer);
  }, []);
  return <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
    {pieces.map((piece, index) => {
      const translateY = piece.progress.interpolate({ inputRange: [0, 1], outputRange: [-20, height + 20] });
      const translateX = piece.progress.interpolate({ inputRange: [0, 1], outputRange: [0, piece.drift] });
      const rotate = piece.progress.interpolate({ inputRange: [0, 1], outputRange: [`${piece.rotateStart}deg`, `${piece.rotateStart + piece.rotateEnd}deg`] });
      const opacity = piece.progress.interpolate({ inputRange: [0, 0.85, 1], outputRange: [1, 1, 0] });
      return <Animated.View key={index} style={{
        position: 'absolute', left: piece.x, width: piece.size, height: piece.size * 1.6,
        backgroundColor: piece.color, borderRadius: 2, opacity,
        transform: [{ translateY }, { translateX }, { rotate }],
      }} />;
    })}
    {!!caption && <Animated.View style={{ position: 'absolute', top: 90, left: 20, right: 20, alignItems: 'center', opacity: captionOpacity }}>
      <View style={{ backgroundColor: C.navy, borderRadius: 16, paddingVertical: 10, paddingHorizontal: 16 }}>
        <Text style={{ color: 'white', fontSize: 14, fontWeight: '700', textAlign: 'center' }}>🎉 Цель «{caption}» достигнута!</Text>
      </View>
    </Animated.View>}
  </View>;
}

function PinDots({ length, filled }: { length: number; filled: number }) {
  return <View style={s.pinDots}>{Array.from({ length }, (_, i) => <View key={i} style={[s.pinDot, i < filled && s.pinDotFilled]} />)}</View>;
}

function PinKeypad({ onDigit, onBackspace }: { onDigit: (digit: string) => void; onBackspace: () => void }) {
  const rows = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['', '0', '⌫']];
  return <View style={{ gap: 14 }}>{rows.map((row, ri) => <View key={ri} style={s.pinRow}>{row.map((key, ki) => key ? <Pressable key={ki} style={s.pinKey} onPress={() => key === '⌫' ? onBackspace() : onDigit(key)}><Text style={s.pinKeyText}>{key}</Text></Pressable> : <View key={ki} style={s.pinKey} />)}</View>)}</View>;
}

// Lock is always backed by a PIN once enabled — biometric is an optional shortcut tried first,
// never the sole gate, so a user who un-enrolls fingerprints/Face ID in OS settings can never be
// locked out with no way back in.
function PinUnlockPad({ onSuccess }: { onSuccess: () => void }) {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const handleDigit = (digit: string) => {
    if (entry.length >= PIN_LENGTH) return;
    const next = entry + digit;
    setEntry(next);
    if (next.length === PIN_LENGTH) {
      getStoredPin().then((stored) => {
        if (stored && stored === next) { setError(''); setEntry(''); onSuccess(); }
        else { setError('Неверный PIN-код'); setEntry(''); }
      });
    }
  };
  return <View>
    <Text style={[s.rowSub, { textAlign: 'center' }]}>Введите PIN-код</Text>
    <PinDots length={PIN_LENGTH} filled={entry.length} />
    {!!error && <Text style={[s.authMessage, { textAlign: 'center' }]}>{error}</Text>}
    <PinKeypad onDigit={handleDigit} onBackspace={() => setEntry((value) => value.slice(0, -1))} />
  </View>;
}

function PinSetupModal({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [stage, setStage] = useState<'new' | 'confirm'>('new');
  const [firstPin, setFirstPin] = useState('');
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { if (visible) { setStage('new'); setFirstPin(''); setEntry(''); setError(''); } }, [visible]);
  const handleDigit = (digit: string) => {
    if (entry.length >= PIN_LENGTH) return;
    const next = entry + digit;
    setEntry(next);
    if (next.length < PIN_LENGTH) return;
    if (stage === 'new') { setFirstPin(next); setEntry(''); setStage('confirm'); return; }
    if (next === firstPin) { Promise.all([setStoredPin(next), setLockEnabledStored(true)]).then(onSaved); }
    else { setError('PIN-коды не совпадают, начните заново'); setStage('new'); setFirstPin(''); setEntry(''); }
  };
  return <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
    <SafeAreaView style={s.lockSafe}>
      <View style={s.lockContent}>
        <Pressable onPress={onClose} style={{ alignSelf: 'flex-start' }} hitSlop={10}><Ionicons name="close" size={24} color={C.ink} /></Pressable>
        <View style={s.lockMark}><Ionicons name="keypad-outline" size={26} color={C.navy} /></View>
        <Text style={s.lockTitle}>{stage === 'new' ? 'Придумайте PIN-код' : 'Повторите PIN-код'}</Text>
        <PinDots length={PIN_LENGTH} filled={entry.length} />
        {!!error && <Text style={[s.authMessage, { textAlign: 'center' }]}>{error}</Text>}
        <PinKeypad onDigit={handleDigit} onBackspace={() => setEntry((value) => value.slice(0, -1))} />
      </View>
    </SafeAreaView>
  </Modal>;
}

function AppLockGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [locked, setLocked] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const appState = useRef(AppState.currentState);

  const tryBiometric = async () => {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: 'Войти в Афину', cancelLabel: 'Отмена' });
    if (result.success) setLocked(false);
  };

  useEffect(() => {
    (async () => {
      const enabled = await getLockEnabled();
      if (!enabled) { setReady(true); return; }
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const enrolled = hasHardware && await LocalAuthentication.isEnrolledAsync();
      setBiometricAvailable(enrolled);
      setLocked(true);
      setReady(true);
      if (enrolled) tryBiometric();
    })();
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (appState.current === 'active' && next.match(/inactive|background/)) {
        getLockEnabled().then((enabled) => { if (enabled) setLocked(true); });
      }
      appState.current = next;
    });
    return () => subscription.remove();
  }, []);

  if (!ready) return <View style={s.cloudLoading}><ActivityIndicator size="large" color={C.blue} /></View>;
  if (!locked) return <>{children}</>;
  return <SafeAreaView style={s.lockSafe}>
    <View style={s.lockContent}>
      <View style={s.lockMark}><Ionicons name="lock-closed" size={26} color={C.navy} /></View>
      <Text style={s.lockTitle}>Афина заблокирована</Text>
      {biometricAvailable && <Pressable style={s.scanButton} onPress={tryBiometric}>
        <View style={s.scanIcon}><Ionicons name="finger-print-outline" size={22} color={C.navy} /></View>
        <View style={{ flex: 1 }}><Text style={s.scanTitle}>Войти по биометрии</Text><Text style={s.scanSub}>Face ID или отпечаток пальца</Text></View>
      </Pressable>}
      <PinUnlockPad onSuccess={() => setLocked(false)} />
    </View>
  </SafeAreaView>;
}

function CloudGate() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setLoading(false); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);
  if (loading) return <View style={s.cloudLoading}><ActivityIndicator size="large" color={C.blue} /></View>;
  if (!isCloudConfigured || !supabase) return <View style={s.cloudLoading}><Text style={s.authMessage}>Облачное подключение не настроено.</Text></View>;
  if (!session) return <AuthScreen />;
  return <AppLockGate><AppContent userId={session.user.id} email={session.user.email} /></AppLockGate>;
}

export default function App() { return <SafeAreaProvider><CloudGate /></SafeAreaProvider>; }

const s = StyleSheet.create({
  authSafe: { flex: 1, backgroundColor: C.bg }, authKeyboard: { flex: 1 }, authPage: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  authMark: { width: 64, height: 64, borderRadius: 22, backgroundColor: '#D7EAF2', alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  authMarkText: { color: C.navy, fontSize: 28, fontWeight: '800' }, authTitle: { color: C.ink, fontSize: 32, fontWeight: '800', textAlign: 'center', marginTop: 16 },
  authSubtitle: { color: C.muted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 7, marginBottom: 24 },
  authCard: { backgroundColor: C.card, borderRadius: 22, padding: 20 }, authMessage: { color: C.red, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  cloudLoading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: C.bg, padding: 24 },
  lockSafe: { flex: 1, backgroundColor: C.bg }, lockContent: { flex: 1, justifyContent: 'center', padding: 28 },
  lockMark: { width: 56, height: 56, borderRadius: 20, backgroundColor: '#D7EAF2', alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 14 },
  lockTitle: { color: C.ink, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 18 },
  pinDots: { flexDirection: 'row', gap: 16, justifyContent: 'center', marginVertical: 20 },
  pinDot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5, borderColor: C.line },
  pinDotFilled: { backgroundColor: C.navy, borderColor: C.navy },
  pinRow: { flexDirection: 'row', gap: 18, justifyContent: 'center' },
  pinKey: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  pinKeyText: { color: C.ink, fontSize: 22, fontWeight: '600' },
  receiptOverlay: { flex: 1, backgroundColor: 'rgba(10,18,22,0.92)', alignItems: 'center', justifyContent: 'center' },
  receiptClose: { position: 'absolute', top: 54, right: 20 }, receiptImage: { width: '92%', height: '80%' },
  safe: { flex: 1, backgroundColor: C.bg }, screen: { flex: 1 }, page: { padding: 20, paddingBottom: 24 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 }, eyebrow: { fontSize: 11, letterSpacing: 1.6, color: C.muted, fontWeight: '700', marginBottom: 4 }, title: { fontSize: 28, fontWeight: '700', color: C.ink, letterSpacing: -.7 },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#D8EAF2', alignItems: 'center', justifyContent: 'center' }, avatarText: { color: C.navy, fontSize: 17, fontWeight: '700' },
  hero: { backgroundColor: C.navy, borderRadius: 24, padding: 22, marginBottom: 14 }, heroLabel: { color: '#AFC0C7', fontSize: 10, letterSpacing: 1.5, fontWeight: '700' }, heroAmount: { color: 'white', fontSize: 30, fontWeight: '700', marginTop: 8, letterSpacing: -.5 }, heroOtherCurrency: { color: '#C6D5DB', fontSize: 13, fontWeight: '600', marginTop: 4 }, heroDelta: { flexDirection: 'row', alignItems: 'center', marginTop: 7 }, heroDeltaText: { color: '#DCE7DD', fontSize: 12 }, heroRule: { height: 1, backgroundColor: '#49606B', marginVertical: 18 }, heroStats: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 }, heroStatCol: { flex: 1, alignItems: 'center' }, heroStatLabel: { color: '#AFC0C7', fontSize: 11, marginBottom: 5 }, heroStatLabelBox: { textAlign: 'center', minHeight: 28 }, heroStat: { color: 'white', fontSize: 13, fontWeight: '700' },
  scanButton: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#D7EAF2', borderRadius: 18, padding: 14, marginBottom: 12 }, scanIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: '#EDF7FA', alignItems: 'center', justifyContent: 'center' }, scanTitle: { color: C.ink, fontSize: 15, fontWeight: '700' }, scanSub: { color: C.muted, fontSize: 12, marginTop: 2 },
  alert: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.redSoft, borderRadius: 18, padding: 15, marginBottom: 24, gap: 12 }, alertIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F7D6D1', alignItems: 'center', justifyContent: 'center' }, alertTitle: { color: '#873A35', fontSize: 14, fontWeight: '700' }, alertText: { color: '#A25C56', fontSize: 12, marginTop: 3 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4, marginBottom: 11 }, sectionTitle: { color: C.ink, fontSize: 18, fontWeight: '700' }, link: { color: C.blue, fontSize: 13, fontWeight: '600' }, card: { backgroundColor: C.card, borderRadius: 18, paddingHorizontal: 16, marginBottom: 22 },
  eventRow: { minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 12 }, dateTile: { width: 44, height: 48, borderRadius: 12, backgroundColor: '#DCECF3', alignItems: 'center', justifyContent: 'center' }, dateDay: { fontSize: 17, fontWeight: '700', color: C.ink }, dateMonth: { fontSize: 8, letterSpacing: 1, color: C.muted, fontWeight: '700' }, rowTitle: { color: C.ink, fontSize: 14, fontWeight: '600' }, rowSub: { color: C.muted, fontSize: 11, marginTop: 4 }, expense: { color: C.red, fontSize: 12, fontWeight: '700' }, income: { color: '#54715B', fontSize: 12, fontWeight: '700' }, divider: { height: 1, backgroundColor: C.line },
  accountRail: { gap: 11, paddingBottom: 3 }, miniAccount: { width: 188, backgroundColor: C.card, borderRadius: 17, borderTopWidth: 3, padding: 15 }, roundIcon: { width: 40, height: 40, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, miniName: { fontSize: 12, color: C.muted, marginTop: 13 }, miniBalance: { fontSize: 17, fontWeight: '700', color: C.ink, marginTop: 5 },
  totalLine: { backgroundColor: C.navy, borderRadius: 20, padding: 20, marginBottom: 21 }, totalLabel: { color: '#AFC0C7', fontSize: 12 }, totalAmount: { color: 'white', fontSize: 26, fontWeight: '700', marginTop: 6 }, accountCard: { backgroundColor: C.card, borderRadius: 17, padding: 15, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, accountStripe: { width: 4, position: 'absolute', left: 0, top: 0, bottom: 0 }, accountAmount: { color: C.ink, fontSize: 14, fontWeight: '700' }, currency: { color: C.muted, fontSize: 9, marginTop: 4 }, rate: { fontSize: 10, marginTop: 5, fontWeight: '600' },
  debtSummary: { flexDirection: 'row', backgroundColor: C.card, borderRadius: 17, padding: 16, marginBottom: 10 }, debtSide: { flex: 1 }, debtLabel: { fontSize: 9, letterSpacing: 1, color: C.muted, fontWeight: '700' }, debtPositive: { fontSize: 15, color: '#54715B', fontWeight: '700', marginTop: 6 }, debtNegative: { fontSize: 15, color: C.red, fontWeight: '700', marginTop: 6 }, verticalRule: { width: 1, backgroundColor: C.line, marginHorizontal: 14 }, personRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 12 }, personIcon: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' }, personInitial: { color: C.green, fontSize: 15, fontWeight: '700' },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, paddingHorizontal: 4 }, month: { fontSize: 17, fontWeight: '700', color: C.ink }, forecastCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: C.navy, borderRadius: 18, padding: 17, marginBottom: 16 }, forecastLabel: { color: '#AFC0C7', fontSize: 9, letterSpacing: 1 }, forecastAmount: { color: 'white', fontSize: 20, fontWeight: '700', marginTop: 5 }, forecastPill: { backgroundColor: '#425967', borderRadius: 12, paddingVertical: 7, paddingHorizontal: 10 }, forecastPillText: { color: '#F1CEC5', fontSize: 11, fontWeight: '700' }, weekHead: { flexDirection: 'row', marginBottom: 5 }, weekDay: { width: '14.285%', textAlign: 'center', fontSize: 9, color: C.muted, fontWeight: '700' }, calendarGrid: { flexDirection: 'row', flexWrap: 'wrap', backgroundColor: C.card, borderRadius: 18, padding: 5, overflow: 'hidden' }, dayCell: { width: '14.285%', height: 62, borderRadius: 10, padding: 5, alignItems: 'center' }, riskyDay: { backgroundColor: C.redSoft }, today: { borderWidth: 1, borderColor: C.green }, todayMarker: { borderWidth: 1, borderColor: C.blue }, selectedDay: { backgroundColor: '#DDEEF4' }, dayNumber: { color: C.ink, fontSize: 11, fontWeight: '700' }, dayBalance: { color: C.muted, fontSize: 8, marginTop: 6 }, dots: { flexDirection: 'row', gap: 3, marginTop: 5 }, dot: { width: 5, height: 5, borderRadius: 3 }, legend: { flexDirection: 'row', justifyContent: 'center', gap: 20, paddingVertical: 14, marginBottom: 10 }, legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 }, legendText: { color: C.muted, fontSize: 10 },
  segment: { flexDirection: 'row', backgroundColor: '#DCEBF1', borderRadius: 14, padding: 4, marginBottom: 20 }, segmentActive: { flex: 1, paddingVertical: 9, borderRadius: 11, backgroundColor: C.card, alignItems: 'center' }, segmentActiveText: { color: C.ink, fontSize: 12, fontWeight: '700' }, segmentText: { flex: 1, textAlign: 'center', paddingVertical: 9, color: C.muted, fontSize: 12 }, chartCard: { backgroundColor: C.card, borderRadius: 18, padding: 17, marginBottom: 12 }, chartTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, chartLabel: { fontSize: 9, letterSpacing: 1, color: C.muted, fontWeight: '700' }, chartValue: { fontSize: 20, color: C.ink, fontWeight: '700', marginTop: 5 }, chartBadge: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9, backgroundColor: C.sageSoft }, chartBadgeText: { color: C.green, fontSize: 11, fontWeight: '700' }, bars: { height: 130, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around', marginTop: 20 }, barGroup: { alignItems: 'center', flex: 1 }, barPair: { height: 104, flexDirection: 'row', alignItems: 'flex-end', gap: 4 }, bar: { width: 12, borderRadius: 5 }, barMonth: { color: C.muted, fontSize: 9, marginTop: 7 }, chartLegend: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 10 }, metricRow: { flexDirection: 'row', gap: 10, marginBottom: 22 }, metric: { flex: 1, backgroundColor: C.card, borderRadius: 16, padding: 14 }, metricLabel: { color: C.muted, fontSize: 9, letterSpacing: 1 }, metricValue: { color: C.ink, fontSize: 17, fontWeight: '700', marginTop: 7 }, metricSub: { color: C.muted, fontSize: 10, marginTop: 3 }, budgetRow: { paddingVertical: 14 }, budgetBorder: { borderTopWidth: 1, borderTopColor: C.line }, budgetTop: { flexDirection: 'row', justifyContent: 'space-between' }, budgetAmount: { color: C.ink, fontSize: 12, fontWeight: '700' }, progressTrack: { height: 7, borderRadius: 4, backgroundColor: '#E3EEF2', overflow: 'hidden', marginTop: 11 }, progressFill: { height: '100%', borderRadius: 4 }, budgetHint: { color: C.muted, fontSize: 9, marginTop: 6 }, goalCard: { backgroundColor: C.card, borderRadius: 17, padding: 15, marginBottom: 10 }, goalTop: { flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 5 }, goalIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }, goalPercent: { fontSize: 17, fontWeight: '700' }, goalAmounts: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 3 },
  tabBar: { flexDirection: 'row', backgroundColor: C.card, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 9, paddingBottom: 9 }, tab: { flex: 1, alignItems: 'center', gap: 3 }, tabText: { color: '#98A1A4', fontSize: 9 }, tabTextActive: { color: C.navy, fontWeight: '700' },
  modal: { flex: 1, backgroundColor: C.bg }, modalHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line }, close: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' }, modalTitle: { color: C.ink, fontSize: 16, fontWeight: '700' }, modalBody: { padding: 20, paddingBottom: 40 }, uploadHero: { alignItems: 'center', paddingTop: 35, paddingBottom: 28 }, scanLarge: { width: 76, height: 76, borderRadius: 25, backgroundColor: '#D7EAF2', alignItems: 'center', justifyContent: 'center', marginBottom: 22 }, uploadTitle: { fontSize: 23, fontWeight: '700', color: C.ink, textAlign: 'center' }, uploadText: { fontSize: 13, lineHeight: 20, color: C.muted, textAlign: 'center', marginTop: 10, maxWidth: 320 }, primaryButton: { minHeight: 54, borderRadius: 16, backgroundColor: C.navy, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 15 }, primaryText: { color: 'white', fontSize: 14, fontWeight: '700' }, secondaryButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: C.blue, fontSize: 13, fontWeight: '600' }, privacy: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, marginTop: 14, backgroundColor: C.sageSoft, borderRadius: 14 }, privacyText: { flex: 1, color: C.green, fontSize: 11, lineHeight: 16 }, recognitionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, marginBottom: 12 }, confidence: { backgroundColor: C.sageSoft, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10 }, confidenceText: { color: C.green, fontSize: 10, fontWeight: '700' }, detectRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 15 }, detectLabel: { color: C.muted, fontSize: 12 }, detectValue: { color: C.ink, fontSize: 12, fontWeight: '700' }, detectTx: { minHeight: 67, flexDirection: 'row', alignItems: 'center' }, success: { paddingTop: 80, alignItems: 'stretch' }, successIcon: { width: 70, height: 70, borderRadius: 35, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center', alignSelf: 'center', marginBottom: 22 },
  emptyCard: { backgroundColor: C.card, borderRadius: 18, padding: 22, alignItems: 'center', marginBottom: 20 }, largeEmpty: { backgroundColor: C.card, borderRadius: 18, borderWidth: 1, borderStyle: 'dashed', borderColor: '#BBD3DE', padding: 28, alignItems: 'center', marginBottom: 18 }, emptyRound: { width: 48, height: 48, borderRadius: 24, backgroundColor: '#DDEEF4', alignItems: 'center', justifyContent: 'center', marginBottom: 12 }, emptyTitle: { color: C.ink, fontSize: 14, fontWeight: '700', marginTop: 8 }, emptyText: { color: C.muted, fontSize: 11, textAlign: 'center', marginTop: 5 },
  accountActions: { flexDirection: 'row', gap: 9, marginBottom: 14 }, importAccountButton: { flex: 1, minHeight: 48, backgroundColor: C.navy, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, importAccountText: { color: 'white', fontSize: 12, fontWeight: '700' }, manualAccountButton: { flex: 1, minHeight: 48, backgroundColor: '#DDEEF4', borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, manualAccountText: { color: C.blue, fontSize: 12, fontWeight: '700' },
  filterPanel: { gap: 9, marginBottom: 10 }, filterRail: { gap: 7, paddingRight: 8 }, debtGroupTitle: { color: C.muted, fontSize: 11, fontWeight: '700', letterSpacing: .7, marginTop: 4, marginBottom: 7, textTransform: 'uppercase' },
  groupHeader: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 },
  dayGroupHeader: { minHeight: 30, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 8 },
  dayGroupLabel: { color: C.ink, fontSize: 13, fontWeight: '700' },
  planExpenseButton: { minHeight: 50, backgroundColor: C.navy, borderRadius: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 14 },
  currencySettingsButton: { minHeight: 46, backgroundColor: '#DDEEF4', borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 12 },
  secondaryAction: { minHeight: 48, borderRadius: 14, backgroundColor: '#DDEEF4', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  overdueButton: { minHeight: 48, borderRadius: 14, backgroundColor: C.redSoft, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 },
  historyRow: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 10 },
  editDebtBox: { marginTop: 12, padding: 14, borderRadius: 16, backgroundColor: '#E7F1F5' },
  rateSettingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 9 },
  dateField: { minHeight: 52, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 },
  dateFieldText: { flex: 1, color: C.ink, fontSize: 14, fontWeight: '600' },
  dateOverlay: { flex: 1, backgroundColor: 'rgba(23,42,52,.48)', justifyContent: 'center', padding: 20 },
  datePickerCard: { backgroundColor: C.card, borderRadius: 22, padding: 18 }, dateGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  datePickerDay: { width: '14.285%', height: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, datePickerDayActive: { backgroundColor: C.navy },
  templateRail: { gap: 9, paddingBottom: 4 }, templateExpense: { width: 155, minHeight: 96, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, padding: 13 },
  repeatGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, repeatChoice: { width: '48.5%', minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }, weekdayRow: { flexDirection: 'row', gap: 5 }, weekday: { flex: 1, height: 38, borderRadius: 10, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  scanningBox: { minHeight: 150, alignItems: 'center', justifyContent: 'center' }, ocrError: { flexDirection: 'row', gap: 10, padding: 14, backgroundColor: C.redSoft, borderRadius: 14, marginTop: 14 }, ocrErrorText: { flex: 1, color: '#873A35', fontSize: 12, lineHeight: 18 },
  editDetectedButton: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#DDEEF4', paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10 }, editDetectedText: { color: C.blue, fontSize: 11, fontWeight: '700' }, reviewForm: { backgroundColor: C.card, borderRadius: 18, padding: 15, marginBottom: 14 }, reviewDoneButton: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: '#DDEEF4', borderRadius: 13, marginTop: 16 }, reviewDoneText: { color: C.blue, fontSize: 12, fontWeight: '700' },
  formBody: { padding: 20, paddingBottom: 40 }, fieldLabel: { color: C.muted, fontSize: 9, letterSpacing: 1.1, fontWeight: '700', marginTop: 18, marginBottom: 7 }, input: { minHeight: 52, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, borderRadius: 14, paddingHorizontal: 14, color: C.ink, fontSize: 14 }, typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, typeOption: { width: '48.5%', minHeight: 54, borderRadius: 14, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12 }, typeOptionActive: { borderColor: C.blue, backgroundColor: '#DDEEF4' }, typeLabel: { color: C.muted, fontSize: 11, fontWeight: '600' }, typeLabelActive: { color: C.navy }, twoColumns: { flexDirection: 'row', gap: 10 }, currencySwitch: { minHeight: 52, flexDirection: 'row', padding: 4, backgroundColor: '#DCEBF1', borderRadius: 14 }, currencyOption: { flex: 1, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, currencyActive: { backgroundColor: C.card }, currencyOptionText: { color: C.muted, fontSize: 10, fontWeight: '700' }, currencyActiveText: { color: C.navy }, deleteButton: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 10 }, deleteText: { color: C.red, fontSize: 13, fontWeight: '600' },
  currencyGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 }, currencyChip: { minWidth: 56, height: 38, paddingHorizontal: 11, borderRadius: 11, backgroundColor: C.card, borderWidth: 1, borderColor: C.line, alignItems: 'center', justifyContent: 'center' }, currencyChipActive: { backgroundColor: '#DDEEF4', borderColor: C.blue }, currencyChipText: { color: C.muted, fontSize: 10, fontWeight: '700' }, interestBox: { marginTop: 4 }, miniFieldLabel: { color: C.muted, fontSize: 9, marginBottom: 6 }, choiceRow: { flexDirection: 'row', gap: 8 }, choice: { flex: 1, minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 }, choiceActive: { borderColor: C.blue, backgroundColor: '#DDEEF4' }, choiceText: { color: C.muted, fontSize: 10, fontWeight: '600', textAlign: 'center' }, choiceTextActive: { color: C.navy }, targetList: { gap: 7 }, targetAccount: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: C.line, backgroundColor: C.card }, targetAccountActive: { borderColor: C.blue, backgroundColor: '#DDEEF4' }, targetAccountText: { color: C.muted, fontSize: 12, fontWeight: '600' }, helperText: { color: C.muted, fontSize: 11, lineHeight: 17, backgroundColor: '#EDF5F8', borderRadius: 12, padding: 12 },
  currencyRail: { gap: 7, paddingBottom: 15 }, currencyFilter: { minWidth: 58, height: 36, borderRadius: 11, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, currencyFilterActive: { backgroundColor: C.navy, borderColor: C.navy }, currencyFilterText: { color: C.muted, fontSize: 10, fontWeight: '700' }, currencyFilterTextActive: { color: 'white' }, assetRow: { paddingTop: 14 },
});
