/** Репозиторий поисковых провайдеров. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, bool, getRow, parseJson, run, str } from '../rows.ts';
import { decryptSecret, encryptSecret, maskSecret } from '../../core/crypto.ts';

export const SEARCH_TYPES = ['tavily', 'brave', 'serpapi', 'google-cse', 'searxng', 'custom'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchProviderRecord {
  id: string;
  name: string;
  type: SearchType;
  baseUrl: string;
  apiKeyEnc: string;
  options: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSearchProvider {
  id: string;
  name: string;
  type: SearchType;
  baseUrl: string;
  options: Record<string, unknown>;
  enabled: boolean;
  hasApiKey: boolean;
  apiKeyMasked: string;
  createdAt: string;
  updatedAt: string;
}

function toRecord(row: Record<string, unknown>): SearchProviderRecord {
  return {
    id: str(row, 'id'),
    name: str(row, 'name'),
    type: str(row, 'type', 'tavily') as SearchType,
    baseUrl: str(row, 'base_url'),
    apiKeyEnc: str(row, 'api_key_enc'),
    options: parseJson(row.options, {}),
    enabled: bool(row, 'enabled', true),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function toPublicSearch(record: SearchProviderRecord): PublicSearchProvider {
  let masked = '';
  let hasKey = false;
  if (record.apiKeyEnc) {
    hasKey = true;
    try {
      masked = maskSecret(decryptSecret(record.apiKeyEnc));
    } catch {
      masked = '••••';
    }
  }
  const { apiKeyEnc: _omit, ...rest } = record;
  return { ...rest, hasApiKey: hasKey, apiKeyMasked: masked };
}

export interface SearchProviderInput {
  name: string;
  type: SearchType;
  baseUrl?: string;
  apiKey?: string | null;
  options?: Record<string, unknown>;
  enabled?: boolean;
}

export class SearchProviderRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: SearchProviderInput): SearchProviderRecord {
    const id = newId('srp');
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO search_providers (id, name, type, base_url, api_key_enc, options, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.name,
      input.type,
      input.baseUrl ?? '',
      input.apiKey ? encryptSecret(input.apiKey) : '',
      JSON.stringify(input.options ?? {}),
      input.enabled === false ? 0 : 1,
      now,
      now,
    );
    return this.get(id);
  }

  get(id: string): SearchProviderRecord {
    const row = getRow(this.db, 'SELECT * FROM search_providers WHERE id = ?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Поисковый провайдер не найден');
    return toRecord(row);
  }

  list(): SearchProviderRecord[] {
    return allRows(this.db, 'SELECT * FROM search_providers ORDER BY created_at ASC').map(toRecord);
  }

  update(id: string, patch: Partial<SearchProviderInput>): SearchProviderRecord {
    const existing = this.get(id);
    const apiKeyEnc =
      patch.apiKey === undefined
        ? existing.apiKeyEnc
        : patch.apiKey === null || patch.apiKey === ''
          ? ''
          : encryptSecret(patch.apiKey);
    run(
      this.db,
      `UPDATE search_providers SET name = ?, type = ?, base_url = ?, api_key_enc = ?, options = ?, enabled = ?, updated_at = ?
        WHERE id = ?`,
      patch.name ?? existing.name,
      patch.type ?? existing.type,
      patch.baseUrl ?? existing.baseUrl,
      apiKeyEnc,
      JSON.stringify(patch.options ?? existing.options),
      (patch.enabled ?? existing.enabled) ? 1 : 0,
      nowIso(),
      id,
    );
    return this.get(id);
  }

  remove(id: string): void {
    this.get(id);
    run(this.db, 'DELETE FROM search_providers WHERE id = ?', id);
  }

  apiKey(id: string): string {
    const record = this.get(id);
    return record.apiKeyEnc ? decryptSecret(record.apiKeyEnc) : '';
  }
}
