import { PlannedExpense, RecurrenceUnit } from './types';
import { daysBetween, parseLocalDate } from './date';

const monthDistance = (from: Date, to: Date) =>
  (to.getFullYear() - from.getFullYear()) * 12 + to.getMonth() - from.getMonth();

const preferredMonthDay = (start: Date, current: Date) =>
  Math.min(start.getDate(), new Date(current.getFullYear(), current.getMonth() + 1, 0).getDate());

export function occursOn(flow: PlannedExpense, current: Date) {
  const start = parseLocalDate(flow.startDate);
  const end = parseLocalDate(flow.endDate);
  if (!start || current < start || (end && current > end)) return false;
  if (flow.repeat === 'once') return current.toDateString() === start.toDateString();

  const interval = Math.max(1, Math.floor(flow.repeatInterval ?? 1));
  const unit: RecurrenceUnit = flow.repeatUnit ?? (
    flow.repeat === 'daily' ? 'day' : flow.repeat === 'weekly' ? 'week' : flow.repeat === 'monthly' ? 'month' : 'year'
  );
  const elapsedDays = daysBetween(start, current);

  if (unit === 'day') return elapsedDays % interval === 0;
  if (unit === 'week') {
    const weekdays = flow.weekdays?.length ? flow.weekdays : [start.getDay() || 7];
    return Math.floor(elapsedDays / 7) % interval === 0 && weekdays.includes(current.getDay() || 7);
  }
  if (unit === 'month') {
    const months = monthDistance(start, current);
    return months >= 0 && months % interval === 0 && current.getDate() === preferredMonthDay(start, current);
  }
  const years = current.getFullYear() - start.getFullYear();
  return years >= 0 && years % interval === 0 && current.getMonth() === start.getMonth()
    && current.getDate() === preferredMonthDay(start, current);
}

export const recurrenceLabel = (flow: PlannedExpense) => {
  if (flow.repeat === 'once') return 'один раз';
  const interval = Math.max(1, flow.repeatInterval ?? 1);
  const unit = flow.repeatUnit ?? (flow.repeat === 'daily' ? 'day' : flow.repeat === 'weekly' ? 'week' : flow.repeat === 'monthly' ? 'month' : 'year');
  const names = unit === 'day' ? ['день', 'дня', 'дней'] : unit === 'week' ? ['неделю', 'недели', 'недель'] : unit === 'month' ? ['месяц', 'месяца', 'месяцев'] : ['год', 'года', 'лет'];
  const form = interval % 10 === 1 && interval % 100 !== 11 ? names[0] : [2, 3, 4].includes(interval % 10) && ![12, 13, 14].includes(interval % 100) ? names[1] : names[2];
  const weekdays = unit === 'week' && flow.weekdays?.length ? ` · ${flow.weekdays.map((day) => ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][day - 1]).join(', ')}` : '';
  return `каждые ${interval} ${form}${weekdays}`;
};
