import { ParsedTransaction } from '../../parsing/types';
import { PushParser } from '../types';

const toNumber = (raw: string) => Number(raw.replace(/[\s ]/g, '').replace(',', '.'));

// Confirmed real sample (SberBank purchase-by-SBP push, notification history screenshot):
//   title: "👍 Вы это сделали! Покупка по СБП в Rahmat"
//   text:  "137,62 ₽ — У вас ещё: 875 133,94 ₽ Счёт карты MasterCard •• 7367"
// and a second one with different marketing copy in the title ("... прошла на ура! Rahmat") and
// "Осталось" instead of "У вас ещё" in the text — the title's exact phrasing varies per
// notification (playful/rotating copy), so only "Покупка ... <merchant>" at the end is stable;
// the amount/balance/card come entirely from the body text, not the title.
//
// Only this one notification shape (a card purchase via SBP) is confirmed. Sberbank almost
// certainly also sends other kinds (incoming transfer, salary credit, etc.) with a different
// title/text shape this hasn't seen yet — those intentionally fall through to null/unrecognized
// rather than being guessed at from this pattern.
const merchantRe = /Покупка(?:\s+по\s+СБП)?\s+(?:в|прошла на ура!)\s+(.+)$/iu;
const bodyRe = /^([\d\s ]+,\d{2})\s*₽\s*—\s*(?:У вас ещё|Осталось):\s*([\d\s ]+,\d{2})\s*₽\s*Счёт карты \S+\s*••\s*(\d{4})/iu;

// Confirmed real sample (SberBank накопительный счёт/вклад interest payout push, notification
// history screenshot):
//   title: "Выплата процентов"
//   text:  "+ 513,91 ₽ — Баланс: 256 273,84 ₽ Накопительн..."
//   text:  "+ 5 723,22 ₽ — Баланс: 671 318,18 ₽ СберВкл..."
// The trailing account label is truncated by the OS notification itself (ellipsis in both real
// samples) — not reliable enough to use for account matching, kept only as an informational hint.
// No card number here (this is a deposit/savings account, not a card).
const interestTitleRe = /Выплата процентов/i;
const interestBodyRe = /^\+\s*([\d\s ]+,\d{2})\s*₽\s*—\s*Баланс:\s*([\d\s ]+,\d{2})\s*₽\s*(.*)$/u;

function parseSberbank(title: string, text: string): ParsedTransaction | null {
  if (interestTitleRe.test(title)) {
    const interestMatch = text.match(interestBodyRe);
    if (!interestMatch) return null;
    const [, rawAmount, rawBalance, accountHint] = interestMatch;
    const amount = toNumber(rawAmount!);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    return {
      amount,
      currency: 'RUB',
      kind: 'income',
      merchant: accountHint?.trim() || undefined,
      balanceAfter: toNumber(rawBalance!),
    };
  }
  const bodyMatch = text.match(bodyRe);
  if (!bodyMatch) return null;
  const [, rawAmount, rawBalance, cardLast4] = bodyMatch;
  const amount = toNumber(rawAmount!);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const merchantMatch = title.match(merchantRe);
  return {
    amount,
    currency: 'RUB',
    kind: 'expense',
    cardLast4,
    merchant: merchantMatch?.[1]?.trim(),
    balanceAfter: toNumber(rawBalance!),
  };
}

export const sberbankParser: PushParser = {
  id: 'sberbank',
  packages: ['ru.sberbankmobile'],
  parse: parseSberbank,
};
