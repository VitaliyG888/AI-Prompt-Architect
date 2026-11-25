/** Генерация идентификаторов с префиксом типа сущности. */
import { randomUUID, randomBytes } from 'node:crypto';

export type EntityPrefix = 'prj' | 'sec' | 'msg' | 'res' | 'prv' | 'rte' | 'usg' | 'ver' | 'tst' | 'srp';

export function newId(prefix: EntityPrefix): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function newRunId(): string {
  return randomBytes(9).toString('base64url');
}

export function nowIso(): string {
  return new Date().toISOString();
}
