/**
 * API навыков (skills) и библиотеки примеров промтов.
 *
 * Скиллы и примеры — справочные данные: они не меняются через HTTP, поэтому
 * здесь только чтение. Нужны интерфейсу, чтобы показать, на каком стандарте
 * собран раздел, и экспортировать эту информацию.
 */
import type { Router } from '../http/router.ts';
import type { ApiDeps } from './helpers.ts';
import { json } from '../http/respond.ts';
import { optionalString, numberInRange } from '../core/validate.ts';
import {
  SKILLS,
  SKILL_CATEGORY_LABELS,
  SKILL_CATEGORY_ORDER,
  selectSkills,
} from '../domain/skills.ts';
import type { SkillCategory } from '../domain/skills.ts';
import { librarySummary, searchLibrary } from '../domain/prompt-library.ts';
import { detectArchetype } from '../domain/archetypes.ts';
import { SECTION_TITLES, type SectionKey } from '../domain/types.ts';
import { AppError } from '../core/errors.ts';

export function registerSkillRoutes(router: Router, _deps: ApiDeps): void {
  /** Полный каталог скиллов с группировкой по категориям. */
  router.get('/api/skills', ({ query }) => {
    const category = optionalString(query.get('category') ?? undefined, 'category', { max: 40 });
    let skills = SKILLS;
    if (category) {
      if (!(SKILL_CATEGORY_ORDER as readonly string[]).includes(category)) {
        throw new AppError('VALIDATION_FAILED', `Неизвестная категория скиллов: ${category}`);
      }
      skills = skills.filter((skill) => skill.category === (category as SkillCategory));
    }

    return json({
      categories: SKILL_CATEGORY_ORDER.map((key) => ({
        key,
        label: SKILL_CATEGORY_LABELS[key],
        count: SKILLS.filter((skill) => skill.category === key).length,
      })),
      skills: skills.map((skill) => ({
        id: skill.id,
        label: skill.label,
        category: skill.category,
        categoryLabel: SKILL_CATEGORY_LABELS[skill.category],
        sections: skill.sections.map((key) => ({ key, title: SECTION_TITLES[key] })),
        archetypes: skill.archetypes,
        keywords: skill.keywords,
        guidance: skill.guidance,
        antiPatterns: skill.antiPatterns,
        exampleIds: skill.exampleIds,
      })),
      total: skills.length,
    });
  });

  /**
   * Предпросмотр подбора: какие скиллы получит раздел для конкретной идеи.
   * Полезно, чтобы объяснить пользователю, почему раздел собран именно так.
   */
  router.get('/api/skills/selection', ({ query }) => {
    const idea = optionalString(query.get('idea') ?? undefined, 'idea', { max: 20_000 });
    if (!idea || idea.length < 10) throw new AppError('VALIDATION_FAILED', 'Параметр idea обязателен');

    const sectionKey = (query.get('section') ?? 'role') as SectionKey;
    if (!(sectionKey in SECTION_TITLES)) {
      throw new AppError('VALIDATION_FAILED', `Неизвестный раздел: ${sectionKey}`);
    }

    const limit = numberInRange(query.get('limit') ?? undefined, 'limit', { min: 1, max: 10, integer: true }) ?? 3;
    const archetype = detectArchetype(idea);

    const selected = selectSkills({ idea, sectionKey, archetype, limit });
    return json({
      archetype,
      section: { key: sectionKey, title: SECTION_TITLES[sectionKey] },
      selection: selected.map((entry) => ({
        id: entry.skill.id,
        label: entry.skill.label,
        category: entry.skill.category,
        categoryLabel: SKILL_CATEGORY_LABELS[entry.skill.category],
        score: entry.score,
        reasons: entry.reasons,
        exampleIds: entry.skill.exampleIds,
      })),
    });
  });

  /** Сводка библиотеки: категории и количество примеров. */
  router.get('/api/library', ({ query }) => {
    const summary = librarySummary();
    const category = optionalString(query.get('category') ?? undefined, 'category', { max: 40 });
    const text = optionalString(query.get('q') ?? undefined, 'q', { max: 120 });
    const limit = numberInRange(query.get('limit') ?? undefined, 'limit', { min: 1, max: 200, integer: true }) ?? 60;

    // Полные тела отдаём только по запросу — каталог может быть большим.
    const withBodies = query.get('bodies') === '1';
    const items = searchLibrary({ category, text, limit }).map((prompt) =>
      withBodies
        ? prompt
        : {
            id: prompt.id,
            category: prompt.category,
            categoryLabel: prompt.categoryLabel,
            title: prompt.title,
            chars: prompt.chars,
            tags: prompt.tags,
            variables: prompt.variables,
          },
    );

    return json({ ...summary, items, total: summary.counts.prompts });
  });

  /** Один пример целиком — для просмотра в интерфейсе. */
  router.get('/api/library/:id', ({ params }) => {
    const found = searchLibrary({ limit: 10_000 }).find((prompt) => prompt.id === params.id);
    if (!found) throw new AppError('NOT_FOUND', 'Пример не найден');
    return json({ prompt: found });
  });
}
