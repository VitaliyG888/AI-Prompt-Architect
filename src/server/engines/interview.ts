/**
 * Interview Engine: планирование вопросов, анализ ответов, выявление пробелов.
 *
 * Ключевые правила:
 *  - не считать отсутствие ответа согласием;
 *  - различать подтверждённые требования, выбор пользователя, рекомендации AI
 *    и неподтверждённые предположения;
 *  - уважать лимит вопросов режима и не превращать интервью в бесконечный опрос;
 *  - при отсутствии LLM работать в деградированном режиме (детерминированные
 *    вопросы из архетипа), явно помечая это.
 */
import type { LLMClient } from '../llm/client.ts';
import type { ProjectRecord, SectionKey, SectionRecord } from '../domain/types.ts';
import { MODE_POLICIES, SECTION_TITLES } from '../domain/types.ts';
import { getArchetype, detectArchetype } from '../domain/archetypes.ts';
import { answerAnalysisPrompt, planPrompt, questionPrompt } from '../domain/prompts.ts';
import { callJson } from './llmjson.ts';
import { buildStructuredContext, sectionTranscript } from './state.ts';
import type { MessageRepository } from '../db/repo/messages.ts';
import type { SectionRepository } from '../db/repo/sections.ts';
import type { ProjectRepository } from '../db/repo/projects.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';

export interface InterviewQuestion {
  id: string;
  text: string;
  why: string;
  options: Array<{ label: string; description: string }>;
  allowSkip: boolean;
  critical: boolean;
}

export interface QuestionPlan {
  questions: InterviewQuestion[];
  note: string;
  missing: string[];
  sectionReady: boolean;
  source: 'llm' | 'heuristic';
  providerName?: string;
  model?: string;
}

export interface AnswerAnalysis {
  understood: string[];
  requirements: string[];
  assumptions: string[];
  gaps: string[];
  contradictions: string[];
  needsClarification: boolean;
  clarifyingQuestions: InterviewQuestion[];
  readyForResearch: boolean;
  source: 'llm' | 'heuristic';
}

export interface ProjectPlan {
  title: string;
  archetype: string;
  sections: Array<{ key: SectionKey; title: string; focus: string; why: string }>;
  interviewOutline: string[];
  researchPlan: string[];
  risks: string[];
  decisions: Array<{ question: string; choice: string; rationale: string }>;
  source: 'llm' | 'heuristic';
  providerName?: string;
  model?: string;
}

const VALID_KEYS = new Set(Object.keys(SECTION_TITLES));

function normalizeQuestions(raw: unknown, limit: number): InterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: InterviewQuestion[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (!text) continue;
    const options = Array.isArray(record.options)
      ? record.options
          .map((option) => {
            if (!option || typeof option !== 'object') return null;
            const opt = option as Record<string, unknown>;
            const label = typeof opt.label === 'string' ? opt.label.trim() : '';
            if (!label) return null;
            return { label, description: typeof opt.description === 'string' ? opt.description : '' };
          })
          .filter((option): option is { label: string; description: string } => option !== null)
          .slice(0, 5)
      : [];
    out.push({
      id: typeof record.id === 'string' && record.id ? record.id : `q${index + 1}`,
      text,
      why: typeof record.why === 'string' ? record.why : '',
      options,
      allowSkip: record.allowSkip !== false,
      critical: record.critical === true,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export class InterviewEngine {
  private readonly client: LLMClient;
  private readonly projects: ProjectRepository;
  private readonly sections: SectionRepository;
  private readonly messages: MessageRepository;

  constructor(deps: {
    client: LLMClient;
    projects: ProjectRepository;
    sections: SectionRepository;
    messages: MessageRepository;
  }) {
    this.client = deps.client;
    this.projects = deps.projects;
    this.sections = deps.sections;
    this.messages = deps.messages;
  }

  /**
   * План интервью. Если LLM недоступна, возвращает детерминированный план по
   * архетипу и честно помечает источник как heuristic.
   */
  async plan(project: ProjectRecord, signal?: AbortSignal): Promise<ProjectPlan> {
    const archetypeId = detectArchetype(project.idea);
    const archetype = getArchetype(archetypeId);
    const sectionTitles = Object.entries(SECTION_TITLES).map(([key, title]) => ({ key, title }));

    try {
      const result = await callJson<{
        title?: string;
        sections?: Array<{ key?: string; title?: string; focus?: string; why?: string }>;
        interviewOutline?: unknown;
        researchPlan?: unknown;
        risks?: unknown;
        decisions?: unknown;
      }>(this.client, {
        operation: 'question_planning',
        messages: (() => {
          const pair = planPrompt({
            idea: project.idea,
            audience: project.audience,
            targetModel: project.targetModel,
            mode: project.mode,
            archetypeLabel: archetype.label,
            archetypeId,
            sectionTitles,
          });
          return [
            { role: 'system', content: pair.system },
            { role: 'user', content: pair.user },
          ];
        })(),
        expect: 'object',
        projectId: project.id,
        signal,
        maxOutputTokens: 3000,
      });

      const rawSections = Array.isArray(result.data.sections) ? result.data.sections : [];
      const sections = rawSections
        .map((item, index) => {
          const key = typeof item.key === 'string' ? item.key : '';
          if (!VALID_KEYS.has(key)) return null;
          return {
            key: key as SectionKey,
            title: typeof item.title === 'string' && item.title ? item.title : SECTION_TITLES[key as SectionKey],
            focus: typeof item.focus === 'string' ? item.focus : '',
            why: typeof item.why === 'string' ? item.why : '',
            order: index,
          };
        })
        .filter((item): item is { key: SectionKey; title: string; focus: string; why: string; order: number } => item !== null);

      const deduped = new Map<SectionKey, { key: SectionKey; title: string; focus: string; why: string }>();
      for (const section of sections) {
        if (!deduped.has(section.key)) deduped.set(section.key, section);
      }
      // Критичные разделы архетипа нельзя терять, даже если модель их пропустила.
      for (const key of archetype.criticalSections) {
        if (!deduped.has(key)) deduped.set(key, { key, title: SECTION_TITLES[key], focus: '', why: '' });
      }

      if (deduped.size === 0) throw new AppError('VALIDATION_FAILED', 'Модель вернула пустой список разделов');

      const orderedKeys = Object.keys(SECTION_TITLES) as SectionKey[];
      const resultSections = [...deduped.values()].sort(
        (a, b) => orderedKeys.indexOf(a.key) - orderedKeys.indexOf(b.key),
      );

      return {
        title: typeof result.data.title === 'string' && result.data.title ? result.data.title : project.title,
        archetype: archetypeId,
        sections: resultSections,
        interviewOutline: Array.isArray(result.data.interviewOutline)
          ? result.data.interviewOutline.filter((item): item is string => typeof item === 'string')
          : [],
        researchPlan: Array.isArray(result.data.researchPlan)
          ? result.data.researchPlan.filter((item): item is string => typeof item === 'string')
          : [],
        risks: Array.isArray(result.data.risks)
          ? result.data.risks.filter((item): item is string => typeof item === 'string')
          : [],
        decisions: Array.isArray(result.data.decisions)
          ? result.data.decisions
              .map((item) => {
                if (!item || typeof item !== 'object') return null;
                const record = item as Record<string, unknown>;
                if (typeof record.question !== 'string' || typeof record.choice !== 'string') return null;
                return {
                  question: record.question,
                  choice: record.choice,
                  rationale: typeof record.rationale === 'string' ? record.rationale : '',
                };
              })
              .filter((item): item is { question: string; choice: string; rationale: string } => item !== null)
          : [],
        source: 'llm',
        providerName: result.providerName,
        model: result.model,
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('interview plan fell back to heuristic', { code: appError.code, message: appError.message });
      return {
        title: project.title,
        archetype: archetypeId,
        sections: archetype.criticalSections.map((key) => ({
          key,
          title: SECTION_TITLES[key],
          focus: archetype.probes[key]?.join('; ') ?? '',
          why: '',
        })),
        interviewOutline: archetype.criticalSections.flatMap((key) => archetype.probes[key] ?? []).slice(0, 8),
        researchPlan: archetype.researchTemplates,
        risks: archetype.risks,
        decisions: [],
        source: 'heuristic',
      };
    }
  }

  /** Следующий раунд вопросов по разделу. */
  async nextQuestions(project: ProjectRecord, sectionKey: SectionKey, signal?: AbortSignal): Promise<QuestionPlan> {
    const section = this.sections.get(project.id, sectionKey);
    const policy = MODE_POLICIES[project.mode];
    const history = this.messages.list(project.id, sectionKey, 100);
    const asked = history.filter((message) => message.kind === 'question').map((message) => message.content);
    const round = history.filter((message) => message.kind === 'question').length + 1;

    if (round > policy.maxQuestionsPerSection) {
      return {
        questions: [],
        note: `Достигнут лимит вопросов режима ${policy.label}. Можно переходить к синтезу раздела.`,
        missing: section.openQuestions,
        sectionReady: true,
        source: 'heuristic',
      };
    }

    try {
      const pair = questionPrompt({
        idea: project.idea,
        audience: project.audience,
        targetModel: project.targetModel,
        mode: project.mode,
        section,
        transcript: sectionTranscript(history),
        askedQuestions: asked,
        round,
        maxQuestions: policy.maxQuestionsPerSection,
      });

      const result = await callJson<{
        questions?: unknown;
        note?: unknown;
        missing?: unknown;
        sectionReady?: unknown;
      }>(this.client, {
        operation: 'question_planning',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: project.id,
        signal,
        maxOutputTokens: 1800,
      });

      const questions = normalizeQuestions(result.data.questions, Math.min(3, policy.maxQuestionsPerSection));
      return {
        questions,
        note: typeof result.data.note === 'string' ? result.data.note : '',
        missing: Array.isArray(result.data.missing)
          ? result.data.missing.filter((item): item is string => typeof item === 'string')
          : [],
        sectionReady: result.data.sectionReady === true || questions.length === 0,
        source: 'llm',
        providerName: result.providerName,
        model: result.model,
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('question generation fell back to heuristic', { code: appError.code });
      const archetype = getArchetype(detectArchetype(project.idea));
      const probes = archetype.probes[sectionKey] ?? [];
      return {
        questions: probes.slice(0, 2).map((probe, index) => ({
          id: `h${index + 1}`,
          text: `Уточните: ${probe}`,
          why: 'Стандартный вопрос для этого типа задачи (LLM недоступна)',
          options: [],
          allowSkip: true,
          critical: index === 0,
        })),
        note:
          appError.code === 'PROVIDER_NOT_CONFIGURED'
            ? 'LLM-провайдер не настроен — показаны типовые вопросы. Настройте провайдера в Settings → AI Providers.'
            : `Не удалось получить вопросы от модели (${appError.message}). Показаны типовые вопросы.`,
        missing: probes,
        sectionReady: probes.length === 0,
        source: 'heuristic',
      };
    }
  }

  /** Анализ ответа пользователя: требования, предположения, пробелы, уточнения. */
  async analyzeAnswer(input: {
    project: ProjectRecord;
    sectionKey: SectionKey;
    question: string;
    answer: string;
    signal?: AbortSignal;
  }): Promise<AnswerAnalysis> {
    const section = this.sections.get(input.project.id, input.sectionKey);

    try {
      const pair = answerAnalysisPrompt({
        idea: input.project.idea,
        sectionTitle: section.title,
        question: input.question,
        answer: input.answer,
        existingRequirements: section.requirements,
      });

      const result = await callJson<Record<string, unknown>>(this.client, {
        operation: 'answer_analysis',
        messages: [
          { role: 'system', content: pair.system },
          { role: 'user', content: pair.user },
        ],
        expect: 'object',
        projectId: input.project.id,
        signal: input.signal,
        maxOutputTokens: 1600,
      });

      const strings = (key: string): string[] => {
        const value = result.data[key];
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      };

      return {
        understood: strings('understood'),
        requirements: strings('requirements'),
        assumptions: strings('assumptions'),
        gaps: strings('gaps'),
        contradictions: strings('contradictions'),
        needsClarification: result.data.needsClarification === true,
        clarifyingQuestions: normalizeQuestions(result.data.clarifyingQuestions, 2),
        readyForResearch: result.data.readyForResearch !== false,
        source: 'llm',
      };
    } catch (error) {
      const appError = toAppError(error);
      log.warn('answer analysis fell back to heuristic', { code: appError.code });
      // Деградация: считаем ответ содержательным, если он непустой и длиннее 15 символов.
      const meaningful = input.answer.trim().length > 15;
      return {
        understood: meaningful ? ['Ответ получен'] : [],
        requirements: meaningful ? [`${section.title}: ${input.answer.trim()}`] : [],
        assumptions: [],
        gaps: meaningful ? [] : ['Ответ слишком короткий для проектирования раздела'],
        contradictions: [],
        needsClarification: !meaningful,
        clarifyingQuestions: [],
        readyForResearch: meaningful,
        source: 'heuristic',
      };
    }
  }

  /** Полный контекст проекта для планирования. */
  projectContext(project: ProjectRecord): string {
    return buildStructuredContext(project, this.sections.list(project.id)).project;
  }
}
