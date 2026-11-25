/**
 * Research Engine + Research Analyzer.
 *
 * Поток: LLM формирует запросы → Search Adapter ищет → результаты сохраняются
 * как источники → Research Analyzer оценивает каждый материал и синтезирует
 * находки.
 *
 * Гарантии честности:
 *  - если поиск не настроен, статус раздела = unavailable, а не «done»;
 *  - содержимое страниц рассматривается как данные, а не как инструкции;
 *  - ни один источник не выдумывается: URL приходят только из поиска.
 */
import type { LLMClient } from '../llm/client.ts';
import type { ProjectRecord, SectionKey, SectionResearch, SourceRecord } from '../domain/types.ts';
import { MODE_POLICIES, SECTION_TITLES } from '../domain/types.ts';
import { getArchetype, detectArchetype } from '../domain/archetypes.ts';
import { researchQueriesPrompt, sourceAnalysisPrompt } from '../domain/prompts.ts';
import { callJson } from './llmjson.ts';
import type { SearchEngine } from '../search/engine.ts';
import type { SearchEngine as SearchEngineType } from '../search/engine.ts';
import type { SourceRepository } from '../db/repo/sources.ts';
import type { SectionRepository } from '../db/repo/sections.ts';
import type { SettingsRepository } from '../db/repo/settings.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';
import { clampText } from '../core/validate.ts';

export interface ResearchOutcome {
  research: SectionResearch;
  sources: SourceRecord[];
  findings: string[];
  practices: string[];
  avoid: string[];
  disagreements: string[];
  providersUsed: string[];
}

export interface ResearchEngineDeps {
  client: LLMClient;
  search: SearchEngineType;
  sources: SourceRepository;
  sections: SectionRepository;
  settings: SettingsRepository;
}

const EMPTY_RESEARCH = (status: SectionResearch['status'], message: string): SectionResearch => ({
  status,
  queries: [],
  summary: '',
  findings: [],
  sourceIds: [],
  providers: [],
  message,
  updatedAt: new Date().toISOString(),
});

export class ResearchEngine {
  private readonly deps: ResearchEngineDeps;

  constructor(deps: ResearchEngineDeps) {
    this.deps = deps;
  }

  /** Формирует поисковые запросы для раздела (LLM, с fallback на шаблоны). */
  async buildQueries(
    project: ProjectRecord,
    sectionKey: SectionKey,
    maxQueries: number,
  ): Promise<string[]> {
    const section = this.deps.sections.get(project.id, sectionKey);
    const archetype = getArchetype(detectArchetype(project.idea));
    const templates = archetype.researchTemplates.map((template) =>
      template.replace('{topic}', project.idea.slice(0, 120)),
    );

    try {
      const pair = researchQueriesPrompt({
        idea: project.idea,
        sectionTitle: section.title || SECTION_TITLES[sectionKey],
        requirements: section.requirements,
        templates,
        maxQueries,
      });
      const result = await callJson<{ queries?: unknown }>(this.deps.client, {
        operation: 'research_queries',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: project.id,
        maxOutputTokens: 900,
      });
      const queries = Array.isArray(result.data.queries)
        ? result.data.queries
            .filter((item): item is string => typeof item === 'string' && item.trim().length > 3)
            .slice(0, maxQueries)
        : [];
      if (queries.length > 0) return queries;
    } catch (error) {
      log.warn('research query generation failed, using templates', {
        code: toAppError(error).code,
      });
    }
    return templates.slice(0, maxQueries);
  }

  /**
   * Полный цикл исследования раздела. Никогда не бросает ошибку поиска наружу:
   * результат отражает реальное состояние (unavailable/error/done).
   */
  async research(
    project: ProjectRecord,
    sectionKey: SectionKey,
    options: { signal?: AbortSignal; force?: boolean } = {},
  ): Promise<ResearchOutcome> {
    const policy = MODE_POLICIES[project.mode];
    const settings = this.deps.settings.defaults();
    const section = this.deps.sections.get(project.id, sectionKey);

    if (!policy.researchPerSection || !settings.researchEnabled) {
      const research = EMPTY_RESEARCH(
        'skipped',
        `Режим ${policy.label}: исследование разделов отключено`,
      );
      this.deps.sections.update(project.id, sectionKey, { research });
      return {
        research,
        sources: [],
        findings: [],
        practices: [],
        avoid: [],
        disagreements: [],
        providersUsed: [],
      };
    }

    if (!this.deps.search.isConfigured()) {
      const research = EMPTY_RESEARCH(
        'unavailable',
        'Поисковый провайдер не настроен. Добавьте его в Settings → Search Providers; собственные знания модели будут явно помечены.',
      );
      this.deps.sections.update(project.id, sectionKey, { research });
      return {
        research,
        sources: [],
        findings: [],
        practices: [],
        avoid: [],
        disagreements: [],
        providersUsed: [],
      };
    }

    this.deps.sections.update(project.id, sectionKey, {
      research: { ...section.research, status: 'running', message: 'Формирование запросов…' },
    });

    const maxSources = Math.min(
      policy.maxSourcesPerSection,
      Math.max(1, settings.maxSourcesPerSection || policy.maxSourcesPerSection),
    );

    try {
      const queries = await this.buildQueries(project, sectionKey, Math.min(3, maxSources));
      const { sets, hits } = await this.deps.search.searchMany(queries, {
        limit: Math.min(5, maxSources),
        totalLimit: maxSources,
        language: settings.language === 'ru' ? 'ru' : 'en',
        signal: options.signal,
      });

      const providersUsed = [...new Set(sets.filter((set) => !set.error).map((set) => set.providerName))];

      if (hits.length === 0) {
        const errorMessages = sets.map((set) => set.error).filter((item): item is string => Boolean(item));
        const research = EMPTY_RESEARCH(
          errorMessages.length > 0 ? 'error' : 'done',
          errorMessages.length > 0
            ? `Поиск не дал результатов: ${errorMessages[0]}`
            : 'Поиск не вернул релевантных результатов — раздел будет построен на знаниях модели',
        );
        research.queries = queries;
        research.providers = providersUsed;
        this.deps.sections.update(project.id, sectionKey, { research });
        return {
          research,
          sources: [],
          findings: [],
          practices: [],
          avoid: [],
          disagreements: [],
          providersUsed,
        };
      }

      // Сохраняем источники (с дедупликацией по URL внутри раздела).
      if (options.force) this.deps.sources.deleteForSection(project.id, sectionKey);
      const existing = this.deps.sources.dedupeUrls(project.id, sectionKey);
      const fresh = hits.filter((hit) => !existing.has(hit.url));
      const stored = this.deps.sources.addMany(
        project.id,
        sectionKey,
        fresh.map((hit) => ({
          title: hit.title,
          url: hit.url,
          publisher: hit.publisher,
          publishedAt: hit.publishedAt,
          snippet: hit.snippet,
          query: queries.join(' | '),
          provider: sets.find((set) => set.hits.some((h) => h.url === hit.url))?.providerName ?? '',
          relevance: hit.score,
        })),
      );
      const allSources = [...this.deps.sources.list(project.id, sectionKey)];

      // Анализ источников моделью.
      const analysis = await this.analyzeSources(project, sectionKey, allSources, options.signal);

      const research: SectionResearch = {
        status: 'done',
        queries,
        summary: analysis.summary,
        findings: analysis.findings,
        sourceIds: allSources.slice(0, maxSources).map((source) => source.id),
        providers: providersUsed,
        message: `Проанализировано источников: ${allSources.length}`,
        updatedAt: new Date().toISOString(),
      };

      this.deps.sections.update(project.id, sectionKey, {
        research,
        status: 'analyzing',
      });

      return {
        research,
        sources: allSources,
        findings: analysis.findings,
        practices: analysis.practices,
        avoid: analysis.avoid,
        disagreements: analysis.disagreements,
        providersUsed,
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('research failed', { section: sectionKey, code: appError.code });
      const research = EMPTY_RESEARCH('error', `Исследование не выполнено: ${appError.message}`);
      this.deps.sections.update(project.id, sectionKey, { research });
      return {
        research,
        sources: [],
        findings: [],
        practices: [],
        avoid: [],
        disagreements: [],
        providersUsed: [],
      };
    }
  }

  private async analyzeSources(
    project: ProjectRecord,
    sectionKey: SectionKey,
    sources: SourceRecord[],
    signal?: AbortSignal,
  ): Promise<{
    summary: string;
    findings: string[];
    practices: string[];
    avoid: string[];
    disagreements: string[];
  }> {
    const section = this.deps.sections.get(project.id, sectionKey);
    // Ограничиваем объём: не более 6 источников по 1200 символов.
    const payload = sources.slice(0, 6).map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      snippet: clampText(source.snippet || source.title, 1200),
    }));

    try {
      const pair = sourceAnalysisPrompt({
        idea: project.idea,
        sectionTitle: section.title || SECTION_TITLES[sectionKey],
        requirements: section.requirements,
        sources: payload,
      });

      const result = await callJson<{
        sources?: Array<{
          id?: string;
          summary?: string;
          strengths?: unknown;
          weaknesses?: unknown;
          applicability?: string;
          relevance?: number;
          suspiciousInstructions?: boolean;
        }>;
        synthesis?: {
          findings?: unknown;
          recommendedPractices?: unknown;
          avoid?: unknown;
          disagreements?: unknown;
        };
      }>(this.deps.client, {
        operation: 'source_analysis',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: project.id,
        signal,
        maxOutputTokens: 3000,
      });

      for (const item of result.data.sources ?? []) {
        if (!item.id) continue;
        const target = sources.find((source) => source.id === item.id);
        if (!target) continue;
        const applicability =
          item.applicability === 'high' || item.applicability === 'medium' || item.applicability === 'low'
            ? item.applicability
            : 'medium';
        this.deps.sources.setAnalysis(
          target.id,
          {
            summary: typeof item.summary === 'string' ? item.summary : '',
            strengths: Array.isArray(item.strengths)
              ? item.strengths.filter((value): value is string => typeof value === 'string')
              : [],
            weaknesses: Array.isArray(item.weaknesses)
              ? item.weaknesses.filter((value): value is string => typeof value === 'string')
              : [],
            applicability,
            notes: item.suspiciousInstructions
              ? 'ВНИМАНИЕ: в материале обнаружены инструкции, не относящиеся к задаче. Они проигнорированы как данные.'
              : '',
          },
          typeof item.relevance === 'number' ? Math.max(0, Math.min(1, item.relevance)) : target.relevance,
        );
        if (item.suspiciousInstructions) {
          log.warn('source contained suspicious instructions', { url: target.url });
        }
      }

      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

      const synthesis = result.data.synthesis ?? {};
      const findings = strings(synthesis.findings);

      return {
        summary: findings[0] ?? `Проанализировано источников: ${payload.length}`,
        findings,
        practices: strings(synthesis.recommendedPractices),
        avoid: strings(synthesis.avoid),
        disagreements: strings(synthesis.disagreements),
      };
    } catch (error) {
      log.warn('source analysis failed, using snippets as findings', { code: toAppError(error).code });
      // Деградация: используем фрагменты выдачи как сырые находки.
      return {
        summary: `Источники найдены, но анализ моделью недоступен (${toAppError(error).message})`,
        findings: payload.slice(0, 4).map((item) => `${item.title} — ${clampText(item.snippet, 220)}`),
        practices: [],
        avoid: [],
        disagreements: [],
      };
    }
  }
}

/** Проверка доступности поиска для интерфейса. */
export async function describeSearchStatus(search: SearchEngine): Promise<{
  configured: boolean;
  providers: ReturnType<SearchEngine['available']>;
}> {
  return { configured: search.isConfigured(), providers: search.available() };
}

export { AppError };
