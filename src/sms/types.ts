// Pure parsing types — no React Native / native imports here. Keeps this module runnable and
// unit-testable from plain Node/tsc, independent of whether the native SMS reader exists yet.

export type ParsedSms = {
  amount: number;
  currency: string;
  kind: 'income' | 'expense';
  // Local-wall-clock ISO instant ("YYYY-MM-DDTHH:mm:ss") the bank's SMS says the operation
  // happened — not when the SMS was received, which can lag by seconds to minutes.
  occurredAt: string;
  cardLast4?: string;
  merchant?: string;
  feeAmount?: number;
  balanceAfter?: number;
};

export type SmsParser = {
  id: string;
  // Sender ids this parser applies to (e.g. "kapitalbank", "13131"), matched exactly against the
  // normalized sender the registry is given — a parser never runs against a sender it doesn't own.
  senders: string[];
  parse: (body: string) => ParsedSms | null;
};
