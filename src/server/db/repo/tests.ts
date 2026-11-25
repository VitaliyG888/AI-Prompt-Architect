/** Репозиторий прогонов практического тестирования промта. */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import { allRows, getRow, parseJson, run, str } from '../rows.ts';
import type { TestCase, TestResult } from '../../engines/tester.ts';

export interface TestRunRecord {
  id: string;
  projectId: string;
  versionId: string;
  prompt: string;
  providerName: string;
  model: string;
  status: 'pending' | 'done' | 'failed' | 'not_run';
  cases: TestCase[];
  results: TestResult[];
  verdict: 'pass' | 'revise' | 'not_run' | '';
  createdAt: string;
  finishedAt: string;
}

function toRecord(row: Record<string, unknown>): TestRunRecord {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    versionId: str(row, 'version_id'),
    prompt: str(row, 'prompt'),
    providerName: str(row, 'provider_name'),
    model: str(row, 'model'),
    status: str(row, 'status', 'pending') as TestRunRecord['status'],
    cases: parseJson<TestCase[]>(row.cases, []),
    results: parseJson<TestResult[]>(row.results, []),
    verdict: str(row, 'verdict') as TestRunRecord['verdict'],
    createdAt: str(row, 'created_at'),
    finishedAt: str(row, 'finished_at'),
  };
}

export class TestRunRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  create(input: {
    projectId: string;
    versionId: string;
    prompt: string;
    providerName: string;
    model: string;
    status: TestRunRecord['status'];
    cases: TestCase[];
    results: TestResult[];
    verdict: TestRunRecord['verdict'];
  }): TestRunRecord {
    const id = newId('tst');
    run(
      this.db,
      `INSERT INTO test_runs (id, project_id, version_id, prompt, provider_id, provider_name, model, status,
                              cases, results, verdict, created_at, finished_at)
       VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.versionId,
      input.prompt,
      input.providerName,
      input.model,
      input.status,
      JSON.stringify(input.cases),
      JSON.stringify(input.results),
      input.verdict,
      nowIso(),
      nowIso(),
    );
    return this.get(id);
  }

  get(id: string): TestRunRecord {
    const row = getRow(this.db, 'SELECT * FROM test_runs WHERE id = ?', id);
    if (!row) throw new AppError('NOT_FOUND', 'Прогон тестов не найден');
    return toRecord(row);
  }

  list(projectId: string): TestRunRecord[] {
    return allRows(
      this.db,
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY created_at DESC',
      projectId,
    ).map(toRecord);
  }

  latest(projectId: string): TestRunRecord | null {
    const row = getRow(
      this.db,
      'SELECT * FROM test_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1',
      projectId,
    );
    return row ? toRecord(row) : null;
  }
}
