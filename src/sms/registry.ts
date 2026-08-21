import { ParsedSms, SmsParser } from './types';
import { kapitalbankParser } from './parsers/kapitalbank';
import { p13131Parser } from './parsers/p13131';
import { sberbankSmsParser } from './parsers/sberbank';

// New bank format = one new file under parsers/ + one line here. Existing parsers are never
// touched, and a parser only ever runs against the senders it explicitly declares.
const PARSERS: SmsParser[] = [kapitalbankParser, p13131Parser, sberbankSmsParser];

const normalizeSender = (sender: string) => sender.trim().toLowerCase();

export function parsersForSender(sender: string): SmsParser[] {
  const normalized = normalizeSender(sender);
  return PARSERS.filter((parser) => parser.senders.some((candidate) => normalizeSender(candidate) === normalized));
}

// Returns null both when the sender is unknown and when every matching parser fails to make
// sense of the body — either way the caller must fall back to an "unrecognized" draft, never a
// guess at the amount.
export function parseSms(sender: string, body: string): { parserId: string; parsed: ParsedSms } | null {
  for (const parser of parsersForSender(sender)) {
    const parsed = parser.parse(body);
    if (parsed) return { parserId: parser.id, parsed };
  }
  return null;
}
