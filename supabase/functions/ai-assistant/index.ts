// Supabase Edge Function: proxies chat turns to Anthropic's Claude API for the "Афина" AI
// assistant. Holds the Anthropic API key (never in the client bundle), owns the model/system
// prompt/tool definitions/limits (client cannot override any of them), and enforces per-user rate
// limiting via a usage-log table only this function's service-role client can read/write.
//
// The client executes every tool call against local SQLite (see src/ai/loop.ts) -- this function
// never reads the user's financial data from Postgres. See docs/ai-assistant/anthropic-design.md
// for the full rationale and contract.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { TOOLS, TOOLSET_VERSION } from './tools.ts';

const PROTOCOL_VERSION = 1;
const ANTHROPIC_MODEL = 'claude-sonnet-5';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 4096;
const MAX_ASSISTANT_TURNS = 8;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const RATE_LIMIT_PER_HOUR = 30;
const RATE_LIMIT_PER_DAY = 200;

// Only these content-block shapes are ever accepted from the client -- no image/document blocks,
// so this endpoint stays useless as a general-purpose Claude/vision proxy even if someone
// extracts how to call it directly from a decompiled APK.
const ALLOWED_BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

const SYSTEM_PROMPT = `Вы — Афина, финансовый помощник в одноимённом приложении личных финансов. Обращайтесь к пользователю на «вы», нейтрально-деловым тоном.

Правила:
- Никогда не вычисляйте и не оценивайте суммы самостоятельно — всегда вызывайте подходящий тул (summarize_spending, project_balance и т.п.) и сообщайте именно то, что он вернул.
- Всегда явно называйте валюту рядом с любой суммой.
- Любое действие, которое создаёт запись (доход, расход, перевод, долг, план, разделение счёта), выполняется ТОЛЬКО через propose_*-тулы. Вы никогда не создаёте и не изменяете записи напрямую — пользователь подтверждает предложение в приложении.
- Если вы не уверены в id счёта или долга, вызовите read-тул, чтобы уточнить, а не угадывайте.
- Для propose_bill_split: если пользователь не назвал конкретную сумму для участника явно, оставьте его amount пустым — приложение само разделит остаток равными долями. Не считайте доли самостоятельно.
- Если данных не хватает или курс валюты недоступен, скажите об этом прямо, а не придумывайте число.`;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function errorResponse(code: string, message: string, status: number) {
  return jsonResponse({ error: { code, message } }, status);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return errorResponse('bad_protocol', 'Только POST.', 405);

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!anthropicKey || !supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse('misconfigured', 'Помощник временно недоступен: не настроен сервер.', 500);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return errorResponse('unauthenticated', 'Требуется вход в приложение.', 401);

  const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  if (userError || !userData?.user) return errorResponse('unauthenticated', 'Требуется вход в приложение.', 401);
  const userId = userData.user.id;

  const rawBody = await req.text();
  if (rawBody.length > MAX_BODY_BYTES) return errorResponse('payload_too_large', 'Слишком большой запрос.', 400);

  let body: { protocolVersion?: number; context?: Record<string, unknown>; messages?: { role: string; content: unknown }[] };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse('bad_protocol', 'Некорректный запрос.', 400);
  }

  if (body.protocolVersion !== PROTOCOL_VERSION) return errorResponse('bad_protocol', 'Версия протокола не поддерживается — обновите приложение.', 400);
  if (!body.context || JSON.stringify(body.context).length > MAX_CONTEXT_BYTES) return errorResponse('payload_too_large', 'Слишком большой контекст.', 400);
  if (!Array.isArray(body.messages) || !body.messages.length) return errorResponse('bad_protocol', 'Пустой диалог.', 400);

  const assistantTurns = body.messages.filter((message) => message.role === 'assistant').length;
  if (assistantTurns > MAX_ASSISTANT_TURNS) return errorResponse('turn_limit', 'Слишком много шагов в одном вопросе — попробуйте переформулировать.', 400);

  // tool_result.content can itself be an array of blocks per Anthropic's schema (including
  // image blocks) -- checking only top-level message blocks would let an image ride inside a
  // tool_result's nested content and still reach Anthropic, undermining the whole point of this
  // allowlist. Recurse into tool_result content the same way.
  function hasOnlyAllowedBlockTypes(content: unknown): boolean {
    if (typeof content === 'string') return true;
    if (!Array.isArray(content)) return false;
    return content.every((block) => {
      const type = (block as { type?: string })?.type;
      if (!type || !ALLOWED_BLOCK_TYPES.has(type)) return false;
      if (type === 'tool_result') return hasOnlyAllowedBlockTypes((block as { content?: unknown }).content);
      return true;
    });
  }
  for (const message of body.messages) {
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) return errorResponse('bad_protocol', 'Некорректный формат сообщения.', 400);
    if (!hasOnlyAllowedBlockTypes(message.content)) return errorResponse('unsupported_content', 'Этот тип содержимого не поддерживается.', 400);
  }

  // Known, accepted v1 limitation: read-then-write race (two near-simultaneous requests from the
  // same user can both pass the count check before either's log row lands) -- no SELECT ... FOR
  // UPDATE or atomic increment here. Bounded impact (at most a handful of extra concurrent
  // requests per burst, not an amplification vector) against a soft per-user limit on a
  // shared-cost single API key, not a hard security boundary -- acceptable for v1. Revisit with a
  // Postgres advisory lock or atomic counter if real abuse is observed.
  const serviceClient = createClient(supabaseUrl, serviceRoleKey);
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const { count: hourCount } = await serviceClient.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', hourAgo);
  if ((hourCount ?? 0) >= RATE_LIMIT_PER_HOUR) return errorResponse('rate_limited', 'Слишком много запросов за час. Попробуйте позже.', 429);
  const { count: dayCount } = await serviceClient.from('ai_usage_log').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', dayAgo);
  if ((dayCount ?? 0) >= RATE_LIMIT_PER_DAY) return errorResponse('rate_limited', 'Дневной лимит запросов к помощнику исчерпан. Попробуйте завтра.', 429);

  const system = `${SYSTEM_PROMPT}\n\nДанные пользователя (контекст на сейчас): ${JSON.stringify(body.context)}`;

  let anthropicResponse: Response;
  try {
    anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system,
        tools: TOOLS,
        messages: body.messages,
      }),
    });
  } catch {
    return errorResponse('upstream_error', 'Не удалось связаться с помощником. Попробуйте ещё раз.', 502);
  }

  const anthropicJson = await anthropicResponse.json().catch(() => null);
  if (!anthropicResponse.ok || !anthropicJson) {
    await serviceClient.from('ai_usage_log').insert({ user_id: userId, model: ANTHROPIC_MODEL, outcome: 'upstream_error' });
    return errorResponse('upstream_error', 'Помощник не смог ответить. Попробуйте ещё раз.', 502);
  }

  const usage = anthropicJson.usage ?? {};
  await serviceClient.from('ai_usage_log').insert({
    user_id: userId, model: ANTHROPIC_MODEL, outcome: 'ok',
    input_tokens: usage.input_tokens ?? null, output_tokens: usage.output_tokens ?? null,
  });

  return jsonResponse({
    protocolVersion: PROTOCOL_VERSION,
    toolsetVersion: TOOLSET_VERSION,
    stopReason: anthropicJson.stop_reason,
    content: anthropicJson.content,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens,
    },
  });
});
