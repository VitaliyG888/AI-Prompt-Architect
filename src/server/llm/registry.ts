/** Реестр адаптеров протоколов. Единственное место, где протокол → реализация. */
import type { Adapter, Capabilities } from './types.ts';
import { openaiChatAdapter } from './adapters/openai-chat.ts';
import { openaiResponsesAdapter } from './adapters/openai-responses.ts';
import { anthropicAdapter } from './adapters/anthropic.ts';
import { geminiAdapter } from './adapters/gemini.ts';
import { AppError } from '../core/errors.ts';

const adapters = new Map<string, Adapter>([
  [openaiChatAdapter.protocol, openaiChatAdapter],
  [openaiResponsesAdapter.protocol, openaiResponsesAdapter],
  [anthropicAdapter.protocol, anthropicAdapter],
  [geminiAdapter.protocol, geminiAdapter],
]);

export const SUPPORTED_PROTOCOLS = [...adapters.keys()];

export function getAdapter(protocol: string): Adapter {
  const adapter = adapters.get(protocol);
  if (!adapter) {
    throw new AppError(
      'UNSUPPORTED_PROTOCOL',
      `Протокол "${protocol}" не поддерживается. Доступны: ${SUPPORTED_PROTOCOLS.join(', ')}`,
    );
  }
  return adapter;
}

export function adapterCapabilities(protocol: string): Capabilities {
  return getAdapter(protocol).capabilities;
}

export function registerAdapter(adapter: Adapter): void {
  adapters.set(adapter.protocol, adapter);
}

/** Публичное описание протоколов и их возможностей для интерфейса. */
export function protocolCatalog(): Array<{
  protocol: string;
  label: string;
  capabilities: Capabilities;
}> {
  return [...adapters.values()].map((adapter) => ({
    protocol: adapter.protocol,
    label: adapter.label,
    capabilities: adapter.capabilities,
  }));
}
