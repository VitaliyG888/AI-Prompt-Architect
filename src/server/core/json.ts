/**
 * Толерантный разбор JSON из ответов LLM.
 *
 * Модели регулярно добавляют пояснения вокруг JSON, оборачивают его в
 * ```json-блоки, ставят висячие запятые или используют «умные» кавычки.
 * Здесь мы извлекаем первый сбалансированный JSON-объект/массив и
 * применяем ограниченные безопасные исправления. Никакого eval.
 */
import { AppError } from './errors.ts';

const FENCE = /```(?:json|JSON)?\s*([\s\S]*?)```/g;

/** Убирает управляющие символы внутри строк и «умные» кавычки-разделители. */
function normalizeSyntactic(text: string): string {
  return text
    .replace(/\uFEFF/g, '')
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1');
}

/** Находит первый сбалансированный фрагмент, начинающийся с { или [. */
function findBalanced(text: string): string | null {
  const startIdx = (() => {
    const obj = text.indexOf('{');
    const arr = text.indexOf('[');
    if (obj === -1) return arr;
    if (arr === -1) return obj;
    return Math.min(obj, arr);
  })();
  if (startIdx === -1) return null;

  const open = text[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

function attempt<T>(candidate: string): T | null {
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

export interface ParseJsonOptions {
  /** Что ожидается: объект, массив или любой корректный JSON. */
  expect?: 'object' | 'array' | 'any';
  /** Контекст для сообщения об ошибке (операция, раздел). */
  context?: string;
}

export function parseLooseJson<T = unknown>(raw: string, options: ParseJsonOptions = {}): T {
  const { expect = 'any', context } = options;
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];

  // Блоки кода перебираем от последнего к первому: модели часто рассуждают,
  // а итоговый JSON отдают в конце ответа.
  const fences = [...trimmed.matchAll(FENCE)].map((match) => match[1].trim());
  for (let i = fences.length - 1; i >= 0; i--) candidates.push(fences[i]);

  const balanced = findBalanced(trimmed);
  if (balanced) candidates.push(balanced);

  for (const candidate of candidates) {
    const direct = attempt<T>(candidate);
    if (direct !== null && matchesShape(direct, expect)) return direct;
    const repaired = attempt<T>(normalizeSyntactic(candidate));
    if (repaired !== null && matchesShape(repaired, expect)) return repaired;
  }

  // Последний шанс: сбалансированный фрагмент после нормализации.
  if (balanced) {
    const repaired = attempt<T>(normalizeSyntactic(balanced));
    if (repaired !== null && matchesShape(repaired, expect)) return repaired;
  }

  const snippet = trimmed.slice(0, 400).replace(/\s+/g, ' ');
  throw new AppError(
    'VALIDATION_FAILED',
    `Модель вернула не-JSON ответ${context ? ` (${context})` : ''}. Фрагмент: ${snippet}`,
    { details: { expected: expect } },
  );
}

function matchesShape(value: unknown, expect: 'object' | 'array' | 'any'): boolean {
  if (expect === 'any') return true;
  if (expect === 'array') return Array.isArray(value);
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Безопасно извлекает строку из объекта ответа модели. */
export function pickString(source: unknown, key: string, fallback = ''): string {
  if (!source || typeof source !== 'object') return fallback;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : fallback;
}

/** Извлекает массив строк. */
export function pickStringArray(source: unknown, key: string): string[] {
  if (!source || typeof source !== 'object') return [];
  const value = (source as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
