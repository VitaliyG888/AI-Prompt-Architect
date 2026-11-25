/** Репозиторий проектов. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, getRow, parseJson, run, str } from '../rows.ts';
import type { ProjectMode, ProjectRecord, ProjectStage, ProjectStatus } from '../../domain/types.ts';

export interface CreateProjectInput {
  title: string;
  idea: string;
  mode: ProjectMode;
  audience?: string;
  targetModel?: string;
}

function toProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: str(row, 'id'),
    title: str(row, 'title'),
    idea: str(row, 'idea'),
    mode: str(row, 'mode', 'professional') as ProjectMode,
    status: str(row, 'status', 'draft') as ProjectStatus,
    stage: str(row, 'stage', 'intake') as ProjectStage,
    audience: str(row, 'audience'),
    targetModel: str(row, 'target_model'),
    providerSnapshot: parseJson(row.provider_snapshot, {}),
    settings: parseJson(row.settings, {}),
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export class ProjectRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: CreateProjectInput): ProjectRecord {
    const id = newId('prj');
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO projects (id, title, idea, mode, status, stage, audience, target_model, provider_snapshot, settings, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'draft', 'intake', ?, ?, '{}', '{}', ?, ?)`,
      id,
      input.title,
      input.idea,
      input.mode,
      input.audience ?? '',
      input.targetModel ?? '',
      now,
      now,
    );
    return this.get(id);
  }

  get(id: string): ProjectRecord {
    const row = getRow(this.db, 'SELECT * FROM projects WHERE id = ?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Проект не найден');
    return toProject(row);
  }

  find(id: string): ProjectRecord | null {
    const row = getRow(this.db, 'SELECT * FROM projects WHERE id = ?', id);
    return row ? toProject(row) : null;
  }

  list(): Array<ProjectRecord & { progress: number; sectionsTotal: number; sectionsReady: number }> {
    const rows = allRows(
      this.db,
      `SELECT p.*,
              (SELECT COUNT(*) FROM sections s WHERE s.project_id = p.id) AS sections_total,
              (SELECT COUNT(*) FROM sections s WHERE s.project_id = p.id AND s.status = 'ready') AS sections_ready
         FROM projects p
        ORDER BY p.updated_at DESC`,
    );
    return rows.map((row) => {
      const total = Number(row.sections_total ?? 0);
      const ready = Number(row.sections_ready ?? 0);
      return {
        ...toProject(row),
        sectionsTotal: total,
        sectionsReady: ready,
        progress: total === 0 ? 0 : Math.round((ready / total) * 100),
      };
    });
  }

  update(
    id: string,
    patch: Partial<Pick<ProjectRecord, 'title' | 'idea' | 'mode' | 'status' | 'stage' | 'audience' | 'targetModel'>> & {
      settings?: Record<string, unknown>;
      providerSnapshot?: Record<string, unknown>;
    },
  ): ProjectRecord {
    const existing = this.get(id);
    // undefined означает «поле не передано», а не «очистить»: иначе PATCH
    // одного поля затирал бы остальные значения NULL-ом.
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as typeof patch;
    const merged = { ...existing, ...defined };
    run(
      this.db,
      `UPDATE projects SET title = ?, idea = ?, mode = ?, status = ?, stage = ?, audience = ?, target_model = ?,
              provider_snapshot = ?, settings = ?, updated_at = ?
        WHERE id = ?`,
      merged.title,
      merged.idea,
      merged.mode,
      merged.status,
      merged.stage,
      merged.audience,
      merged.targetModel,
      JSON.stringify(patch.providerSnapshot ?? existing.providerSnapshot),
      JSON.stringify(patch.settings ?? existing.settings),
      nowIso(),
      id,
    );
    return this.get(id);
  }

  touch(id: string): void {
    run(this.db, 'UPDATE projects SET updated_at = ? WHERE id = ?', nowIso(), id);
  }

  remove(id: string): void {
    this.get(id);
    run(this.db, 'DELETE FROM projects WHERE id = ?', id);
  }

  count(): number {
    const row = getRow(this.db, 'SELECT COUNT(*) AS c FROM projects');
    return Number(row?.c ?? 0);
  }
}
