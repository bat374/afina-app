const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const toLocalIso = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export const localToday = () => toLocalIso(new Date());

export const parseLocalDate = (value?: string) => {
  const match = value?.match(ISO_DATE);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  return toLocalIso(date) === value ? date : null;
};

export const isIsoDate = (value?: string): value is string => !!parseLocalDate(value);

export const addLocalDays = (value: string, days: number) => {
  const date = parseLocalDate(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return toLocalIso(date);
};

export const daysBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000));

export const nextBusinessMonday = (value: string) => {
  const date = parseLocalDate(value);
  if (!date) return value;
  if (date.getDay() === 6) date.setDate(date.getDate() + 2);
  if (date.getDay() === 0) date.setDate(date.getDate() + 1);
  return toLocalIso(date);
};

export const nextMonthlyDate = (startDate: string, afterDate = localToday()) => {
  const start = parseLocalDate(startDate);
  const after = parseLocalDate(afterDate);
  if (!start || !after) return undefined;
  const preferredDay = start.getDate();
  const candidateFor = (year: number, month: number) =>
    new Date(year, month, Math.min(preferredDay, new Date(year, month + 1, 0).getDate()), 12);
  let candidate = candidateFor(after.getFullYear(), after.getMonth());
  if (candidate <= after) candidate = candidateFor(after.getFullYear(), after.getMonth() + 1);
  return toLocalIso(candidate);
};

export const previousMonthlyDate = (anchorDate: string) => {
  const anchor = parseLocalDate(anchorDate);
  if (!anchor) return undefined;
  const preferredDay = anchor.getDate();
  const previous = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1, 12);
  previous.setDate(Math.min(preferredDay, new Date(previous.getFullYear(), previous.getMonth() + 1, 0).getDate()));
  return toLocalIso(previous);
};
