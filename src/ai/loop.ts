import { appendAiChatMessage, createAiProposals, listAiChatMessages } from '../database';
import { AiContentBlock } from '../types';
import { sendAssistantTurn } from './client';
import { buildAssistantContext } from './context';
import { executeTool } from './tools';

// Mirrors the server's own MAX_ASSISTANT_TURNS cap (supabase/functions/ai-assistant/index.ts) --
// a client-side cap alone isn't a real control (see that file's comment), but it keeps a single
// runaway question from hammering the network before the server even gets a chance to reject it.
const MAX_ITERATIONS = 6;

export type AssistantTurnResult = { replyText: string; proposalsCreated: number };

// Sends one user message and drives the tool-call loop to completion: executes every tool call
// on-device against local SQLite (never on the server -- see docs/ai-assistant/anthropic-design.md),
// persists every raw content block verbatim (never reparsed/reserialized, per Anthropic's own
// multi-turn tool-use contract), and turns any write-tool call into a pending ai_proposal instead
// of ever touching the database directly.
export async function sendUserMessage(text: string): Promise<AssistantTurnResult> {
  await appendAiChatMessage('user', [{ type: 'text', text }]);
  return runLoop();
}

async function runLoop(): Promise<AssistantTurnResult> {
  let proposalsCreated = 0;
  let replyText = '';
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const history = await listAiChatMessages();
    const context = await buildAssistantContext();
    const messages = history.map((message) => ({ role: message.role, content: message.content }));
    const response = await sendAssistantTurn(context, messages);
    const assistantMessage = await appendAiChatMessage('assistant', response.content);
    const textBlocks = response.content.filter((block) => block.type === 'text') as { type: 'text'; text: string }[];
    if (textBlocks.length) replyText = textBlocks.map((block) => block.text).join('\n');
    if (response.stopReason !== 'tool_use') break;
    const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }[];
    if (!toolUseBlocks.length) break;
    // Executed sequentially, not Promise.all -- every tool call goes through the single shared
    // SQLite connection (see enqueue() in src/database.ts), and the system prompt also tells the
    // model to avoid firing genuinely independent calls in parallel for this reason.
    const toolResults: AiContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const result = await executeTool(block.name, block.input);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result.resultText });
      if (result.proposal) {
        await createAiProposals(assistantMessage.id, assistantMessage.id, [{ toolUseId: block.id, kind: result.proposal.kind, payload: result.proposal.payload }]);
        proposalsCreated += 1;
      }
    }
    await appendAiChatMessage('user', toolResults);
  }
  return { replyText, proposalsCreated };
}
