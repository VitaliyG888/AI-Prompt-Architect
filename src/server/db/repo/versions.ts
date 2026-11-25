/** Репозиторий версий итогового промта. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, getRow, parseJson, run, str } from '../rows.ts';
import { parseQuality } from './sections.ts';
import type { QualityReport } from '../../domain/types.ts';

export interface VersionRecord {
  id: string;
  projectId: string;
  label: string;
  prompt: string;
  quality: QualityReport | null;
  meta: Record<string, unknown>;
  createdAt: string;
}

function toVersion(row: Record<string, unknown>): VersionRecord {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    label: str(row, 'label'),
    prompt: str(row, 'prompt'),
    quality: parseQuality(row.quality),
    meta: parseJson(row.meta, {}),
    createdAt: str(row, 'created_at'),
  };
}

export class VersionRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: {
    projectId: string;
    label: string;
    prompt: string;
    quality?: QualityReport | null;
    meta?: Record<string, unknown>;
  }): VersionRecord {
    const id = newId('ver');
    run(
      this.db,
      `INSERT INTO versions (id, project_id, label, prompt, quality, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.label,
      input.prompt,
      JSON.stringify(input.quality ?? null),
      JSON.stringify(input.meta ?? {}),
      nowIso(),
    );
    return this.get(id);
  }

  get(id: string): VersionRecord {
    const row = getRow(this.db, 'SELECT * FROM versions WHERE id = ?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Версия не найдена');
    return toVersion(row);
  }

  list(projectId: string): VersionRecord[] {
    // created_at имеет миллисекундную точность: при сборке нескольких версий
    // подряд метки совпадают. rowid как вторичный ключ сохраняет порядок вставки.
    return allRows(
      this.db,
      'SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC',
      projectId,
    ).map(toVersion);
  }

  latest(projectId: string): VersionRecord | null {
    const row = getRow(
      this.db,
      'SELECT * FROM versions WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      projectId,
    );
    return row ? toVersion(row) : null;
  }
}
