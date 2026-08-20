import { ParsedSms, SmsParser } from '../types';

const pad = (value: number) => String(value).padStart(2, '0');
const isoLocal = (year: number, month: number, day: number, hour: number, minute: number) =>
  `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00`;

// Kapitalbank's own three templates disagree with each other on date format (DD-MM-YYYY for a
// purchase vs DD.MM.YY for a top-up/withdrawal) — this is one bank's inconsistency, not something
// to normalize away silently. Each sub-template is matched and dated independently.

const purchaseRe = /Karta \*(\d{4})\.\s*Xarid\/Pokupka\s*"([^"]*)",\s*(-?\d+(?:\.\d+)?),\s*([A-Z]{3}),\s*"(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})"\.\s*Dostupno:\s*(\d+(?:\.\d+)?),\s*([A-Z]{3})\.?/i;

const flowRe = /(Popolneniye|Snyatiye),\s*(\d{2})\.(\d{2})\.(\d{2})\s+v\s+(\d{2}):(\d{2})\.\s*Karta\s*\(\*(\d{4})\)\.\s*Summa:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})\.\s*(.*?)\.\s*Dostupno:\s*(\d+(?:\.\d+)?)\s*([A-Z]{3})/i;

// A third, simpler top-up template with no balance/merchant at all, e.g.:
//   "Schet po karte *3463 popolnen na summu 42.85 UZS. 19-AUG-2026 00:00"
// Date here uses an English 3-letter month abbreviation (AUG) instead of a numeric month, unlike
// either template above — a third date format from the same bank, not a typo to "fix" into
// matching the others.
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const accountTopUpRe = /Schet po karte\s*\*(\d{4})\s+popolnen na summu\s+(\d+(?:\.\d+)?)\s+([A-Z]{3})\.\s*(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2})/i;

// A declined purchase attempt, e.g.:
//   "Hisobda mablag' yetarli emas. Nedostatochno sredstv.Karta *3463. Xarid/Pokupka
//    "YANDEX.GO>YUNUSOBOD", -41000.00, UZS, "19-08-2026 20:24". Dostupno: 28593.19, UZS."
// This still contains a "Karta *NNNN. Xarid/Pokupka ..." substring that purchaseRe would
// otherwise match — confirmed against a real sample where "Dostupno" is unchanged from the prior
// (successful) message, i.e. no money actually moved. Must be checked before purchaseRe runs, or
// a transaction the bank refused would get recorded as a real expense that never happened.
const declinedRe = /yetarli\s+emas|nedostatochno\s+sredstv/i;

function parseKapitalbank(body: string): ParsedSms | null {
  if (declinedRe.test(body)) return null;

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

  const topUp = body.match(accountTopUpRe);
  if (topUp) {
    const [, cardLast4, rawAmount, currency, dd, monthName, yyyy, hh, min] = topUp;
    const amount = Number(rawAmount);
    const month = MONTHS[monthName!.toLowerCase()];
    if (!Number.isFinite(amount) || amount <= 0 || !month) return null;
    return {
      amount,
      currency: currency!,
      kind: 'income',
      occurredAt: isoLocal(Number(yyyy), month, Number(dd), Number(hh), Number(min)),
      cardLast4,
    };
  }

  return null;
}

export const kapitalbankParser: SmsParser = {
  id: 'kapitalbank',
  senders: ['kapitalbank'],
  parse: parseKapitalbank,
};
