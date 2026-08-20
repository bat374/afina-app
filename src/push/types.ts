import { ParsedTransaction } from '../parsing/types';

export type PushParser = {
  id: string;
  // Android package ids this parser applies to — matched exactly, never a substring/prefix.
  packages: string[];
  parse: (title: string, text: string) => ParsedTransaction | null;
};
