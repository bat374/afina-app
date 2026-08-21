import { supabase } from '../supabase';
import { AssistantContext, AssistantRequest, AssistantRequestMessage, AssistantResponse, PROTOCOL_VERSION } from './protocol';

const ERROR_MESSAGES: Record<string, string> = {
  unauthenticated: 'Нужно войти в приложение, чтобы использовать помощника.',
  rate_limited: 'Слишком много запросов. Попробуйте немного позже.',
  turn_limit: 'Слишком много шагов в этом вопросе — попробуйте переформулировать.',
  payload_too_large: 'Слишком большой запрос к помощнику.',
  unsupported_content: 'Этот тип содержимого помощник пока не поддерживает.',
  bad_protocol: 'Приложение устарело — обновите Афину, чтобы продолжить пользоваться помощником.',
  upstream_error: 'Помощник не смог ответить. Попробуйте ещё раз.',
  misconfigured: 'Помощник временно недоступен.',
  network: 'Нет связи с помощником — проверьте подключение к интернету.',
};

export class AssistantError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function sendAssistantTurn(context: AssistantContext, messages: AssistantRequestMessage[]): Promise<AssistantResponse & { error?: undefined }> {
  if (!supabase) throw new AssistantError('misconfigured', ERROR_MESSAGES.misconfigured!);
  const request: AssistantRequest = { protocolVersion: PROTOCOL_VERSION, context, messages };
  const { data, error } = await supabase.functions.invoke<AssistantResponse>('ai-assistant', { body: request });
  if (error) throw new AssistantError('network', ERROR_MESSAGES.network!);
  if (!data) throw new AssistantError('upstream_error', ERROR_MESSAGES.upstream_error!);
  if ('error' in data && data.error) throw new AssistantError(data.error.code, ERROR_MESSAGES[data.error.code] ?? data.error.message);
  return data as AssistantResponse & { error?: undefined };
}
