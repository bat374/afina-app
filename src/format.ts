export const money = (value: number, compact = false, currency = 'UZS') => {
  if (compact) {
    if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)} млн ${currency}`;
    if (Math.abs(value) >= 1_000) return `${Math.round(value / 1_000)} тыс ${currency}`;
  }
  const formatted = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: currency === 'UZS' ? 0 : 2 }).format(value);
  return `${formatted} ${currency}`;
};

export const percent = (current: number, target: number) => Math.min(100, Math.round((current / target) * 100));
