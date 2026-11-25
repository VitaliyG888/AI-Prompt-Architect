/** Репозиторий разделов промта. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, getRow, parseJson, run, str, num } from '../rows.ts';
import type {
  QualityReport,
  SectionKey,
  SectionRecord,
  SectionResearch,
  SectionStatus,
} from '../../domain/types.ts';

const EMPTY_RESEARCH: SectionResearch = {
  status: 'pending',
  queries: [],
  summary: '',
  findings: [],
  sourceIds: [],
  providers: [],
  message: '',
  updatedAt: '',
};

/**
 * Качество хранится как JSON и по умолчанию имеет значение '{}'.
 * Пустой объект — это не отчёт: без такой проверки раздел без оценки вёл бы
 * себя как оценённый (ломая агрегат и экспорт). Возвращаем null.
 */
export function parseQuality(value: unknown): QualityReport | null {
  const parsed = parseJson<unknown>(value, null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.total !== 'number' || !Array.isArray(record.mandatory)) return null;
  return parsed as QualityReport;
}

function toSection(row: Record<string, unknown>): SectionRecord {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    key: str(row, 'section_key') as SectionKey,
    title: str(row, 'title'),
    orderIndex: num(row, 'order_index'),
    status: str(row, 'status', 'not_started') as SectionStatus,
    content: str(row, 'content'),
    summary: str(row, 'summary'),
    requirements: parseJson<string[]>(row.requirements, []),
    openQuestions: parseJson<string[]>(row.open_questions, []),
    research: { ...EMPTY_RESEARCH, ...parseJson<Partial<SectionResearch>>(row.research, {}) },
    quality: parseQuality(row.quality),
    alternatives: parseJson(row.alternatives, []),
    decisions: parseJson(row.decisions, []),
    flags: parseJson<string[]>(row.flags, []),
    updatedAt: str(row, 'updated_at'),
  };
}

export class SectionRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  createMany(projectId: string, sections: Array<{ key: SectionKey; title: string }>): SectionRecord[] {
    const now = nowIso();
    const created: SectionRecord[] = [];
    const stmt = this.db.prepare(
      `INSERT INTO sections (id, project_id, section_key, title, order_index, status, content, summary, requirements,
                             open_questions, research, quality, alternatives, decisions, flags, updated_at)
       VALUES (?, ?, ?, ?, ?, 'not_started', '', '', '[]', '[]', ?, '{}', '[]', '[]', '[]', ?)`,
    );
    sections.forEach((section, index) => {
      stmt.run(
        newId('sec'),
        projectId,
        section.key,
        section.title,
        index,
        JSON.stringify(EMPTY_RESEARCH),
        now,
      );
    });
    const rows = this.list(projectId);
    created.push(...rows);
    return created;
  }

  list(projectId: string): SectionRecord[] {
    return allRows(
      this.db,
      'SELECT * FROM sections WHERE project_id = ? ORDER BY order_index ASC',
      projectId,
    ).map(toSection);
  }

  get(projectId: string, key: SectionKey): SectionRecord {
    const row = getRow(
      this.db,
      'SELECT * FROM sections WHERE project_id = ? AND section_key = ?',
      projectId,
      key,
    );
    if (!row) throw new AppError('NOT_FOUND', `Раздел ${key} не найден`);
    return toSection(row);
  }

  update(
    projectId: string,
    key: SectionKey,
    patch: Partial<{
      status: SectionStatus;
      content: string;
      summary: string;
      requirements: string[];
      openQuestions: string[];
      research: SectionResearch;
      quality: QualityReport | null;
      alternatives: Array<{ label: string; content: string; rationale: string }>;
      decisions: Array<{ question: string; choice: string; source: 'user' | 'ai' | 'research' }>;
      flags: string[];
      title: string;
      orderIndex: number;
    }>,
  ): SectionRecord {
    const existing = this.get(projectId, key);
    const merged = { ...existing, ...patch };
    run(
      this.db,
      `UPDATE sections SET status = ?, content = ?, summary = ?, requirements = ?, open_questions = ?, research = ?,
              quality = ?, alternatives = ?, decisions = ?, flags = ?, title = ?, order_index = ?, updated_at = ?
        WHERE project_id = ? AND section_key = ?`,
      merged.status,
      merged.content,
      merged.summary,
      JSON.stringify(merged.requirements),
      JSON.stringify(merged.openQuestions),
      JSON.stringify(merged.research),
      JSON.stringify(merged.quality),
      JSON.stringify(merged.alternatives),
      JSON.stringify(merged.decisions),
      JSON.stringify(merged.flags),
      merged.title,
      merged.orderIndex,
      nowIso(),
      projectId,
      key,
    );
    return this.get(projectId, key);
  }

  progress(projectId: string): { total: number; ready: number; percent: number } {
    const row = getRow(
      this.db,
      `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready
         FROM sections WHERE project_id = ?`,
      projectId,
    );
    const total = Number(row?.total ?? 0);
    const ready = Number(row?.ready ?? 0);
    return { total, ready, percent: total === 0 ? 0 : Math.round((ready / total) * 100) };
  }
}
