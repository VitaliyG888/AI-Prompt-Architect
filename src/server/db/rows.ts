/** Общие утилиты репозиториев: безопасный JSON, typed-доступ к строкам. */
import type { DatabaseSync } from 'node:sqlite';

export type Row = Record<string, unknown>;

export function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string' || !text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function str(row: Row, key: string, fallback = ''): string {
  const value = row[key];
  return typeof value === 'string' ? value : fallback;
}

export function num(row: Row, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return fallback;
}

export function bool(row: Row, key: string, fallback = false): boolean {
  const value = row[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'bigint') return value !== 0n;
  return fallback;
}

export function nullableNum(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
}

export function getRow(db: DatabaseSync, sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare(sql).get(...(params as never[])) as Row | undefined;
}

export function allRows(db: DatabaseSync, sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...(params as never[])) as Row[];
}

export function run(db: DatabaseSync, sql: string, ...params: unknown[]): void {
  db.prepare(sql).run(...(params as never[]));
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback уже выполнен */
    }
    throw error;
  }
}
