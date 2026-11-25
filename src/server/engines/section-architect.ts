/**
 * Section Architect: синтез одного раздела из трёх оснований
 * (требования пользователя, исследование, собственная разработка модели).
 *
 * Также отвечает за граф зависимостей: при изменении раздела определяет
 * затронутые разделы и помечает их «требует пересмотра», не перезаписывая
 * утверждённые решения пользователя молча.
 */
import type { LLMClient } from '../llm/client.ts';
import type { ProjectRecord, SectionKey, SectionRecord } from '../domain/types.ts';
import { MODE_POLICIES, SECTION_DEPENDENCIES, SECTION_TITLES } from '../domain/types.ts';
import { synthesisPrompt, type SynthesisExample, type SynthesisSkill } from '../domain/prompts.ts';
import { detectArchetype } from '../domain/archetypes.ts';
import {
  SKILL_CATEGORY_LABELS,
  exampleIdsFor,
  selectSkills,
  truncateExample,
  type PromptExample,
  type Skill,
} from '../domain/skills.ts';
import { getLibraryPrompts } from '../domain/prompt-library.ts';
import { callJson } from './llmjson.ts';
import { heuristicQuality, normalizeQuality } from '../domain/quality.ts';
import type { SectionRepository } from '../db/repo/sections.ts';
import type { SourceRepository } from '../db/repo/sources.ts';
import type { ProjectRepository } from '../db/repo/projects.ts';
import { toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';

export interface SynthesisResult {
  section: SectionRecord;
  providerName: string;
  model: string;
  fromResearch: string[];
  rejected: string[];
  openQuestions: string[];
  confidence: number;
  source: 'llm' | 'heuristic';
  /** Скиллы, задавшие стандарт раздела (для прозрачности и экспорта). */
  skills: Array<{ id: string; label: string; category: string }>;
  /** Примеры из библиотеки, показанные модели. */
  examples: Array<{ id: string; title: string }>;
}

/** Сколько скиллов и примеров показывать модели в одном разделе. */
const MAX_SKILLS_PER_SECTION = 3;
const MAX_EXAMPLES_PER_SECTION = 2;

export interface SectionArchitectDeps {
  client: LLMClient;
  sections: SectionRepository;
  sources: SourceRepository;
  projects: ProjectRepository;
  /** Максимум символов для повторной проверки качества. */
  qualityThreshold?: number;
}

export class SectionArchitect {
  private readonly deps: SectionArchitectDeps;

  constructor(deps: SectionArchitectDeps) {
    this.deps = deps;
  }

  async synthesize(
    project: ProjectRecord,
    sectionKey: SectionKey,
    options: { signal?: AbortSignal; previousContent?: string; feedback?: string } = {},
  ): Promise<SynthesisResult> {
    const policy = MODE_POLICIES[project.mode];
    const section = this.deps.sections.get(project.id, sectionKey);
    const sources = this.deps.sources.list(project.id, sectionKey);
    const researchAvailable = section.research.status === 'done' && section.research.findings.length > 0;

    // Скиллы и примеры подбираются детерминированно: один и тот же проект
    // и раздел всегда дают один и тот же набор.
    const plan = this.selectSkillPlan(project, sectionKey);

    try {
      const pair = synthesisPrompt({
        idea: project.idea,
        audience: project.audience,
        targetModel: project.targetModel,
        mode: project.mode,
        sectionTitle: section.title || SECTION_TITLES[sectionKey],
        sectionKey,
        requirements: section.requirements,
        researchFindings: section.research.findings,
        researchPractices: [],
        researchAvoid: [],
        researchAvailable,
        sources: sources.slice(0, 6).map((source) => ({ title: source.title, url: source.url })),
        alternatives: policy.alternatives,
        previousContent: options.previousContent ?? (section.content || undefined),
        skills: plan.skills,
        examples: plan.examples,
      });

      const userContent = options.feedback
        ? `${pair.user}\n\nЗамечания пользователя, которые обязательно учесть:\n${options.feedback}`
        : pair.user;

      const result = await callJson<{
        content?: unknown;
        summary?: unknown;
        requirementsCaptured?: unknown;
        decisions?: unknown;
        fromResearch?: unknown;
        rejected?: unknown;
        openQuestions?: unknown;
        alternatives?: unknown;
        confidence?: unknown;
      }>(this.deps.client, {
        operation: 'section_synthesis',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: userContent },
        ],
        expect: 'object',
        projectId: project.id,
        signal: options.signal,
        maxOutputTokens: 6000,
      });

      const content = typeof result.data.content === 'string' ? result.data.content.trim() : '';
      if (content.length < 40) {
        throw new Error('Модель вернула слишком короткий раздел');
      }

      const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

      const alternatives = Array.isArray(result.data.alternatives)
        ? result.data.alternatives
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const record = item as Record<string, unknown>;
              if (typeof record.content !== 'string' || record.content.trim().length < 40) return null;
              return {
                label: typeof record.label === 'string' ? record.label : 'Альтернатива',
                content: record.content.trim(),
                rationale: typeof record.rationale === 'string' ? record.rationale : '',
              };
            })
            .filter((item): item is { label: string; content: string; rationale: string } => item !== null)
            .slice(0, 3)
        : [];

      const decisions = Array.isArray(result.data.decisions)
        ? result.data.decisions
            .map((item) => {
              if (!item || typeof item !== 'object') return null;
              const record = item as Record<string, unknown>;
              if (typeof record.question !== 'string' || typeof record.choice !== 'string') return null;
              const source =
                record.source === 'user' || record.source === 'research' || record.source === 'ai'
                  ? record.source
                  : 'ai';
              return { question: record.question, choice: record.choice, source };
            })
            .filter(
              (item): item is { question: string; choice: string; source: 'user' | 'ai' | 'research' } =>
                item !== null,
            )
        : [];

      const updated = this.deps.sections.update(project.id, sectionKey, {
        content,
        summary: typeof result.data.summary === 'string' ? result.data.summary : section.summary,
        status: 'ready',
        alternatives,
        decisions,
        openQuestions: strings(result.data.openQuestions),
        flags: this.mergeSkillFlags(section.flags, plan),
        research: {
          ...section.research,
          status: researchAvailable ? 'done' : section.research.status,
        },
      });

      this.deps.projects.touch(project.id);

      return {
        section: updated,
        providerName: result.providerName,
        model: result.model,
        fromResearch: strings(result.data.fromResearch),
        rejected: strings(result.data.rejected),
        openQuestions: strings(result.data.openQuestions),
        confidence: typeof result.data.confidence === 'number' ? result.data.confidence : 70,
        source: 'llm',
        skills: plan.selected.map((skill) => ({
          id: skill.id,
          label: skill.label,
          category: SKILL_CATEGORY_LABELS[skill.category],
        })),
        examples: plan.found.map((example) => ({ id: example.id, title: example.title })),
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('section synthesis failed, using degraded content', {
        section: sectionKey,
        code: appError.code,
      });
      // Честная деградация: раздел собирается из подтверждённых требований
      // и стандартов, без выдуманных фактов и без тупика.
      //
      // Раньше здесь стоял 'needs_revision'. Для пользователя это был тупик:
      // раздел уже содержит текст, но помечен «требует пересмотра», и из этого
      // состояния некуда идти. Теперь раздел остаётся рабочим, а факт деградации
      // записывается явным флагом degraded:<код>, который видно в интерфейсе.
      const fallback = this.buildFallback(section);
      const updated = this.deps.sections.update(project.id, sectionKey, {
        content: fallback,
        summary: `Раздел собран из требований пользователя (модель недоступна: ${appError.code})`,
        status: 'ready_for_synthesis',
        quality: heuristicQuality(fallback, section.requirements),
        flags: [
          ...this.mergeSkillFlags(section.flags, plan),
          `degraded:${appError.code}`,
        ],
      });
      return {
        section: updated,
        providerName: '',
        model: '',
        fromResearch: [],
        rejected: [],
        openQuestions: section.openQuestions,
        confidence: 0,
        source: 'heuristic',
        skills: plan.selected.map((skill) => ({
          id: skill.id,
          label: skill.label,
          category: SKILL_CATEGORY_LABELS[skill.category],
        })),
        examples: plan.found.map((example) => ({ id: example.id, title: example.title })),
      };
    }
  }

  /**
   * Подбирает скиллы и примеры для раздела.
   *
   * Отбор детерминирован (см. selectSkills) и зависит от архетипа, ключа
   * раздела и ключевых слов идеи — поэтому один и тот же проект при повторном
   * синтезе получает тот же стандарт, а не случайный набор.
   *
   * Объём подсказок зависит от режима: quick не должен раздувать промт,
   * expert получает максимум профессиональных требований.
   */
  private selectSkillPlan(
    project: ProjectRecord,
    sectionKey: SectionKey,
  ): {
    selected: Skill[];
    found: PromptExample[];
    skills: SynthesisSkill[];
    examples: SynthesisExample[];
  } {
    const archetype = detectArchetype(project.idea);
    const limits =
      project.mode === 'quick'
        ? { skills: 1, examples: 1 }
        : project.mode === 'expert'
          ? { skills: MAX_SKILLS_PER_SECTION, examples: MAX_EXAMPLES_PER_SECTION }
          : { skills: 2, examples: MAX_EXAMPLES_PER_SECTION };

    const selected = selectSkills({
      idea: project.idea,
      sectionKey,
      archetype,
      limit: limits.skills,
    }).map((entry) => entry.skill);

    const found = selected.length
      ? getLibraryPrompts(exampleIdsFor(selected)).slice(0, limits.examples)
      : [];

    return {
      selected,
      found,
      skills: selected.map((skill) => ({
        label: skill.label,
        categoryLabel: SKILL_CATEGORY_LABELS[skill.category],
        guidance: skill.guidance,
        antiPatterns: skill.antiPatterns,
      })),
      examples: found.map((example) => ({
        title: example.title,
        categoryLabel: example.categoryLabel,
        body: truncateExample(example.body),
      })),
    };
  }

  /** Отмечает в разделе, какие скиллы задали стандарт (для прозрачности). */
  private mergeSkillFlags(flags: string[], plan: { selected: Skill[] }): string[] {
    // Старые skill-флаги снимаем, чтобы список отражал последний синтез.
    const kept = flags.filter((flag) => !flag.startsWith('skill:'));
    return [...new Set([...kept, ...plan.selected.map((skill) => `skill:${skill.id}`)])];
  }

  private buildFallback(section: SectionRecord): string {
    const lines = [`## ${section.title}`, ''];
    if (section.requirements.length > 0) {
      lines.push(...section.requirements.map((requirement) => `- ${requirement}`));
    } else {
      lines.push('_Требования ещё не собраны: ответьте на вопросы интервью и повторите синтез._');
    }
    return lines.join('\n');
  }

  /** Оценка качества раздела моделью (с эвристическим fallback). */
  async assess(project: ProjectRecord, sectionKey: SectionKey, signal?: AbortSignal): Promise<void> {
    const section = this.deps.sections.get(project.id, sectionKey);
    if (!section.content.trim()) return;

    try {
      const { qualityPrompt } = await import('../domain/prompts.ts');
      const pair = qualityPrompt({
        idea: project.idea,
        sectionTitle: section.title,
        content: section.content,
        requirements: section.requirements,
        critical: MODE_POLICIES[project.mode].qualityStrict,
      });

      const result = await callJson<Record<string, unknown>>(this.deps.client, {
        operation: 'quality_check',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: project.id,
        signal,
        maxOutputTokens: 1800,
      });

      const report = normalizeQuality({
        criteria: Array.isArray(result.data.criteria)
          ? (result.data.criteria as Array<Record<string, unknown>>).map((item) => ({
              key: String(item.key ?? ''),
              label: String(item.label ?? ''),
              weight: Number(item.weight ?? 0),
              score: Number(item.score ?? 0),
              note: String(item.note ?? ''),
            }))
          : [],
        mandatory: Array.isArray(result.data.mandatory)
          ? (result.data.mandatory as Array<Record<string, unknown>>).map((item) => ({
              key: String(item.key ?? ''),
              label: String(item.label ?? ''),
              passed: item.passed === true,
              note: String(item.note ?? ''),
            }))
          : [],
        issues: Array.isArray(result.data.issues)
          ? (result.data.issues as unknown[]).filter((item): item is string => typeof item === 'string')
          : [],
        verdict: typeof result.data.verdict === 'string' ? result.data.verdict : 'revise',
      });

      this.deps.sections.update(project.id, sectionKey, { quality: report });
    } catch (error) {
      log.warn('quality assessment fell back to heuristic', { code: toAppError(error).code });
      this.deps.sections.update(project.id, sectionKey, {
        quality: heuristicQuality(section.content, section.requirements),
      });
    }
  }

  /**
   * Учитывает граф зависимостей: возвращает затронутые разделы и помечает
   * изменившиеся как «требует пересмотра».
   */
  applyDependencyGraph(projectId: string, changedKey: SectionKey): {
    affected: Array<{ key: SectionKey; title: string; status: string }>;
  } {
    const dependents = SECTION_DEPENDENCIES[changedKey] ?? [];
    const sections = this.deps.sections.list(projectId);
    const affected: Array<{ key: SectionKey; title: string; status: string }> = [];

    for (const dependentKey of dependents) {
      const section = sections.find((item) => item.key === dependentKey);
      if (!section) continue;
      if (section.status === 'ready' || section.status === 'needs_revision') {
        this.deps.sections.update(projectId, dependentKey, {
          status: 'needs_revision',
          flags: [...new Set([...section.flags, `depends_on:${changedKey}`])],
        });
        affected.push({ key: dependentKey, title: section.title, status: 'needs_revision' });
      } else {
        affected.push({ key: dependentKey, title: section.title, status: section.status });
      }
    }

    return { affected };
  }
}
