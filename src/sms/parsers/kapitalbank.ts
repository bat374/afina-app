import { ParsedSms, SmsParser } from '../types';

const pad = (value: number) => String(value).padStart(2, '0');
const isoLocal = (year: number, month: number, day: number, hour: number, minute: number) =>
  `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;

// Kapitalbank's own three templates disagree with each other on date format (DD-MM-YYYY for a
// purchase vs DD.MM.YY for a top-up/withdrawal) — this is one bank's inconsistency, not something
// to normalize away silently. Each sub-template is matched and dated independently.

const purchaseRe = /Karta \*(\d{4})\.\s*Xarid\/Pokupka\s*"([^"]*)",\s*(-?\d+(?:\.\d+)?),\s*([A-Z]{3}),\s*"(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})"\.\s*Dostupno:\s*(\d+(?:\.\d+)?),\s*([A-Z]{3})\.?/i;

const flowRe = /(Popolneniye|Snyatiye),\s*(\d{2})\.(\d{2})\.(\d{2})\s+v\s+(\d{2}):(\d{2})\.\s*Karta\s*\(\*(\d{4})\)\.\s*Summa:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})\.\s*(.*?)\.\s*Dostupno:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})/i;

function parseKapitalbank(body: string): ParsedSms | null {
  const purchase = body.match(purchaseRe);
  if (purchase) {
    const [, cardLast4, merchant, rawAmount, currency, dd, mm, yyyy, hh, min, balance] = purchase;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount === 0) return null;
    return {
      amount: Math.abs(amount),
      currency: currency!,
      kind: amount < 0 ? 'expense' : 'income',
      occurredAt: isoLocal(Number(yyyy), Number(mm), Number(dd), Number(hh), Number(min)),
      cardLast4,
      merchant: merchant || undefined,
      balanceAfter: Number(balance),
    };
  }

  const flow = body.match(flowRe);
  if (flow) {
    const [, keyword, dd, mm, yy, hh, min, cardLast4, rawAmount, currency, description, balance] = flow;
    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      amount,
      currency: currency!,
      kind: keyword === 'Popolneniye' ? 'income' : 'expense',
      occurredAt: isoLocal(2000 + Number(yy), Number(mm), Number(dd), Number(hh), Number(min)),
      cardLast4,
      merchant: description || undefined,
      balanceAfter: Number(balance),
    };
  }

  return null;
}

export const kapitalbankParser: SmsParser = {
  id: 'kapitalbank',
  senders: ['kapitalbank'],
  parse: parseKapitalbank,
};
