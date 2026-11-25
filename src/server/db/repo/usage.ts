/** Репозиторий учёта использования и расходов. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { allRows, getRow, num, run, str } from '../rows.ts';

export interface UsageEventInput {
  projectId?: string;
  operation: string;
  providerId?: string;
  providerName?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  status?: 'ok' | 'error' | 'cancelled';
  errorCode?: string;
  retries?: number;
  fallbackUsed?: boolean;
}

export interface UsageEvent extends Required<Omit<UsageEventInput, 'projectId'>> {
  id: string;
  projectId: string;
  createdAt: string;
}

function toEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    operation: str(row, 'operation'),
    providerId: str(row, 'provider_id'),
    providerName: str(row, 'provider_name'),
    model: str(row, 'model'),
    inputTokens: num(row, 'input_tokens'),
    outputTokens: num(row, 'output_tokens'),
    durationMs: num(row, 'duration_ms'),
    status: str(row, 'status', 'ok') as UsageEvent['status'],
    errorCode: str(row, 'error_code'),
    retries: num(row, 'retries'),
    fallbackUsed: num(row, 'fallback_used') === 1,
    createdAt: str(row, 'created_at'),
  };
}

export interface UsageSummary {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  avgDurationMs: number;
  byProvider: Array<{ providerName: string; model: string; requests: number; inputTokens: number; outputTokens: number; errors: number }>;
  byOperation: Array<{ operation: string; requests: number; inputTokens: number; outputTokens: number; errors: number }>;
}

export class UsageRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  record(input: UsageEventInput): void {
    run(
      this.db,
      `INSERT INTO usage_events (id, project_id, operation, provider_id, provider_name, model, input_tokens,
                                 output_tokens, duration_ms, status, error_code, retries, fallback_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('usg'),
      input.projectId ?? '',
      input.operation,
      input.providerId ?? '',
      input.providerName ?? '',
      input.model ?? '',
      input.inputTokens ?? 0,
      input.outputTokens ?? 0,
      input.durationMs ?? 0,
      input.status ?? 'ok',
      input.errorCode ?? '',
      input.retries ?? 0,
      input.fallbackUsed ? 1 : 0,
      nowIso(),
    );
  }

  list(limit = 200): UsageEvent[] {
    return allRows(this.db, 'SELECT * FROM usage_events ORDER BY created_at DESC LIMIT ?', limit).map(toEvent);
  }

  summary(sinceIso?: string): UsageSummary {
    const since = sinceIso ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const totals = getRow(
      this.db,
      `SELECT COUNT(*) AS requests,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(AVG(duration_ms), 0) AS avg_duration
         FROM usage_events WHERE created_at >= ?`,
      since,
    );
    const byProvider = allRows(
      this.db,
      `SELECT provider_name, model, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM usage_events WHERE created_at >= ?
        GROUP BY provider_name, model ORDER BY requests DESC LIMIT 50`,
      since,
    ).map((row) => ({
      providerName: str(row, 'provider_name'),
      model: str(row, 'model'),
      requests: num(row, 'requests'),
      inputTokens: num(row, 'input_tokens'),
      outputTokens: num(row, 'output_tokens'),
      errors: num(row, 'errors'),
    }));
    const byOperation = allRows(
      this.db,
      `SELECT operation, COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
         FROM usage_events WHERE created_at >= ?
        GROUP BY operation ORDER BY requests DESC`,
      since,
    ).map((row) => ({
      operation: str(row, 'operation'),
      requests: num(row, 'requests'),
      inputTokens: num(row, 'input_tokens'),
      outputTokens: num(row, 'output_tokens'),
      errors: num(row, 'errors'),
    }));

    return {
      requests: num(totals as Record<string, unknown>, 'requests'),
      errors: num(totals as Record<string, unknown>, 'errors'),
      inputTokens: num(totals as Record<string, unknown>, 'input_tokens'),
      outputTokens: num(totals as Record<string, unknown>, 'output_tokens'),
      avgDurationMs: Math.round(num(totals as Record<string, unknown>, 'avg_duration')),
      byProvider,
      byOperation,
    };
  }
}
