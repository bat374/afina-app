// Shared shape for anything parsed out of a bank text — SMS or push notification. Pure types,
// no React Native / native imports, so both src/sms/ and src/push/ stay unit-testable from plain
// Node/tsc independent of whether the native reader for either channel exists yet.

export type ParsedTransaction = {
  amount: number;
  currency: string;
  kind: 'income' | 'expense';
  // Local-wall-clock ISO instant ("YYYY-MM-DDTHH:mm:ss") the bank's message says the operation
  // happened — not when the message was received/posted, which can lag by seconds to minutes.
  // Optional because push notifications often omit a timestamp entirely (confirmed: Sberbank's
  // purchase push has none) — a push parser then has nothing reliable to put here, and
  // createImportDraft falls back to the message's own receivedAt instead of inventing a time.
  occurredAt?: string;
  cardLast4?: string;
  merchant?: string;
  feeAmount?: number;
  balanceAfter?: number;
};
