/**
 * Prompt Assembler: собирает утверждённые разделы в единый промт.
 *
 * Помимо текста промта возвращает сопроводительные материалы, требуемые
 * продуктом: назначение, инструкции по применению, оценку качества с
 * обоснованием, источники, допущения/ограничения и рекомендации.
 *
 * Если LLM недоступна, выполняется детерминированная сборка из разделов —
 * без выдумывания содержания, с честной пометкой.
 */
import type { LLMClient } from '../llm/client.ts';
import type { ProjectRecord, QualityReport, SectionKey, SectionRecord, SourceRecord } from '../domain/types.ts';
import { assemblyPrompt } from '../domain/prompts.ts';
import { callJson } from './llmjson.ts';
import { aggregateQuality } from '../domain/quality.ts';
import { toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';

export interface AssemblyResult {
  prompt: string;
  purpose: string;
  usage: string[];
  assumptions: string[];
  limitations: string[];
  improvements: string[];
  conflictsResolved: string[];
  quality: {
    total: number;
    verdict: 'pass' | 'revise';
    bySection: Array<{ key: SectionKey; title: string; total: number; verdict: string }>;
    failedMandatory: number;
  };
  sources: Array<{ title: string; url: string; publisher: string }>;
  source: 'llm' | 'deterministic';
  providerName: string;
  model: string;
}

const SECTION_ORDER: SectionKey[] = [
  'role',
  'context',
  'objective',
  'expertise',
  'methodology',
  'workflow',
  'tools',
  'constraints',
  'output_format',
  'quality_criteria',
  'error_handling',
  'specialized',
];

export class PromptAssembler {
  private readonly client: LLMClient;

  constructor(client: LLMClient) {
    this.client = client;
  }

  async assemble(input: {
    project: ProjectRecord;
    sections: SectionRecord[];
    sources: SourceRecord[];
    signal?: AbortSignal;
  }): Promise<AssemblyResult> {
    const usable = input.sections
      .filter((section) => section.content.trim().length > 0)
      .sort((a, b) => SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key));

    if (usable.length === 0) {
      throw new Error('Нет готовых разделов для сборки промта');
    }

    const requirements = [...new Set(input.sections.flatMap((section) => section.requirements))];
    const reports = input.sections
      .map((section) => section.quality)
      .filter((report): report is QualityReport => report !== null);
    const aggregated = aggregateQuality(reports);

    const quality = {
      total: aggregated.total,
      verdict: aggregated.verdict,
      bySection: input.sections.map((section) => ({
        key: section.key,
        title: section.title,
        total: section.quality?.total ?? 0,
        verdict: section.quality?.verdict ?? 'pending',
      })),
      failedMandatory: aggregated.failedMandatory,
    };

    const sources = input.sources.map((source) => ({
      title: source.title,
      url: source.url,
      publisher: source.publisher,
    }));

    try {
      const pair = assemblyPrompt({
        idea: input.project.idea,
        audience: input.project.audience,
        targetModel: input.project.targetModel,
        sections: usable.map((section) => ({ key: section.key, title: section.title, content: section.content })),
        requirements,
      });

      const result = await callJson<Record<string, unknown>>(this.client, {
        operation: 'final_assembly',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: input.project.id,
        signal: input.signal,
        maxOutputTokens: 12_000,
      });

      const prompt = typeof result.data.prompt === 'string' ? result.data.prompt.trim() : '';
      if (prompt.length < 100) throw new Error('Модель вернула слишком короткий промт');

      const strings = (key: string): string[] => {
        const value = result.data[key];
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      };

      return {
        prompt,
        purpose:
          typeof result.data.purpose === 'string' && result.data.purpose
            ? result.data.purpose
            : `Промт для задачи: ${input.project.idea.slice(0, 160)}`,
        usage: strings('usage'),
        assumptions: strings('assumptions'),
        limitations: strings('limitations'),
        improvements: strings('improvements'),
        conflictsResolved: strings('conflictsResolved'),
        quality,
        sources,
        source: 'llm',
        providerName: result.providerName,
        model: result.model,
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('assembly fell back to deterministic build', { code: appError.code });

      const prompt = this.deterministicBuild(input.project, usable);
      return {
        prompt,
        purpose: `Промт для задачи: ${input.project.idea.slice(0, 160)}`,
        usage: [
          'Вставьте промт в начало диалога с целевой моделью как системную инструкцию.',
          'Затем отправьте задачу пользователя отдельным сообщением.',
        ],
        assumptions: requirements.length > 0 ? ['Собрано из подтверждённых требований разделов'] : [],
        limitations: [
          `Сборка выполнена без модели (${appError.code}): текст не прошёл финальную литературную обработку.`,
        ],
        improvements: ['Настройте LLM-провайдера и повторите сборку для устранения повторов и противоречий.'],
        conflictsResolved: [],
        quality,
        sources,
        source: 'deterministic',
        providerName: '',
        model: '',
      };
    }
  }

  /** Детерминированная сборка: разделы в каноническом порядке, без правок. */
  deterministicBuild(project: ProjectRecord, sections: SectionRecord[]): string {
    const header = [
      `# ${project.title || 'Промт'}`,
      '',
      `<!-- Задача: ${project.idea.replace(/-->/g, '—')} -->`,
      '',
    ].join('\n');

    const body = sections
      .map((section) => {
        const heading = `## ${section.title}`;
        return `${heading}\n\n${section.content.trim()}`;
      })
      .join('\n\n');

    return `${header}${body}\n`;
  }
}
