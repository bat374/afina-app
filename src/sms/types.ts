// Pure parsing types — no React Native / native imports here. Keeps this module runnable and
// unit-testable from plain Node/tsc, independent of whether the native SMS reader exists yet.
import { ParsedTransaction } from '../parsing/types';

// Kept as its own name for readability at SMS call sites; identical shape to the push side (see
// src/parsing/types.ts) so createImportDraft/dedup/confirm never need to know which channel a
// parse came from.
export type ParsedSms = ParsedTransaction;

export type SmsParser = {
  id: string;
  // Sender ids this parser applies to (e.g. "kapitalbank", "13131"), matched exactly against the
  // normalized sender the registry is given — a parser never runs against a sender it doesn't own.
  senders: string[];
  parse: (body: string) => ParsedSms | null;
};
