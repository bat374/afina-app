import { AiContentBlock } from '../types';

// Wire contract between the phone and the `ai-assistant` Supabase Edge Function. Kept in its own
// file (not inlined in client.ts) so the shape is easy to diff against the Edge Function's own
// copy (supabase/functions/ai-assistant/protocol.ts) -- the two must always agree exactly, since
// there's no shared package between the Deno function and the RN app in this repo.
export const PROTOCOL_VERSION = 1;

export type AssistantContext = {
  today: string;
  baseCurrency: string;
  rates: Record<string, number>;
  accounts: { id: string; name: string; type: string; balance: number; currency: string; cardLast4?: string }[];
  counts: { operations: number; debts: number; plannedFlows: number; goals: number };
  earliestOperationDate?: string;
};

export type AssistantRequestMessage = { role: 'user' | 'assistant'; content: string | AiContentBlock[] };

export type AssistantRequest = {
  protocolVersion: typeof PROTOCOL_VERSION;
  context: AssistantContext;
  messages: AssistantRequestMessage[];
};

export type AssistantErrorCode =
  | 'unauthenticated' | 'rate_limited' | 'turn_limit' | 'payload_too_large'
  | 'unsupported_content' | 'bad_protocol' | 'upstream_error' | 'misconfigured';

export type AssistantResponse =
  | {
      protocolVersion: typeof PROTOCOL_VERSION;
      toolsetVersion: number;
      stopReason: string;
      content: AiContentBlock[];
      usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number };
    }
  | { error: { code: AssistantErrorCode; message: string } };
