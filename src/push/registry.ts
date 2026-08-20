import { ParsedTransaction } from '../parsing/types';
import { PushParser } from './types';
import { sberbankParser } from './parsers/sberbank';

// Filled in per-bank as real notification samples are collected — one file per bank under
// parsers/, no universal format, added here by package id. Still missing: Alfa-Bank, Tinkoff,
// Ozon Bank (see BACKLOG.md R-02).
const PARSERS: PushParser[] = [sberbankParser];

export function parsersForPackage(packageName: string): PushParser[] {
  return PARSERS.filter((parser) => parser.packages.includes(packageName));
}

// Same contract as src/sms/registry.ts's parseSms: null both for an unknown package and for a
// known one whose format doesn't match — the caller must fall back to an "unrecognized" draft,
// never guess at an amount.
export function parsePush(packageName: string, title: string, text: string): { parserId: string; parsed: ParsedTransaction } | null {
  for (const parser of parsersForPackage(packageName)) {
    const parsed = parser.parse(title, text);
    if (parsed) return { parserId: parser.id, parsed };
  }
  return null;
}
