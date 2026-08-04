import TextRecognition from '@react-native-ml-kit/text-recognition';
import { AccountInput } from './database';
import { AccountType } from './types';

export type DetectedAccount = {
  account: AccountInput;
  confidence: number;
  rawText: string;
};

const BANKS = [
  'Kapitalbank', 'TBC Bank', 'Anorbank', 'Hamkorbank', 'Ipak Yo‘li',
  'Ipak Yuli', 'Uzum Bank', 'Octobank', 'NBU', 'Ipoteka Bank', 'СберБанк', 'Сбер',
];

const parseNumber = (raw: string) => {
  const compact = raw.replace(/\s/g, '');
  const lastSeparator = Math.max(compact.lastIndexOf(','), compact.lastIndexOf('.'));
  const decimal = lastSeparator >= 0 && compact.length - lastSeparator - 1 === 2;
  if (!decimal) return Number(compact.replace(/[.,]/g, ''));
  const integer = compact.slice(0, lastSeparator).replace(/[.,]/g, '');
  return Number(`${integer}.${compact.slice(lastSeparator + 1)}`);
};

type PositionedLine = { text: string; top?: number; imageHeight?: number };

const findBalance = (text: string, positionedLines?: PositionedLine[]) => {
  const lines: PositionedLine[] = positionedLines?.length ? positionedLines : text.split(/\r?\n/).filter(Boolean).map((line) => ({ text: line }));
  const candidates: { value: number; score: number }[] = [];
  const amountPattern = /\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{2})?|\d{4,12}(?:[.,]\d{2})?/g;
  lines.forEach((entry, index) => {
    const line = entry.text;
    const lower = line.toLowerCase();
    const context = `${lines[index - 1]?.text ?? ''} ${lower}`.toLowerCase();
    const contextual = /баланс|доступно|остаток|сумма|balance|available|amount|маблағ|mablag/.test(context);
    const currency = /сум|uzs|so['’`]?m|usd|rub|руб|₽|\$/.test(context) || /\d[\d\s.,]*\s*[РP]\b/.test(line);
    for (const match of line.matchAll(amountPattern)) {
      const value = parseNumber(match[0]);
      if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000_000) continue;
      if (value < 10_000 && !contextual && !currency) continue;
      const hasCents = /[.,]\d{2}$/.test(match[0]);
      const position = entry.top !== undefined && entry.imageHeight ? Math.max(0, 45 * (1 - entry.top / entry.imageHeight)) : 0;
      const thresholdPenalty = /\bдо\b|свыше|лимит|надбав/i.test(context) ? 120 : 0;
      const suspiciousRoundLimit = !contextual && !hasCents && value >= 1_000_000 && value % 1_000_000 === 0 ? 55 : 0;
      candidates.push({
        value,
        score: (contextual ? 140 : 0) + (currency ? 40 : 0) + (hasCents ? 50 : 0)
          + position + Math.min(value / 1_000_000, 20) - thresholdPenalty - suspiciousRoundLimit,
      });
    }
  });
  return candidates.sort((a, b) => b.score - a.score)[0]?.value ?? 0;
};

const countMatches = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;

const extractDates = (text: string) => Array.from(text.matchAll(/(\d{2})[./-](\d{2})[./-](\d{4})/g))
  .map((match) => match[1] && match[2] && match[3] ? `${match[3]}-${match[2]}-${match[1]}` : '')
  .filter(Boolean);

const extractRates = (text: string) => Array.from(text.matchAll(/(\d{1,2}(?:[.,]\d+)?)\s*%/g))
  .map((match) => Number(match[1]?.replace(',', '.')))
  .filter((value) => Number.isFinite(value) && value > 0 && value < 100);

const detectRate = (text: string) => {
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const context = `${lines[index - 1] ?? ''} ${lines[index] ?? ''}`.toLowerCase();
    if (!/ставк|rate/.test(context)) continue;
    const rates = extractRates(lines[index] ?? '');
    if (rates.length) return rates.at(-1);
  }
  return extractRates(text).sort((a, b) => b - a)[0];
};

const detectType = (text: string, dates: string[], rates: number[]): AccountType => {
  const lower = text.toLowerCase();
  const depositScore = countMatches(lower, /вклад|депозит|deposit|omonat/g) * 3
    + countMatches(lower, /дата закрытия|условия вклада|снять со вклада|пополнить вклад/g) * 2;
  const savingsScore = countMatches(lower, /накопитель|сберег|savings|jamg/g) * 3;
  if (depositScore >= 3 && depositScore > savingsScore) return 'deposit';
  if (dates.length >= 2 && rates.length >= 1) return 'deposit';
  if (savingsScore >= 3) return 'savings';
  return 'card';
};

const detectCurrency = (text: string) => {
  if (/российск\w*\s+руб|руб|rub|₽|\bMNM\b/i.test(text) || /\d[\d\s.,]*\s*[РP]\b/.test(text)) return 'RUB';
  if (/доллар|usd|\$/i.test(text) && !/uzs|сум|so['’`]?m/i.test(text)) return 'USD';
  if (/евро|eur|€/i.test(text)) return 'EUR';
  if (/юан|cny|¥/i.test(text)) return 'CNY';
  if (/тенге|kzt|₸/i.test(text)) return 'KZT';
  const codes = text.match(/\b[A-Z]{3}\b/g) ?? [];
  const ignored = new Set(['VISA', 'SMS', 'PIN']);
  const code = codes.find((value) => !ignored.has(value));
  return code ?? 'UZS';
};

const detectMaturityDate = (text: string, dates: string[]) => {
  const raw = text.match(/(?:дата\s+закрытия|срок|до)\s*[:—-]?\s*(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (raw?.[1] && raw[2] && raw[3]) return `${raw[3]}-${raw[2]}-${raw[1]}`;
  const renewal = text.match(/следующ\w*\s+продлен\w*[\s\S]{0,30}?(\d{2})[./-](\d{2})[./-](\d{4})/i);
  if (renewal?.[1] && renewal[2] && renewal[3]) return `${renewal[3]}-${renewal[2]}-${renewal[1]}`;
  return [...dates].sort().at(-1);
};

export function parseAccountText(text: string, positionedLines?: PositionedLine[]): DetectedAccount {
  const dates = extractDates(text);
  const rates = extractRates(text);
  const currency = detectCurrency(text);
  const balance = findBalance(text, positionedLines);
  const type = detectType(text, dates, rates);
  const bank = BANKS.find((name) => text.toLowerCase().includes(name.toLowerCase()));
  const lastFour = text.match(/(?:\*{2,}|•{2,}|x{2,}|х{2,})\s*(\d{4})/i)?.[1];
  const rate = detectRate(text);
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const sortedDates = [...dates].sort();
  const futureDates = sortedDates.filter((date) => date >= todayIso);
  const labeledStart = text.match(/(?:открыт|дата\s+открытия)[\s\S]{0,20}?(\d{2})[./-](\d{2})[./-](\d{4})/i);
  const startDate = labeledStart?.[1] && labeledStart[2] && labeledStart[3] ? `${labeledStart[3]}-${labeledStart[2]}-${labeledStart[1]}` : sortedDates[0] ?? todayIso;
  const maturityDate = detectMaturityDate(text, futureDates.length ? futureDates : dates);
  const labeledInterest = text.match(/(?:процент\w*\s+начисл\w*|следующ\w*\s+выплат\w*)[\s\S]{0,25}?(\d{2})[./-](\d{2})[./-](\d{4})/i);
  const nextInterestDate = labeledInterest?.[1] && labeledInterest[2] && labeledInterest[3] ? `${labeledInterest[3]}-${labeledInterest[2]}-${labeledInterest[1]}` : futureDates[0];
  const repeatedFutureDay = futureDates.length >= 2 && futureDates[0]?.slice(-2) === futureDates[1]?.slice(-2);
  const interestSchedule = /кажд\w*\s+месяц|ежемесяч|monthly/i.test(text) || repeatedFutureDay ? 'monthly' as const : /каждый\s+день|ежедневн|daily/i.test(text) ? 'daily' as const : maturityDate ? 'maturity' as const : undefined;
  const interestDestination = /на\s+(?:visa|mastercard|карт|сч[её]т)/i.test(text) ? 'other' as const : 'same' as const;
  const autoRenewal = /автоматическ\w*|автопролонг|следующ\w*\s+продлен/i.test(text) || (dates.length >= 3 && futureDates.length >= 2);
  const withdrawableRaw = text.match(/можно\s+снять[\s\S]{0,30}?(\d{1,3}(?:[\s.,]\d{3})+(?:[.,]\d{2})?)/i)?.[1];
  const withdrawable = withdrawableRaw ? parseNumber(withdrawableRaw) : undefined;
  const minimumBalance = withdrawable !== undefined && balance > withdrawable ? balance - withdrawable : undefined;
  const withdrawalPolicy = /нельзя\s+снять|снятие\s+невозмож/i.test(text) ? 'none' as const : /только\s+процент/i.test(text) ? 'interest_only' as const : minimumBalance !== undefined ? 'minimum_balance' as const : /до\s+нул|до\s+0/i.test(text) ? 'to_zero' as const : undefined;
  const replenishmentAllowed = /нельзя\s+пополн|без\s+пополн/i.test(text) ? false : /можно\s+пополн|пополнить\s+вклад|пополнение\s+доступ/i.test(text) ? true : undefined;
  const labeledName = text.match(/название\s*[\r\n]+([^\r\n]+)/i)?.[1]?.trim();
  const typeName = type === 'deposit' ? 'Вклад' : type === 'savings' ? 'Накопительный счёт' : 'Банковская карта';
  const subtitle = [bank, lastFour ? `• ${lastFour}` : undefined].filter(Boolean).join(' ') || 'Распознано со скриншота';
  return {
    account: {
      name: labeledName || (bank ? `${typeName} · ${bank}` : typeName),
      subtitle,
      type,
      balance,
      currency,
      rate,
      rateCaption: rate ? 'годовых' : undefined,
      startDate,
      maturityDate,
      interestSchedule,
      interestDestination,
      nextInterestDate,
      autoRenewal,
      rateReviewReminder: autoRenewal,
      withdrawalPolicy,
      minimumBalance,
      replenishmentAllowed,
      accent: type === 'deposit' ? '#5C91AA' : type === 'savings' ? '#788D7B' : '#263C4A',
    },
    confidence: balance > 0 ? (bank ? 94 : 86) : 58,
    rawText: text,
  };
}

export async function recognizeAccountScreenshot(uri: string) {
  const result = await TextRecognition.recognize(uri);
  const imageHeight = result.blocks.reduce((height, block) => Math.max(height, (block.frame?.top ?? 0) + (block.frame?.height ?? 0)), 0);
  const positionedLines = result.blocks.flatMap((block) => block.lines.map((line) => ({
    text: line.text,
    top: line.frame?.top,
    imageHeight: imageHeight || undefined,
  }))).sort((left, right) => (left.top ?? 0) - (right.top ?? 0));
  return parseAccountText(result.text, positionedLines);
}
