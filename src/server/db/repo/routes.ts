/** Репозиторий маршрутизации операций на провайдеров и модели. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { allRows, bool, getRow, parseJson, run, str } from '../rows.ts';

export const OPERATIONS = [
  'interview',
  'answer_analysis',
  'question_planning',
  'research_queries',
  'source_analysis',
  'example_comparison',
  'section_synthesis',
  'quality_check',
  'final_assembly',
  'test_generation',
  'test_evaluation',
] as const;

export type Operation = (typeof OPERATIONS)[number];

export const OPERATION_LABELS: Record<Operation, string> = {
  interview: 'Основное интервью',
  answer_analysis: 'Анализ ответов',
  question_planning: 'Планирование вопросов',
  research_queries: 'Формирование поисковых запросов',
  source_analysis: 'Анализ найденных источников',
  example_comparison: 'Сравнение примеров',
  section_synthesis: 'Синтез разделов',
  quality_check: 'Контроль качества',
  final_assembly: 'Финальная сборка',
  test_generation: 'Генерация тестов',
  test_evaluation: 'Оценка результатов тестирования',
};

export interface GenerationParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  reasoningEffort?: string;
}

export interface RouteRecord {
  id: string;
  operation: Operation;
  providerId: string | null;
  model: string;
  params: GenerationParams;
  fallbackProviderId: string | null;
  fallbackModel: string;
  useFallback: boolean;
  updatedAt: string;
}

function toRoute(row: Record<string, unknown>): RouteRecord {
  return {
    id: str(row, 'id'),
    operation: str(row, 'operation') as Operation,
    providerId: (row.provider_id as string | null) ?? null,
    model: str(row, 'model'),
    params: parseJson(row.params, {}),
    fallbackProviderId: (row.fallback_provider_id as string | null) ?? null,
    fallbackModel: str(row, 'fallback_model'),
    useFallback: bool(row, 'use_fallback', false),
    updatedAt: str(row, 'updated_at'),
  };
}

export class RouteRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  list(): RouteRecord[] {
    return allRows(this.db, 'SELECT * FROM routes ORDER BY operation ASC').map(toRoute);
  }

  get(operation: Operation): RouteRecord | null {
    const row = getRow(this.db, 'SELECT * FROM routes WHERE operation = ?', operation);
    return row ? toRoute(row) : null;
  }

  upsert(
    operation: Operation,
    patch: Partial<Omit<RouteRecord, 'id' | 'operation' | 'updatedAt'>>,
  ): RouteRecord {
    const existing = this.get(operation);
    const now = nowIso();
    if (existing) {
      run(
        this.db,
        `UPDATE routes SET provider_id = ?, model = ?, params = ?, fallback_provider_id = ?, fallback_model = ?,
                use_fallback = ?, updated_at = ? WHERE operation = ?`,
        patch.providerId !== undefined ? patch.providerId : existing.providerId,
        patch.model !== undefined ? patch.model : existing.model,
        JSON.stringify(patch.params !== undefined ? patch.params : existing.params),
        patch.fallbackProviderId !== undefined ? patch.fallbackProviderId : existing.fallbackProviderId,
        patch.fallbackModel !== undefined ? patch.fallbackModel : existing.fallbackModel,
        (patch.useFallback !== undefined ? patch.useFallback : existing.useFallback) ? 1 : 0,
        now,
        operation,
      );
    } else {
      run(
        this.db,
        `INSERT INTO routes (id, operation, provider_id, model, params, fallback_provider_id, fallback_model, use_fallback, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('rte'),
        operation,
        patch.providerId ?? null,
        patch.model ?? '',
        JSON.stringify(patch.params ?? {}),
        patch.fallbackProviderId ?? null,
        patch.fallbackModel ?? '',
        patch.useFallback ? 1 : 0,
        now,
      );
    }
    return this.get(operation)!;
  }

  remove(operation: Operation): void {
    run(this.db, 'DELETE FROM routes WHERE operation = ?', operation);
  }
}
