/**
 * Типизированный доступ к библиотеке примеров промтов.
 *
 * Библиотека — статический JSON, собранный из docx скриптом
 * scripts/build-prompt-library.mjs. Здесь она читается один раз и
 * нормализуется: без диска в рантайме и без разбора docx на запросе.
 */
import raw from './prompt-library.json' with { type: 'json' };
import type { PromptExample } from './skills.ts';

interface RawPrompt {
  id: string;
  hash: string;
  category: string;
  categoryLabel: string;
  title: string;
  body: string;
  chars: number;
  variables: string[];
  tags: string[];
}

interface RawCatalog {
  source: string;
  generatedAt: string;
  counts: { categories: number; prompts: number };
  categories: Array<{ slug: string; label: string; count: number; tags: string[] }>;
  prompts: RawPrompt[];
}

const catalog = raw as unknown as RawCatalog;

export const PROMPT_LIBRARY_SOURCE = catalog.source;
export const PROMPT_LIBRARY_GENERATED_AT = catalog.generatedAt;
export const PROMPT_LIBRARY_CATEGORIES = catalog.categories;
export const PROMPT_LIBRARY_PROMPTS = catalog.prompts;

const byId = new Map(catalog.prompts.map((prompt) => [prompt.id, prompt]));

export function getLibraryPrompt(id: string): PromptExample | null {
  const prompt = byId.get(id);
  if (!prompt) return null;
  return {
    id: prompt.id,
    title: prompt.title,
    body: prompt.body,
    chars: prompt.chars,
    category: prompt.category,
    categoryLabel: prompt.categoryLabel,
  };
}

/** Примеры по списку id в заданном порядке; отсутствующие пропускаются. */
export function getLibraryPrompts(ids: string[]): PromptExample[] {
  const out: PromptExample[] = [];
  for (const id of ids) {
    const prompt = getLibraryPrompt(id);
    if (prompt) out.push(prompt);
  }
  return out;
}

/** Сводка для API и интерфейса: категории с количеством промтов. */
export function librarySummary(): {
  source: string;
  generatedAt: string;
  counts: { categories: number; prompts: number };
  categories: Array<{ slug: string; label: string; count: number; tags: string[] }>;
} {
  return {
    source: catalog.source,
    generatedAt: catalog.generatedAt,
    counts: catalog.counts,
    categories: catalog.categories,
  };
}

/** Поиск примеров по категории и подстроке в заголовке. */
export function searchLibrary(query: { category?: string; text?: string; limit?: number } = {}): RawPrompt[] {
  const needle = (query.text ?? '').toLowerCase().trim();
  let items = catalog.prompts;
  if (query.category) items = items.filter((prompt) => prompt.category === query.category);
  if (needle) {
    items = items.filter(
      (prompt) =>
        prompt.title.toLowerCase().includes(needle) || prompt.tags.some((tag) => tag.includes(needle)),
    );
  }
  return items.slice(0, query.limit ?? 200);
}

export { catalog as promptLibraryCatalog };
