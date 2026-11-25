/** Репозиторий настроек приложения (key-value, JSON-значения). */
import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../../core/ids.ts';
import { allRows, getRow, parseJson, run, str } from '../rows.ts';

export interface AppDefaults {
  mode: 'quick' | 'professional' | 'expert';
  language: string;
  researchEnabled: boolean;
  maxSourcesPerSection: number;
  qualityThreshold: number;
  autoTest: boolean;
}

export const DEFAULT_SETTINGS: AppDefaults = {
  mode: 'professional',
  language: 'ru',
  researchEnabled: true,
  maxSourcesPerSection: 4,
  qualityThreshold: 80,
  autoTest: false,
};

export class SettingsRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  getAll(): Record<string, unknown> {
    const rows = allRows(this.db, 'SELECT key, value FROM app_settings');
    const out: Record<string, unknown> = {};
    for (const row of rows) out[str(row, 'key')] = parseJson(row.value, null);
    return out;
  }

  get<T>(key: string, fallback: T): T {
    const row = getRow(this.db, 'SELECT value FROM app_settings WHERE key = ?', key);
    if (!row) return fallback;
    return parseJson<T>(row.value, fallback);
  }

  set(key: string, value: unknown): void {
    run(
      this.db,
      `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value),
      nowIso(),
    );
  }

  defaults(): AppDefaults {
    const stored = this.get<Partial<AppDefaults>>('defaults', {});
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  saveDefaults(patch: Partial<AppDefaults>): AppDefaults {
    const merged = { ...this.defaults(), ...patch };
    this.set('defaults', merged);
    return merged;
  }
}
