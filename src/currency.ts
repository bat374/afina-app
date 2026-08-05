import { Account, CurrencySettings, Debt } from './types';

export const convertToBase = (amount: number, currency: string, settings: CurrencySettings) => {
  const rate = currency === settings.baseCurrency ? 1 : settings.rates[currency];
  return rate && rate > 0 ? amount * rate : null;
};

export const convertCurrency = (amount: number, from: string, to: string, settings: CurrencySettings) => {
  if (from === to) return amount;
  const sourceRate = from === settings.baseCurrency ? 1 : settings.rates[from];
  const targetRate = to === settings.baseCurrency ? 1 : settings.rates[to];
  return sourceRate && sourceRate > 0 && targetRate && targetRate > 0 ? amount * sourceRate / targetRate : null;
};

export const consolidatedNetWorth = (accounts: Account[], debts: Debt[], settings: CurrencySettings) => {
  let total = 0;
  const missing = new Set<string>();
  const add = (amount: number, currency: string) => {
    const converted = convertToBase(amount, currency, settings);
    if (converted === null) missing.add(currency);
    else total += converted;
  };
  accounts.forEach((account) => add(account.balance, account.currency));
  debts.filter((debt) => debt.status !== 'paid').forEach((debt) => add(debt.direction === 'owed_to_me' ? debt.currentBalance : -debt.currentBalance, debt.currency));
  return { total, missing: [...missing] };
};

export const weightedAssetRates = (accounts: Account[], settings: CurrencySettings) => {
  const byCurrency: Record<string, { assets: number; weighted: number; rate: number }> = {};
  let allAssets = 0; let allWeighted = 0;
  for (const account of accounts.filter((item) => item.balance > 0 && item.type !== 'credit_card')) {
    const bucket = byCurrency[account.currency] ?? { assets: 0, weighted: 0, rate: 0 };
    bucket.assets += account.balance; bucket.weighted += account.balance * (account.rate ?? 0);
    bucket.rate = bucket.assets ? bucket.weighted / bucket.assets : 0; byCurrency[account.currency] = bucket;
    const converted = convertToBase(account.balance, account.currency, settings);
    if (converted !== null) { allAssets += converted; allWeighted += converted * (account.rate ?? 0); }
  }
  return { all: allAssets ? allWeighted / allAssets : 0, byCurrency };
};

export const rebaseRates = (settings: CurrencySettings, nextBase: string): CurrencySettings => {
  if (nextBase === settings.baseCurrency) return settings;
  const divisor = settings.rates[nextBase];
  if (!divisor || divisor <= 0) return { ...settings, baseCurrency: nextBase, rates: { [nextBase]: 1 } };
  const rates = Object.fromEntries(Object.entries(settings.rates).map(([currency, rate]) => [currency, rate / divisor]));
  rates[nextBase] = 1;
  return { ...settings, baseCurrency: nextBase, rates };
};

type CbuRate = { Ccy?: string; Nominal?: string | number; Rate?: string | number; Date?: string };

export async function fetchOfficialCurrencyRates(baseCurrency: string): Promise<CurrencySettings> {
  const response = await fetch('https://cbu.uz/ru/arkhiv-kursov-valyut/json/');
  if (!response.ok) throw new Error(`CBU HTTP ${response.status}`);
  const data = await response.json() as CbuRate[];
  const uzsRates: Record<string, number> = { UZS: 1 };
  for (const item of data) {
    const currency = item.Ccy?.toUpperCase();
    const nominal = Number(String(item.Nominal ?? 1).replace(',', '.'));
    const rate = Number(String(item.Rate ?? 0).replace(/\s/g, '').replace(',', '.'));
    if (currency && nominal > 0 && rate > 0) uzsRates[currency] = rate / nominal;
  }
  const baseInUzs = uzsRates[baseCurrency];
  if (!baseInUzs) throw new Error(`ЦБ не вернул курс ${baseCurrency}`);
  const rates = Object.fromEntries(Object.entries(uzsRates).map(([currency, value]) => [currency, value / baseInUzs]));
  rates[baseCurrency] = 1;
  return { baseCurrency, rates, lastUpdated: new Date().toISOString(), source: 'cbu', autoUpdate: true };
}
