import { ParsedSms, SmsParser } from '../types';

const toNumber = (raw: string) => Number(raw.replace(/[\s ]/g, '').replace(',', '.'));

// Confirmed real sample (SberBank SMS, sender "900"):
//   "СберВклад Премиум *1499 Продлили по ставке 12,10% до 21.01.27. Выплатили проценты
//    31 327,19р. Баланс: 601 763,78р."
// Sent once per auto-renewal — reports a rate/maturity change AND an interest payout in the same
// message. The product name before "*NNNN" varies by deposit product (only "СберВклад Премиум"
// confirmed so far), so it's matched loosely rather than pinned to one exact name.
const renewalRe = /\*(\d{4})\s+Продлили по ставке\s+(\d+(?:,\d+)?)%\s+до\s+(\d{2})\.(\d{2})\.(\d{2})\.\s*Выплатили проценты\s+([\d\s ]+,\d{2})\s*р\.?\s*Баланс:\s*([\d\s ]+,\d{2})\s*р\.?/iu;

function parseSberbank(body: string): ParsedSms | null {
  const match = body.match(renewalRe);
  if (!match) return null;
  const [, cardLast4, rawRate, dd, mm, yy, rawInterest, rawBalance] = match;
  const interest = toNumber(rawInterest!);
  const rate = toNumber(rawRate!);
  if (!Number.isFinite(interest) || interest <= 0 || !Number.isFinite(rate) || rate <= 0) return null;
  return {
    amount: interest,
    currency: 'RUB',
    kind: 'income',
    cardLast4,
    balanceAfter: toNumber(rawBalance!),
    renewedRate: rate,
    renewedMaturityDate: `20${yy}-${mm}-${dd}`,
  };
}

export const sberbankSmsParser: SmsParser = {
  id: 'sberbank',
  senders: ['900'],
  parse: parseSberbank,
};
