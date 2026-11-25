/** Репозиторий источников исследования. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { allRows, getRow, nullableNum, parseJson, run, str } from '../rows.ts';
import type { SourceAnalysis, SourceRecord } from '../../domain/types.ts';

function toSource(row: Record<string, unknown>): SourceRecord {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    sectionKey: str(row, 'section_key'),
    title: str(row, 'title'),
    url: str(row, 'url'),
    publisher: str(row, 'publisher'),
    publishedAt: str(row, 'published_at'),
    snippet: str(row, 'snippet'),
    query: str(row, 'query'),
    provider: str(row, 'provider'),
    relevance: nullableNum(row, 'relevance'),
    analysis: parseJson<SourceAnalysis | null>(row.analysis, null),
    fetchedAt: str(row, 'fetched_at'),
  };
}

export interface NewSourceInput {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
  snippet?: string;
  query?: string;
  provider?: string;
  relevance?: number | null;
}

export class SourceRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  addMany(projectId: string, sectionKey: string, sources: NewSourceInput[]): SourceRecord[] {
    const now = nowIso();
    const stmt = this.db.prepare(
      `INSERT INTO sources (id, project_id, section_key, title, url, publisher, published_at, snippet, query, provider,
                            relevance, analysis, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)`,
    );
    const ids: string[] = [];
    for (const source of sources) {
      const id = newId('res');
      ids.push(id);
      stmt.run(
        id,
        projectId,
        sectionKey,
        source.title,
        source.url,
        source.publisher ?? '',
        source.publishedAt ?? '',
        source.snippet ?? '',
        source.query ?? '',
        source.provider ?? '',
        source.relevance ?? null,
        now,
      );
    }
    if (ids.length === 0) return [];
    return allRows(
      this.db,
      `SELECT * FROM sources WHERE id IN (${ids.map(() => '?').join(',')})`,
      ...ids,
    ).map(toSource);
  }

  list(projectId: string, sectionKey?: string): SourceRecord[] {
    const rows = sectionKey
      ? allRows(
          this.db,
          'SELECT * FROM sources WHERE project_id = ? AND section_key = ? ORDER BY fetched_at DESC',
          projectId,
          sectionKey,
        )
      : allRows(this.db, 'SELECT * FROM sources WHERE project_id = ? ORDER BY fetched_at DESC', projectId);
    return rows.map(toSource);
  }

  get(projectId: string, id: string): SourceRecord | null {
    const row = getRow(this.db, 'SELECT * FROM sources WHERE id = ? AND project_id = ?', id, projectId);
    return row ? toSource(row) : null;
  }

  setAnalysis(id: string, analysis: SourceAnalysis, relevance: number | null): void {
    run(
      this.db,
      'UPDATE sources SET analysis = ?, relevance = ? WHERE id = ?',
      JSON.stringify(analysis),
      relevance,
      id,
    );
  }

  deleteForSection(projectId: string, sectionKey: string): void {
    run(this.db, 'DELETE FROM sources WHERE project_id = ? AND section_key = ?', projectId, sectionKey);
  }

  dedupeUrls(projectId: string, sectionKey: string): Set<string> {
    const rows = allRows(
      this.db,
      'SELECT url FROM sources WHERE project_id = ? AND section_key = ?',
      projectId,
      sectionKey,
    );
    return new Set(rows.map((row) => str(row, 'url')));
  }
}
