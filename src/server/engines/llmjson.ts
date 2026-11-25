/**
 * Обёртка над LLMClient для операций, где нужен строгий JSON.
 *
 * Поведение: один запрос; при ошибке разбора — одна попытка «починить»
 * ответ с явной инструкцией. Ошибки провайдера не маскируются.
 */
import type { LLMClient } from '../llm/client.ts';
import type { Operation } from '../db/repo/routes.ts';
import type { ChatMessage, GenerationParams } from '../llm/types.ts';
import { parseLooseJson } from '../core/json.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';

export interface CallJsonInput<T> {
  operation: Operation;
  messages: ChatMessage[];
  expect: 'object' | 'array' | 'any';
  projectId?: string;
  params?: GenerationParams;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  override?: { providerId: string; model: string };
  /** Дополнительная валидация после разбора. */
  validate?: (value: T) => T;
}

export interface CallJsonResult<T> {
  data: T;
  providerName: string;
  model: string;
  fallbackUsed: boolean;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
  attempts: number;
}

const REPAIR_INSTRUCTION =
  'Предыдущий ответ не удалось разобрать как JSON. Верни ТОЛЬКО валидный JSON без пояснений, без markdown-обёртки и без текста до или после него.';

export async function callJson<T>(client: LLMClient, input: CallJsonInput<T>): Promise<CallJsonResult<T>> {
  const attempt = async (
    messages: ChatMessage[],
    attemptNo: number,
  ): Promise<CallJsonResult<T>> => {
    const response = await client.call({
      operation: input.operation,
      messages,
      json: true,
      projectId: input.projectId,
      params: input.params,
      maxOutputTokens: input.maxOutputTokens,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      override: input.override,
    });

    try {
      let parsed = parseLooseJson<T>(response.text, { expect: input.expect });
      if (input.validate) parsed = input.validate(parsed);
      return {
        data: parsed,
        providerName: response.route.providerName,
        model: response.route.model,
        fallbackUsed: response.route.fallbackUsed,
        usage: response.usage,
        attempts: attemptNo,
      };
    } catch (error) {
      const appError = toAppError(error);
      if (attemptNo >= 2) {
        log.error('json parse failed twice', { code: appError.code, snippet: response.text.slice(0, 300) });
        throw new AppError('VALIDATION_FAILED', 'Модель не вернула корректный JSON после повторной попытки', {
          details: { hint: 'Попробуйте другую модель в Settings → Model Routing' },
        });
      }
      log.warn('json parse failed, retrying with repair instruction', { code: appError.code });
      return attempt([...messages, { role: 'assistant', content: response.text.slice(0, 4000) }, { role: 'user', content: REPAIR_INSTRUCTION }], attemptNo + 1);
    }
  };

  return attempt(input.messages, 1);
}

/** Текстовый вызов без JSON-контракта (например, для свободного ответа в тестах). */
export async function callText(
  client: LLMClient,
  input: Omit<CallJsonInput<unknown>, 'expect' | 'validate'>,
): Promise<{ text: string; model: string; providerName: string }> {
  const response = await client.call({
    operation: input.operation,
    messages: input.messages,
    projectId: input.projectId,
    params: input.params,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
    override: input.override,
  });
  return { text: response.text, model: response.route.model, providerName: response.route.providerName };
}
