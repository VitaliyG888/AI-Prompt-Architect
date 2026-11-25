/**
 * Prompt Orchestrator — управляет этапами и состоянием проекта.
 *
 * Отвечает за переходы stage/status, запуск движков в правильном порядке,
 * сохранение версий и то, чтобы незавершённая работа восстанавливалась
 * после перезапуска приложения.
 *
 * Конвейер: INTERVIEW → RESEARCH → SYNTHESIS → VALIDATION.
 */
import type { ProjectRecord, ProjectStage, ProjectStatus, SectionKey, SectionRecord } from '../domain/types.ts';
import { MODE_POLICIES, SECTION_TITLES } from '../domain/types.ts';
import type { ProjectRepository } from '../db/repo/projects.ts';
import type { SectionRepository } from '../db/repo/sections.ts';
import type { MessageRepository } from '../db/repo/messages.ts';
import type { SourceRepository } from '../db/repo/sources.ts';
import type { VersionRepository } from '../db/repo/versions.ts';
import type { SettingsRepository } from '../db/repo/settings.ts';
import type { InterviewEngine } from './interview.ts';
import type { ResearchEngine } from './research.ts';
import type { SectionArchitect } from './section-architect.ts';
import type { PromptAssembler, AssemblyResult } from './assembler.ts';
import type { PromptTester, TestRunOutcome } from './tester.ts';
import type { LLMClient } from '../llm/client.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { log } from '../core/logger.ts';
import { MODE_POLICIES as POLICIES } from '../domain/types.ts';

export interface WorkflowEvent {
  type: string;
  message: string;
  sectionKey?: string;
  payload?: Record<string, unknown>;
}

export type EventSink = (event: WorkflowEvent) => void;

const STAGE_ORDER: ProjectStage[] = [
  'intake',
  'plan',
  'interview',
  'synthesis',
  'assembly',
  'review',
  'testing',
  'done',
];

export interface OrchestratorDeps {
  projects: ProjectRepository;
  sections: SectionRepository;
  messages: MessageRepository;
  sources: SourceRepository;
  versions: VersionRepository;
  settings: SettingsRepository;
  interview: InterviewEngine;
  research: ResearchEngine;
  architect: SectionArchitect;
  assembler: PromptAssembler;
  tester: PromptTester;
  client: LLMClient;
}

export class PromptOrchestrator {
  private readonly d: OrchestratorDeps;

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
  }

  /** Инициализация проекта: план интервью и создание разделов. */
  async initialize(projectId: string, emit?: EventSink): Promise<{
    project: ProjectRecord;
    sections: SectionRecord[];
    plan: Awaited<ReturnType<InterviewEngine['plan']>>;
  }> {
    const project = this.d.projects.get(projectId);
    if (project.stage !== 'intake' && this.d.sections.list(projectId).length > 0) {
      throw new AppError('CONFLICT', 'Проект уже инициализирован');
    }

    emit?.({ type: 'stage', message: 'Составляем план интервью…' });
    const plan = await this.d.interview.plan(project);
    emit?.({
      type: 'plan',
      message: `План готов: ${plan.sections.length} разделов (${plan.source === 'llm' ? 'модель' : 'резервный план'})`,
      payload: { archetype: plan.archetype, source: plan.source },
    });

    const sections = this.d.sections.createMany(projectId, plan.sections);

    const updated = this.d.projects.update(projectId, {
      title: plan.title || project.title,
      stage: 'interview',
      status: 'interviewing',
      settings: {
        ...project.settings,
        archetype: plan.archetype,
        planSource: plan.source,
        risks: plan.risks,
        interviewOutline: plan.interviewOutline,
        decisions: plan.decisions,
      },
    });

    this.d.messages.add({
      projectId,
      role: 'assistant',
      kind: 'event',
      content: `План интервью составлен (${plan.source === 'llm' ? 'модель' : 'резервный план по архетипу'}). Разделов: ${plan.sections.length}.`,
      meta: { archetype: plan.archetype, providerName: plan.providerName, model: plan.model },
    });

    return { project: updated, sections, plan };
  }

  /**
   * Следующие вопросы по разделу с записью в историю.
   *
   * Метод идемпотентен по открытому вопросу: если в разделе уже есть вопрос
   * без ответа, он и возвращается. Иначе повторный вызов (интерфейс после
   * перезагрузки, двойной клик, восстановление сессии) сжигал бы раунд,
   * упирался в лимит режима и закрывал раздел «готов к сборке», оставляя
   * заданный вопрос висеть без ответа.
   */
  async askQuestions(projectId: string, sectionKey: SectionKey): Promise<{
    questions: Awaited<ReturnType<InterviewEngine['nextQuestions']>>['questions'];
    note: string;
    sectionReady: boolean;
    source: string;
  }> {
    const project = this.d.projects.get(projectId);
    const pending = this.d.messages.pendingQuestions(projectId, sectionKey)[0] ?? null;

    if (pending) {
      const meta = pending.meta as Record<string, unknown>;
      return {
        questions: [
          {
            id: String(meta.id ?? ''),
            text: String(meta.text ?? pending.content),
            why: typeof meta.why === 'string' ? meta.why : '',
            options: Array.isArray(meta.options)
              ? (meta.options as Array<{ label: string; description: string }>)
              : [],
            critical: meta.critical === true,
            allowSkip: meta.allowSkip !== false,
          },
        ],
        note: '',
        sectionReady: false,
        source: 'pending',
      };
    }

    const result = await this.d.interview.nextQuestions(project, sectionKey);

    // id вопроса должен быть уникален в пределах раздела: модель возвращает
    // "q1" в каждом раунде, и при повторе ответ закрывал бы чужой вопрос.
    const existing = this.d.messages.list(projectId, sectionKey, 400);
    const usedIds = new Set(
      existing
        .filter((message) => message.kind === 'question')
        .map((message) => String((message.meta as Record<string, unknown>).id ?? '')),
    );
    const round = existing.filter((message) => message.kind === 'question').length + 1;

    for (const question of result.questions) {
      const base = question.id || `q${round}`;
      const id = usedIds.has(base) ? `${base}-${round}` : base;
      usedIds.add(id);

      const text = [
        question.text,
        question.why ? `\n_Зачем: ${question.why}_` : '',
        question.options.length
          ? `\n${question.options.map((option, index) => `${index + 1}. **${option.label}**${option.description ? ` — ${option.description}` : ''}`).join('\n')}`
          : '',
      ].join('');

      this.d.messages.add({
        projectId,
        sectionKey,
        role: 'assistant',
        kind: 'question',
        content: text,
        // text/why храним отдельно: интерфейс показывает вопрос карточкой,
        // а не разбирает markdown обратно.
        meta: {
          id,
          text: question.text,
          why: question.why,
          options: question.options,
          critical: question.critical,
          allowSkip: question.allowSkip,
        },
      });
    }

    if (result.questions.length > 0) {
      this.d.sections.update(projectId, sectionKey, { status: 'awaiting_answer' });
    } else if (result.sectionReady) {
      // Интервью по разделу закончено. Это НЕ «требует пересмотра»: раздел
      // готов к сборке, иначе он навсегда остаётся в тупиковом статусе.
      this.d.sections.update(projectId, sectionKey, { status: 'ready_for_synthesis' });
    }

    // Пустые заметки не пишем: они засоряют диалог и сбивают автопрокрутку.
    const noteText =
      result.note || (result.questions.length ? '' : 'Вопросов больше нет — раздел готов к сборке.');
    if (noteText) {
      this.d.messages.add({
        projectId,
        sectionKey,
        role: 'assistant',
        kind: 'note',
        content: noteText,
        meta: { source: result.source, providerName: result.providerName, model: result.model },
      });
    }

    return {
      questions: result.questions,
      note: result.note,
      sectionReady: result.sectionReady,
      source: result.source,
    };
  }

  /** Приём ответа пользователя: анализ требований и сразу следующий шаг. */
  async submitAnswer(input: {
    projectId: string;
    sectionKey: SectionKey;
    answer: string;
    questionId?: string;
  }): Promise<{
    analysis: Awaited<ReturnType<InterviewEngine['analyzeAnswer']>>;
    section: SectionRecord;
    /** Вопрос, который ждёт ответа сейчас (ровно один). */
    nextQuestion: { id: string; text: string; options: Array<{ label: string; description: string }> } | null;
    /** Интервью по разделу закончено — можно собирать. */
    sectionReady: boolean;
  }> {
    const project = this.d.projects.get(input.projectId);
    const lastQuestion = this.d.messages.lastQuestion(input.projectId, input.sectionKey);

    this.d.messages.add({
      projectId: input.projectId,
      sectionKey: input.sectionKey,
      role: 'user',
      kind: 'answer',
      content: input.answer,
      meta: { questionId: input.questionId ?? '', question: lastQuestion?.content.slice(0, 300) ?? '' },
    });

    const analysis = await this.d.interview.analyzeAnswer({
      project,
      sectionKey: input.sectionKey,
      question: lastQuestion?.content ?? '',
      answer: input.answer,
    });

    const section = this.d.sections.get(input.projectId, input.sectionKey);
    const mergedRequirements = [...new Set([...section.requirements, ...analysis.requirements])];
    const flags = [...new Set([...section.flags, ...analysis.assumptions.map((a) => `assumption:${a}`)])];

    this.d.sections.update(input.projectId, input.sectionKey, {
      requirements: mergedRequirements,
      openQuestions: analysis.needsClarification
        ? [...new Set([...section.openQuestions, ...analysis.gaps])]
        : [...new Set(analysis.gaps)],
      flags,
      decisions: [
        ...section.decisions,
        ...analysis.requirements.map((requirement) => ({
          question: lastQuestion?.content.slice(0, 200) ?? '',
          choice: requirement,
          source: 'user' as const,
        })),
      ],
    });

    // Уточнение нужно только если без него раздел нельзя спроектировать.
    // Показываем ровно один уточняющий вопрос: интервью остаётся линейным.
    if (analysis.needsClarification && analysis.clarifyingQuestions.length > 0) {
      const clarifying = analysis.clarifyingQuestions[0];
      // Уточняющий вопрос нумеруем отдельно: он не должен конфликтовать с id
      // вопросов интервью, иначе ответ закроет не тот вопрос.
      const clarifyingId = `c${this.d.messages.list(input.projectId, input.sectionKey, 400).filter((message) => message.kind === 'question').length + 1}`;
      const content = [
        clarifying.text,
        clarifying.why ? `\n_Зачем: ${clarifying.why}_` : '',
        clarifying.options.length
          ? `\n${clarifying.options.map((option, index) => `${index + 1}. **${option.label}**${option.description ? ` — ${option.description}` : ''}`).join('\n')}`
          : '',
      ].join('');

      this.d.messages.add({
        projectId: input.projectId,
        sectionKey: input.sectionKey,
        role: 'assistant',
        kind: 'question',
        content,
        // id уникален в пределах раздела: иначе ответ закроет чужой вопрос.
        meta: { id: clarifyingId, options: clarifying.options, clarifying: true },
      });

      const updated = this.d.sections.update(input.projectId, input.sectionKey, {
        status: 'needs_clarification',
      });
      this.d.projects.touch(input.projectId);

      return {
        analysis,
        section: updated,
        nextQuestion: { id: clarifying.id, text: clarifying.text, options: clarifying.options },
        sectionReady: false,
      };
    }

    // Уточнений не требуется — сразу переходим к следующему вопросу.
    // Ответ на него сохраняется отдельным вызовом, поэтому состояние не теряется
    // и после перезапуска приложения интервью продолжается с того же места.
    await this.askQuestions(input.projectId, input.sectionKey);

    const after = this.d.sections.get(input.projectId, input.sectionKey);
    const open = this.d.messages.pendingQuestions(input.projectId, input.sectionKey);
    const pending = open[0] ?? null;

    return {
      analysis,
      section: after,
      nextQuestion: pending
        ? {
            id: String((pending.meta as Record<string, unknown>).id ?? ''),
            text: String((pending.meta as Record<string, unknown>).text ?? pending.content),
            options: Array.isArray((pending.meta as Record<string, unknown>).options)
              ? ((pending.meta as Record<string, unknown>).options as Array<{ label: string; description: string }>)
              : [],
          }
        : null,
      sectionReady: after.status === 'ready_for_synthesis',
    };
  }

  /** Исследование раздела. */
  async researchSection(projectId: string, sectionKey: SectionKey, force = false): Promise<Awaited<ReturnType<ResearchEngine['research']>>> {
    const project = this.d.projects.get(projectId);
    this.d.sections.update(projectId, sectionKey, { status: 'researching' });
    const outcome = await this.d.research.research(project, sectionKey, { force });

    this.d.messages.add({
      projectId,
      sectionKey,
      role: 'assistant',
      kind: 'event',
      content:
        outcome.research.status === 'done'
          ? `Исследование выполнено: ${outcome.sources.length} источников, ${outcome.findings.length} выводов.`
          : `Исследование: ${outcome.research.message}`,
      meta: { status: outcome.research.status, providers: outcome.providersUsed },
    });

    const nextStatus = outcome.research.status === 'error' ? 'needs_revision' : 'analyzing';
    this.d.sections.update(projectId, sectionKey, { status: nextStatus });
    return outcome;
  }

  /** Синтез раздела + контроль качества + граф зависимостей. */
  async synthesizeSection(
    projectId: string,
    sectionKey: SectionKey,
    options: { feedback?: string; evaluate?: boolean } = {},
  ): Promise<{
    result: Awaited<ReturnType<SectionArchitect['synthesize']>>;
    quality: SectionRecord['quality'];
    affected: Array<{ key: SectionKey; title: string; status: string }>;
  }> {
    const project = this.d.projects.get(projectId);

    // Режимы Professional/Expert требуют исследования перед синтезом.
    const policy = POLICIES[project.mode];
    if (policy.researchPerSection) {
      const section = this.d.sections.get(projectId, sectionKey);
      if (section.research.status === 'pending') {
        await this.researchSection(projectId, sectionKey);
      }
    }

    const result = await this.d.architect.synthesize(project, sectionKey, {
      previousContent: options.feedback ? undefined : this.d.sections.get(projectId, sectionKey).content || undefined,
      feedback: options.feedback,
    });

    if (options.evaluate !== false) {
      await this.d.architect.assess(project, sectionKey);
    }

    const affected = this.d.architect.applyDependencyGraph(projectId, sectionKey);
    const section = this.d.sections.get(projectId, sectionKey);

    this.d.messages.add({
      projectId,
      sectionKey,
      role: 'assistant',
      kind: 'event',
      content: `Раздел «${section.title}» синтезирован (${result.source === 'llm' ? result.providerName : 'резервная сборка'}). Оценка: ${section.quality?.total ?? '—'}.`,
      meta: { affected: affected.affected.map((item) => item.key) },
    });

    this.recomputeStage(projectId);
    return { result, quality: section.quality, affected: affected.affected };
  }

  /**
   * Завершение интервью: анализ материалов по всем разделам и сборка промта.
   *
   * Порядок соответствует требованию продукта:
   *   анализ требований → подбор скиллов и похожих примеров → сборка промта.
   * Раздел без материалов не выдумывается, а честно пропускается с отметкой.
   */
  async finishProject(projectId: string, emit?: EventSink): Promise<{
    sections: Array<{ key: SectionKey; title: string; status: string; total: number | null }>;
    assembly: AssemblyResult;
    versionId: string;
  }> {
    this.d.projects.get(projectId);
    const sections = this.d.sections.list(projectId);
    if (sections.length === 0) {
      throw new AppError('CONFLICT', 'Проект не инициализирован: сначала составьте план интервью');
    }

    const results: Array<{ key: SectionKey; title: string; status: string; total: number | null }> = [];

    for (const section of sections) {
      // Нечего собирать: нет ни требований, ни текста. Пропускаем явно.
      if (section.requirements.length === 0 && section.content.trim().length === 0) {
        emit?.({
          type: 'skip',
          sectionKey: section.key,
          message: `Раздел «${section.title}» пропущен: нет материалов`,
        });
        results.push({ key: section.key, title: section.title, status: section.status, total: null });
        continue;
      }

      emit?.({
        type: 'step',
        sectionKey: section.key,
        message: `Анализ материалов и подбор стандартов: ${section.title}`,
      });

      try {
        const outcome = await this.synthesizeSection(projectId, section.key);
        results.push({
          key: section.key,
          title: section.title,
          status: outcome.result.section.status,
          total: outcome.quality?.total ?? null,
        });
        emit?.({
          type: 'section',
          sectionKey: section.key,
          message: `Раздел готов: ${section.title}`,
          payload: {
            status: outcome.result.section.status,
            total: outcome.quality?.total ?? null,
            skills: outcome.result.skills.map((skill) => skill.label),
            examples: outcome.result.examples.map((example) => example.title),
          },
        });
      } catch (error) {
        // Один неудачный раздел не должен отменять всю сборку.
        emit?.({
          type: 'sectionError',
          sectionKey: section.key,
          message: `Раздел «${section.title}» не собран: ${toAppError(error).message}`,
        });
        results.push({ key: section.key, title: section.title, status: 'needs_revision', total: null });
      }
    }

    emit?.({ type: 'step', message: 'Сборка итогового промта…' });
    const { assembly, versionId } = await this.assemble(projectId);
    emit?.({
      type: 'done',
      message: `Промт собран: ${assembly.prompt.length} символов, версия сохранена`,
      payload: { versionId },
    });

    return { sections: results, assembly, versionId };
  }

  /** Финальная сборка + сохранение версии. */
  async assemble(projectId: string): Promise<{ assembly: AssemblyResult; versionId: string }> {
    const project = this.d.projects.get(projectId);
    const sections = this.d.sections.list(projectId);

    const ready = sections.filter((section) => section.content.trim().length > 0);
    if (ready.length === 0) {
      throw new AppError('CONFLICT', 'Нет синтезированных разделов: сначала пройдите интервью и синтезируйте разделы');
    }

    this.d.projects.update(projectId, { stage: 'assembly', status: 'assembling' });

    const sources = this.d.sources.list(projectId);
    const assembly = await this.d.assembler.assemble({ project, sections, sources });

    // Версия сохраняется всегда: история изменений — требование продукта.
    const version = this.d.versions.create({
      projectId,
      label: `v${this.d.versions.list(projectId).length + 1} — ${new Date().toLocaleString('ru-RU')}`,
      prompt: assembly.prompt,
      quality: {
        total: assembly.quality.total,
        criteria: [],
        mandatory: [],
        issues: [],
        verdict: assembly.quality.verdict,
        evaluatedAt: new Date().toISOString(),
        heuristic: assembly.source !== 'llm',
      },
      meta: {
        purpose: assembly.purpose,
        usage: assembly.usage,
        assumptions: assembly.assumptions,
        limitations: assembly.limitations,
        improvements: assembly.improvements,
        conflictsResolved: assembly.conflictsResolved,
        sources: assembly.sources,
        providerName: assembly.providerName,
        model: assembly.model,
        source: assembly.source,
        sections: assembly.quality.bySection,
      },
    });

    this.d.projects.update(projectId, {
      stage: 'review',
      status: 'complete',
      providerSnapshot: this.d.client.router.snapshot(),
    });

    this.d.messages.add({
      projectId,
      role: 'assistant',
      kind: 'event',
      content: `Финальный промт собран (${assembly.prompt.length} символов). Версия сохранена.`,
      meta: { versionId: version.id, quality: assembly.quality.total },
    });

    return { assembly, versionId: version.id };
  }

  /** Тестирование промта на целевой модели с сохранением результата. */
  async testPrompt(projectId: string, options: { versionId?: string; count?: number } = {}): Promise<TestRunOutcome> {
    const project = this.d.projects.get(projectId);
    const version = options.versionId
      ? this.d.versions.get(options.versionId)
      : this.d.versions.latest(projectId);

    if (!version) {
      throw new AppError('NOT_FOUND', 'Нет сохранённой версии промта: выполните финальную сборку');
    }

    this.d.projects.update(projectId, { stage: 'testing', status: 'testing' });

    try {
      const outcome = await this.d.tester.fullRun({
        project,
        prompt: version.prompt,
        count: options.count ?? (project.mode === 'expert' ? 5 : 3),
      });

      this.d.messages.add({
        projectId,
        role: 'assistant',
        kind: 'event',
        content: outcome.executed
          ? `Тестирование выполнено: ${outcome.results.filter((result) => result.passed).length}/${outcome.results.length} пройдено. Вердикт: ${outcome.verdict}.`
          : `Тестирование не выполнено: ${outcome.summary}`,
        meta: { verdict: outcome.verdict, providerName: outcome.providerName, model: outcome.model },
      });

      this.d.projects.update(projectId, { stage: 'done', status: 'complete' });
      return outcome;
    } catch (error) {
      const appError = toAppError(error);
      log.error('prompt testing failed', { projectId, code: appError.code });
      this.d.projects.update(projectId, { stage: 'testing', status: 'error' });
      throw appError;
    }
  }

  /** Пересчитывает этап проекта по состоянию разделов. */
  recomputeStage(projectId: string): void {
    const project = this.d.projects.get(projectId);
    const sections = this.d.sections.list(projectId);
    if (sections.length === 0) return;

    const withContent = sections.filter((section) => section.content.trim().length > 0).length;
    const researched = sections.filter((section) => section.research.status === 'done').length;

    let stage: ProjectStage = project.stage;
    if (withContent === sections.length) stage = 'review';
    else if (withContent > 0) stage = 'synthesis';
    else if (researched > 0) stage = 'synthesis';
    else if (sections.some((section) => section.requirements.length > 0)) stage = 'interview';

    const currentIndex = STAGE_ORDER.indexOf(project.stage);
    const nextIndex = STAGE_ORDER.indexOf(stage);
    if (nextIndex > currentIndex || stage === 'interview') {
      this.d.projects.update(projectId, { stage });
    }
  }

  /** Полная картина проекта для интерфейса. */
  snapshot(projectId: string): {
    project: ProjectRecord;
    sections: SectionRecord[];
    progress: { total: number; ready: number; percent: number };
    policy: (typeof MODE_POLICIES)[keyof typeof MODE_POLICIES];
    modeNotice: string;
  } {
    const project = this.d.projects.get(projectId);
    const sections = this.d.sections.list(projectId);
    const progress = this.d.sections.progress(projectId);
    const policy = MODE_POLICIES[project.mode];

    const notice = [
      policy.researchPerSection ? 'исследование каждого раздела: включено' : 'исследование: отключено',
      `источников на раздел: ${policy.maxSourcesPerSection}`,
      `альтернатив на раздел: ${policy.alternatives}`,
      policy.testOnTargetModel ? 'тестирование на целевой модели: включено' : 'тестирование: по запросу',
    ].join(' · ');

    return { project, sections, progress, policy, modeNotice: notice };
  }

  /** Сводка по проекту для списка на главной. */
  summary(projectId: string): {
    project: ProjectRecord;
    progress: number;
    sectionsReady: number;
    sectionsTotal: number;
    versions: number;
    lastActivity: string;
  } {
    const project = this.d.projects.get(projectId);
    const progress = this.d.sections.progress(projectId);
    return {
      project,
      progress: progress.percent,
      sectionsReady: progress.ready,
      sectionsTotal: progress.total,
      versions: this.d.versions.list(projectId).length,
      lastActivity: project.updatedAt,
    };
  }
}

export { SECTION_TITLES };
