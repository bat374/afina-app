import { Account, CalendarDay, Goal, Transaction } from './types';

export const accounts: Account[] = [
  {
    id: 'card', name: 'Основная карта', subtitle: 'Kapitalbank • 4821', type: 'card',
    balance: 8_450_000, currency: 'UZS', accent: '#263C4A',
  },
  {
    id: 'savings', name: 'Финансовая подушка', subtitle: 'Накопительный счёт', type: 'savings',
    balance: 24_800_000, currency: 'UZS', rate: 18, rateCaption: 'ежемесячно', accent: '#788D7B',
  },
  {
    id: 'deposit', name: 'Вклад «Комфорт»', subtitle: 'До 18 февраля 2027', type: 'deposit',
    balance: 15_000_000, currency: 'UZS', rate: 21, rateCaption: 'с капитализацией', accent: '#5C91AA',
  },
  {
    id: 'cash', name: 'Наличные', subtitle: 'Кошелёк', type: 'cash',
    balance: 1_150_000, currency: 'UZS', accent: '#78A0B3',
  },
];

export const transactions: Transaction[] = [
  { id: '1', title: 'Зарплата', category: 'Активный доход', amount: 14_500_000, date: '1 августа', account: 'Основная карта', kind: 'income' },
  { id: '2', title: 'Korzinka', category: 'Продукты', amount: 487_300, date: '2 августа', account: 'Основная карта', kind: 'expense' },
  { id: '3', title: 'Проценты по счёту', category: 'Пассивный доход', amount: 372_000, date: '3 августа', account: 'Финансовая подушка', kind: 'income' },
  { id: '4', title: 'Аренда квартиры', category: 'Жильё', amount: 4_800_000, date: '5 августа', account: 'Основная карта', kind: 'expense' },
];

export const calendarDays: CalendarDay[] = Array.from({ length: 31 }, (_, index) => {
  const day = index + 1;
  const events: Record<number, Partial<CalendarDay>> = {
    1: { income: 14_500_000 }, 3: { income: 372_000 }, 5: { expense: 4_800_000 },
    9: { expense: 1_250_000 }, 12: { expense: 6_900_000, risky: true },
    15: { income: 2_000_000 }, 18: { expense: 820_000 }, 25: { expense: 1_600_000 },
  };
  const beforeIncome = day >= 1 ? 14_872_000 : 0;
  let spent = 0;
  if (day >= 5) spent += 4_800_000;
  if (day >= 9) spent += 1_250_000;
  if (day >= 12) spent += 6_900_000;
  if (day >= 18) spent += 820_000;
  if (day >= 25) spent += 1_600_000;
  const extra = day >= 15 ? 2_000_000 : 0;
  return { day, balance: 1_150_000 + beforeIncome + extra - spent, ...events[day] };
});

export const goals: Goal[] = [
  { id: 'reserve', title: 'Резерв на 6 месяцев', current: 24_800_000, target: 48_000_000, deadline: 'Декабрь 2027', color: '#788D7B' },
  { id: 'passive', title: 'Пассивный доход', current: 372_000, target: 1_000_000, deadline: 'в месяц', color: '#5C91AA' },
];

export const budgets = [
  { name: 'Продукты', spent: 1_820_000, limit: 3_200_000, color: '#788D7B' },
  { name: 'Жильё', spent: 4_800_000, limit: 5_000_000, color: '#5C91AA' },
  { name: 'Транспорт', spent: 780_000, limit: 1_500_000, color: '#6E8795' },
];
