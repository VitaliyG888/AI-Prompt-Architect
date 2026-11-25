/** Репозиторий LLM-провайдеров. Ключи хранятся только в зашифрованном виде. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, bool, getRow, num, parseJson, run, str } from '../rows.ts';
import { decryptSecret, encryptSecret, maskSecret } from '../../core/crypto.ts';

export const PROVIDER_TYPES = ['openai', 'anthropic', 'google', 'openrouter', 'omniroute', 'custom'] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const API_PROTOCOLS = ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini'] as const;
export type ApiProtocol = (typeof API_PROTOCOLS)[number];

export interface ProviderRecord {
  id: string;
  name: string;
  type: ProviderType;
  protocol: ApiProtocol;
  baseUrl: string;
  apiKeyEnc: string;
  defaultModel: string;
  customHeaders: Record<string, string>;
  organizationId: string;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  extra: Record<string, unknown>;
  lastCheck: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Безопасное представление провайдера для клиента: без ключа. */
export interface PublicProvider {
  id: string;
  name: string;
  type: ProviderType;
  protocol: ApiProtocol;
  baseUrl: string;
  defaultModel: string;
  customHeaders: Record<string, string>;
  organizationId: string;
  timeoutMs: number;
  maxRetries: number;
  enabled: boolean;
  extra: Record<string, unknown>;
  lastCheck: Record<string, unknown>;
  hasApiKey: boolean;
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

function toProvider(row: Record<string, unknown>): ProviderRecord {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    type: str(row, 'type', 'custom') as ProviderType,
    protocol: str(row, 'protocol', 'openai-chat') as ApiProtocol,
    baseUrl: str(row, 'base_url'),
    apiKeyEnc: str(row, 'api_key_enc'),
    defaultModel: str(row, 'default_model'),
    customHeaders: parseJson(row.custom_headers, {}),
    organizationId: str(row, 'organization_id'),
    timeoutMs: num(row, 'timeout_ms', 120000),
    maxRetries: num(row, 'max_retries', 2),
    enabled: bool(row, 'enabled', true),
    extra: parseJson(row.extra, {}),
    lastCheck: parseJson(row.last_check, {}),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toPublicProvider(provider: ProviderRecord): PublicProvider {
  let masked = '';
  let hasKey = false;
  if (provider.apiKeyEnc) {
    hasKey = true;
    try {
      masked = maskSecret(decryptSecret(provider.apiKeyEnc));
    } catch {
      masked = '••••';
    }
  }
  const { apiKeyEnc: _omit, ...rest } = provider;
  return { ...rest, hasApiKey: hasKey, apiKeyMasked: masked };
}

export interface ProviderInput {
  name: string;
  type: ProviderType;
  protocol: ApiProtocol;
  baseUrl: string;
  defaultModel?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  organizationId?: string;
  timeoutMs?: number;
  maxRetries?: number;
  enabled?: boolean;
  extra?: Record<string, unknown>;
}

export class ProviderRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: ProviderInput): ProviderRecord {
    const id = newId('prv');
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO providers (id, name, type, protocol, base_url, api_key_enc, default_model, custom_headers,
                              organization_id, timeout_ms, max_retries, enabled, extra, last_check, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
      id,
      input.name,
      input.type,
      input.protocol,
      input.baseUrl.replace(/\/+$/, ''),
      input.apiKey ? encryptSecret(input.apiKey) : '',
      input.defaultModel ?? '',
      JSON.stringify(input.customHeaders ?? {}),
      input.organizationId ?? '',
      input.timeoutMs ?? 120000,
      input.maxRetries ?? 2,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.extra ?? {}),
      now,
      now,
    );
    return this.get(id);
  }

  get(id: string): ProviderRecord {
    const row = getRow(this.db, 'SELECT * FROM providers WHERE id = ?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Провайдер не найден');
    return toProvider(row);
  }

  find(id: string): ProviderRecord | null {
    const row = getRow(this.db, 'SELECT * FROM providers WHERE id = ?', id);
    return row ? toProvider(row) : null;
  }

  list(): ProviderRecord[] {
    return allRows(this.db, 'SELECT * FROM providers ORDER BY created_at ASC').map(toProvider);
  }

  update(id: string, patch: Partial<Omit<ProviderInput, 'apiKey'>> & { apiKey?: string | null }): ProviderRecord {
    const existing = this.get(id);
    const apiKeyEnc =
      patch.apiKey === undefined
        ? existing.apiKeyEnc
        : patch.apiKey === null || patch.apiKey === ''
          ? ''
          : encryptSecret(patch.apiKey);

    run(
      this.db,
      `UPDATE providers SET name = ?, type = ?, protocol = ?, base_url = ?, api_key_enc = ?, default_model = ?,
              custom_headers = ?, organization_id = ?, timeout_ms = ?, max_retries = ?, enabled = ?, extra = ?, updated_at = ?
        WHERE id = ?`,
      patch.name ?? existing.name,
      patch.type ?? existing.type,
      patch.protocol ?? existing.protocol,
      (patch.baseUrl ?? existing.baseUrl).replace(/\/+$/, ''),
      apiKeyEnc,
      patch.defaultModel ?? existing.defaultModel,
      JSON.stringify(patch.customHeaders ?? existing.customHeaders),
      patch.organizationId ?? existing.organizationId,
      patch.timeoutMs ?? existing.timeoutMs,
      patch.maxRetries ?? existing.maxRetries,
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      JSON.stringify(patch.extra ?? existing.extra),
      nowIso(),
      id,
    );
    return this.get(id);
  }

  setLastCheck(id: string, check: Record<string, unknown>): void {
    run(this.db, 'UPDATE providers SET last_check = ? WHERE id = ?', JSON.stringify(check), id);
  }

  remove(id: string): void {
    this.get(id);
    run(this.db, 'DELETE FROM providers WHERE id = ?', id);
  }

  /** Возвращает расшифрованный ключ только для серверных вызовов. */
  apiKey(id: string): string {
    const provider = this.get(id);
    if (!provider.apiKeyEnc) return '';
    return decryptSecret(provider.apiKeyEnc);
  }
}
