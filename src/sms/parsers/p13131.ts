import { ParsedSms, SmsParser } from '../types';

const pad = (value: number) => String(value).padStart(2, '0');
const isoLocal = (year: number, month: number, day: number, hour: number, minute: number) =>
  `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;

// This sender's date is YY-MM-DD — the *opposite* order from Kapitalbank's DD-MM-YYYY purchase
// template. Confirmed against two consecutive real messages ("26-08-16" then "26-08-17", the
// second one delivered on a Monday) — do not "fix" this to match the other parser.
const oplataRe = /VISA \*(\d{4}):\s*oplata\s*(\d+(?:\.\d+)?)\s*([A-Z]{3});\.\s*Komissiya za operaciju:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})\s*(.*?);\s*(\d{2})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2});\s*Dostupno:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})/i;

function parseP13131(body: string): ParsedSms | null {
  const match = body.match(oplataRe);
  if (!match) return null;
  const [, cardLast4, rawAmount, currency, rawFee, , merchant, yy, mm, dd, hh, min, balance] = match;
  const amount = Number(rawAmount);
  const fee = Number(rawFee);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return {
    amount,
    currency: currency!,
    kind: 'expense',
    occurredAt: isoLocal(2000 + Number(yy), Number(mm), Number(dd), Number(hh), Number(min)),
    cardLast4,
    // Merchant text in this template can be split across adjacent SMS parts in the raw thread —
    // best-effort only, never used for matching or dedup, just to label the draft for the user.
    merchant: merchant || undefined,
    feeAmount: Number.isFinite(fee) && fee > 0 ? fee : undefined,
    balanceAfter: Number(balance),
  };
}

export const p13131Parser: SmsParser = {
  id: 'p13131',
  senders: ['13131'],
  parse: parseP13131,
};
