/**
 * Минимальная валидация входных данных без внешних зависимостей.
 * Каждая функция бросает AppError('VALIDATION_FAILED') с понятным полем.
 */
import { AppError } from './errors.ts';

export function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть объектом`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; trim?: boolean } = {},
): string {
  const { min = 1, max = 200_000, trim = true } = opts;
  if (typeof value !== 'string') {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть строкой`);
  }
  const result = trim ? value.trim() : value;
  if (result.length < min) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" короче минимума (${min})`);
  }
  if (result.length > max) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" длиннее максимума (${max})`);
  }
  return result;
}

export function optionalString(
  value: unknown,
  field: string,
  opts: { max?: number } = {},
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(value, field, { min: 0, max: opts.max });
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть одним из: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireEnum(value, field, allowed);
}

export function numberInRange(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number; integer?: boolean } = {},
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть числом`);
  }
  if (opts.integer && !Number.isInteger(num)) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть целым числом`);
  }
  if (opts.min !== undefined && num < opts.min) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" меньше ${opts.min}`);
  }
  if (opts.max !== undefined && num > opts.max) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" больше ${opts.max}`);
  }
  return num;
}

export function requireBoolean(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" обязательно`);
  }
  if (typeof value !== 'boolean') {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть boolean`);
  }
  return value;
}

export function stringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" должно быть массивом`);
  }
  if (value.length > maxItems) {
    throw new AppError('VALIDATION_FAILED', `Поле "${field}" содержит более ${maxItems} элементов`);
  }
  return value.map((item, index) => requireString(item, `${field}[${index}]`, { min: 0, max: 20_000 }));
}

export function recordOfStrings(value: unknown, field: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  const record = asRecord(value, field);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== 'string') {
      throw new AppError('VALIDATION_FAILED', `Поле "${field}.${key}" должно быть строкой`);
    }
    if (key.length > 200 || item.length > 4000) {
      throw new AppError('VALIDATION_FAILED', `Поле "${field}.${key}" слишком длинное`);
    }
    out[key] = item;
  }
  return out;
}

/** Ограничивает строку по длине, сохраняя целые абзацы. */
export function clampText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  return (lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut) + '\n\n[…сокращено…]';
}
