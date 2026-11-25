/**
 * Тесты конвейера: INTERVIEW → RESEARCH → SYNTHESIS → ASSEMBLY → TESTING.
 *
 * Модель подменяется фейковым LLMClient — проверяется логика оркестратора,
 * переходы состояний, сохранение версий и честная деградация, когда модель
 * или поиск недоступны.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, type AppContainer } from '../src/server/app.ts';
import { PromptOrchestrator } from '../src/server/engines/orchestrator.ts';
import { InterviewEngine } from '../src/server/engines/interview.ts';
import { ResearchEngine } from '../src/server/engines/research.ts';
import { SectionArchitect } from '../src/server/engines/section-architect.ts';
import { PromptAssembler } from '../src/server/engines/assembler.ts';
import { PromptTester } from '../src/server/engines/tester.ts';
import { AppError } from '../src/server/core/errors.ts';
import { getArchetype } from '../src/server/domain/archetypes.ts';
import { SECTION_KEYS, SECTION_DEPENDENCIES, type SectionKey } from '../src/server/domain/types.ts';
import type { LLMCallResult, LLMRequest } from '../src/server/llm/types.ts';
import type { LLMClient } from '../src/server/llm/client.ts';

/* ─────────────────────────── Фейковая модель ─────────────────────────── */

interface FakeCall {
  operation: string;
  json: boolean;
  system: string;
}

interface FakeClient {
  calls: FakeCall[];
  router: { snapshot: () => Record<string, unknown> };
  call: (input: {
    operation: string;
    messages: Array<{ role: string; content: string }>;
    json?: boolean;
    [key: string]: unknown;
  }) => Promise<LLMCallResult>;
}

const PLAN = {
  title: 'Промт для код-ревью',
  archetype: 'ai_programmer',
  sections: [
    { key: 'role', title: 'ROLE — Роль', focus: 'роль ревьюера', why: 'задаёт поведение' },
    { key: 'objective', title: 'OBJECTIVE — Цель', focus: 'что проверять', why: 'определяет результат' },
    { key: 'constraints', title: 'CONSTRAINTS — Ограничения', focus: 'границы', why: 'защищает от лишнего' },
  ],
  interviewOutline: ['кто пользователь', 'какой стек'],
  researchPlan: ['code review prompt best practices'],
  risks: ['размытая цель'],
  decisions: [],
};

const SECTION_CONTENT =
  '## ROLE — Роль\n\nТы senior-ревьюер TypeScript-кода. Проверяй типы, границы ошибок и читаемость.\n' +
  'Не переписывай код целиком: указывай конкретные места и предлагай точечные правки.';

function sectionBody(key: string): string {
  return `## ${key}\n\n${SECTION_CONTENT}`;
}

function reply(input: { operation: string; messages: Array<{ role: string; content: string }>; json?: boolean }): string {
  const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
  const json = input.json === true;

  if (!json) {
    // callText: ответ целевой модели на тестовый запрос.
    return `${'Ответ целевой модели, который демонстрирует соблюдение роли, формата и ограничений. '.repeat(4)}Конец ответа.`;
  }

  switch (input.operation) {
    case 'question_planning':
      // Одна и та же операция используется и для плана, и для вопросов.
      if (system.includes('Проектируешь план интервью')) return JSON.stringify(PLAN);
      return JSON.stringify({
        questions: [
          {
            id: 'q1',
            text: 'Кто будет пользоваться промтом?',
            why: 'влияет на уровень объяснений',
            options: [{ label: 'Разработчик', description: 'технический тон' }],
            allowSkip: true,
            critical: true,
          },
        ],
        note: 'Начнём с аудитории',
        missing: ['аудитория'],
        sectionReady: false,
      });

    case 'answer_analysis':
      return JSON.stringify({
        understood: ['аудитория — разработчик'],
        requirements: ['Тон технический, без объяснения базовых понятий'],
        assumptions: [],
        gaps: [],
        contradictions: [],
        needsClarification: false,
        clarifyingQuestions: [],
        readyForResearch: true,
      });

    case 'section_synthesis':
      return JSON.stringify({
        content: sectionBody(system.includes('CONSTRAINTS') ? 'constraints' : 'role'),
        summary: 'Роль ревьюера',
        requirementsCaptured: ['технический тон'],
        decisions: [{ question: 'тон', choice: 'технический', source: 'user' }],
        fromResearch: [],
        rejected: [],
        openQuestions: [],
        alternatives: [
          {
            label: 'Вариант 2 — менторский',
            content:
              '## ROLE — Роль\n\nТы наставник, который объясняет замечания и помогает разработчику вырасти. ' +
              'Разбирай каждую правку и предлагай упражнения.',
            rationale: 'мягче и обучающе',
          },
        ],
        confidence: 85,
      });

    case 'quality_check':
      return JSON.stringify({
        criteria: [
          { key: 'fit', label: 'Соответствие задаче', weight: 0.2, score: 88, note: 'по теме' },
          { key: 'completeness', label: 'Полнота', weight: 0.15, score: 84, note: 'достаточно' },
          { key: 'clarity', label: 'Однозначность', weight: 0.15, score: 86, note: 'ясно' },
          { key: 'applicability', label: 'Применимость', weight: 0.15, score: 85, note: 'применимо' },
          { key: 'coherence', label: 'Согласованность', weight: 0.15, score: 87, note: 'связно' },
          { key: 'professionalism', label: 'Профессионализм', weight: 0.1, score: 90, note: 'глубоко' },
          { key: 'consistency', label: 'Нет противоречий', weight: 0.1, score: 89, note: 'чисто' },
        ],
        mandatory: [
          { key: 'requirements', label: 'Учтены требования', passed: true, note: '' },
          { key: 'no_conflicts', label: 'Нет противоречий', passed: true, note: '' },
          { key: 'applicable_format', label: 'Формат применим', passed: true, note: '' },
          { key: 'feasible', label: 'Выполнимо', passed: true, note: '' },
        ],
        issues: [],
        verdict: 'pass',
      });

    case 'final_assembly':
      return JSON.stringify({
        prompt:
          '# Промт: ревью TypeScript-кода\n\n## ROLE\nТы senior-ревьюер TypeScript. Проверяй типы и читаемость.\n\n' +
          '## OBJECTIVE\nДай конкретные замечания по коду.\n\n## CONSTRAINTS\nНе переписывай код целиком.',
        purpose: 'Ревью TypeScript-кода',
        usage: ['Вставьте промт как системную инструкцию'],
        assumptions: [],
        limitations: [],
        improvements: [],
        conflictsResolved: [],
      });

    case 'test_generation':
      return JSON.stringify({
        cases: [
          {
            id: 't1',
            title: 'Типовой запрос',
            userMessage: 'Проверь этот код: const a = 1',
            checks: ['соблюдена роль'],
            category: 'typical',
          },
        ],
      });

    case 'test_evaluation':
      return JSON.stringify({
        results: [{ id: 't1', score: 91, passed: true, violations: [], notes: 'роль соблюдена' }],
        verdict: 'pass',
        summary: 'Промт работает на целевой модели',
        recommendations: [],
      });

    case 'research_queries':
      return JSON.stringify({ queries: ['typescript code review prompt'] });

    case 'source_analysis':
      return JSON.stringify({
        sources: [],
        synthesis: { findings: ['явно задавай критерии ревью'], recommendedPractices: [], avoid: [], disagreements: [] },
      });

    default:
      return JSON.stringify({});
  }
}

function fakeClient(options: { failOperations?: Set<string> } = {}): FakeClient {
  const calls: FakeCall[] = [];
  return {
    calls,
    router: { snapshot: () => ({ providers: [], routes: [], capturedAt: '2026-01-01T00:00:00.000Z' }) },
    async call(input) {
      const system = input.messages.find((message) => message.role === 'system')?.content ?? '';
      calls.push({ operation: input.operation, json: input.json === true, system });

      if (options.failOperations?.has(input.operation)) {
        throw new AppError('PROVIDER_NOT_CONFIGURED', 'LLM-провайдер не настроен');
      }

      const text = reply(input);
      return {
        text,
        model: 'fake-model',
        usage: { inputTokens: 120, outputTokens: 60, estimated: false },
        finishReason: 'stop',
        durationMs: 3,
        route: {
          providerId: 'prv_fake',
          providerName: 'Fake Provider',
          model: 'fake-model',
          fallbackUsed: false,
          retries: 0,
        },
      } satisfies LLMCallResult;
    },
  };
}

/* ─────────────────────────── Сборка конвейера ─────────────────────────── */

interface Pipeline {
  app: AppContainer;
  orchestrator: PromptOrchestrator;
  client: FakeClient;
}

function pipeline(options: { failOperations?: Set<string> } = {}): Pipeline {
  const app = createApp({ databasePath: ':memory:' });
  const client = fakeClient(options);
  const llm = client as unknown as LLMClient;

  const interview = new InterviewEngine({
    client: llm,
    projects: app.projects,
    sections: app.sections,
    messages: app.messages,
  });
  const research = new ResearchEngine({
    client: llm,
    search: app.search,
    sources: app.sources,
    sections: app.sections,
    settings: app.settings,
  });
  const architect = new SectionArchitect({
    client: llm,
    sections: app.sections,
    sources: app.sources,
    projects: app.projects,
  });
  const assembler = new PromptAssembler(llm);
  const tester = new PromptTester(llm);

  const orchestrator = new PromptOrchestrator({
    projects: app.projects,
    sections: app.sections,
    messages: app.messages,
    sources: app.sources,
    versions: app.versions,
    settings: app.settings,
    interview,
    research,
    architect,
    assembler,
    tester,
    client: llm,
  });

  return { app, orchestrator, client };
}

function newProject(app: AppContainer, mode: 'quick' | 'professional' | 'expert' = 'professional') {
  return app.projects.create({
    title: 'Ревью TS-кода',
    idea: 'Нужен промт для senior-ревьюера TypeScript-кода с акцентом на типы и читаемость',
    mode,
    audience: 'Тимлиды и senior-разработчики',
  });
}

/* ─────────────────────────── Инициализация ─────────────────────────── */

test('initialize: план модели создаёт разделы и переводит проект в интервью', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);

  const result = await orchestrator.initialize(project.id);

  assert.equal(result.plan.source, 'llm');
  assert.equal(result.plan.providerName, 'Fake Provider');
  assert.equal(result.project.stage, 'interview');
  assert.equal(result.project.status, 'interviewing');
  assert.equal(result.project.title, PLAN.title);

  // Модель вернула три раздела, но критичные для архетипа разделы добавляются
  // принудительно: терять их нельзя даже при неполном плане модели.
  const keys = result.sections.map((section) => section.key);
  for (const key of ['role', 'objective', 'constraints'] as const satisfies readonly SectionKey[]) {
    assert.ok(keys.includes(key), `ожидался раздел ${key}`);
  }
  const critical = getArchetype('ai_programmer').criticalSections;
  assert.equal(result.sections.length, critical.length);
  assert.deepEqual([...keys].sort(), [...critical].sort());

  // Порядок разделов канонический, а не порядок ответа модели.
  assert.deepEqual(keys, [...keys].sort((a, b) => SECTION_KEYS.indexOf(a as never) - SECTION_KEYS.indexOf(b as never)));

  assert.equal(app.sections.progress(project.id).total, critical.length);

  // Событие плана попадает в историю.
  const events = app.messages.list(project.id).filter((message) => message.kind === 'event');
  assert.equal(events.length, 1);
  assert.match(events[0].content, /План интервью составлен/);

  // Повторная инициализация — конфликт, а не дубли разделов.
  await assert.rejects(orchestrator.initialize(project.id), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'CONFLICT');
    return true;
  });
  assert.equal(app.sections.list(project.id).length, critical.length);
});

test('initialize: при недоступной модели применяется резервный план по архетипу', async () => {
  const { app, orchestrator } = pipeline({ failOperations: new Set(['question_planning']) });
  const project = newProject(app);

  const result = await orchestrator.initialize(project.id);

  assert.equal(result.plan.source, 'heuristic');
  assert.ok(result.plan.sections.length > 0);
  // Критичный раздел архетипа программиста обязан присутствовать.
  assert.ok(result.plan.sections.some((section) => section.key === 'role'));
  assert.equal(result.project.stage, 'interview');
  // Факт деградации зафиксирован в истории, а не скрыт.
  assert.match(
    app.messages.list(project.id).find((message) => message.kind === 'event')?.content ?? '',
    /резервный план/,
  );
});

/* ─────────────────────────── Интервью ─────────────────────────── */

test('interview: вопросы, ответ пользователя и накопление требований', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);

  const asked = await orchestrator.askQuestions(project.id, 'role');
  assert.equal(asked.questions.length, 1);
  assert.equal(asked.questions[0].id, 'q1');
  assert.deepEqual(asked.questions[0].options.map((option) => option.label), ['Разработчик']);
  assert.equal(app.sections.get(project.id, 'role').status, 'awaiting_answer');

  const questions = app.messages.list(project.id, 'role').filter((message) => message.kind === 'question');
  assert.equal(questions.length, 1);
  assert.match(questions[0].content, /Кто будет пользоваться промтом\?/);
  // Варианты ответа сохраняются в метаданных для интерфейса.
  assert.equal((questions[0].meta as { options: unknown[] }).options.length, 1);

  const submitted = await orchestrator.submitAnswer({
    projectId: project.id,
    sectionKey: 'role',
    answer: 'Промтом пользуется разработчик, объяснения базовых вещей не нужны',
  });

  assert.equal(submitted.analysis.source, 'llm');
  assert.deepEqual(submitted.section.requirements, ['Тон технический, без объяснения базовых понятий']);
  assert.equal(submitted.section.decisions[0].source, 'user');
  assert.equal(submitted.section.openQuestions.length, 0);

  // Ответ пользователя сохранён как сообщение.
  const answers = app.messages.list(project.id, 'role').filter((message) => message.kind === 'answer');
  assert.equal(answers.length, 1);
  assert.equal(answers[0].role, 'user');
});

test('interview: уточнение фиксируется как needs_clarification и добавляет вопрос', async () => {
  const { app, orchestrator, client } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.askQuestions(project.id, 'role');

  // Подменяем ответ анализа на «нужно уточнение».
  const originalCall = client.call;
  client.call = async (input) => {
    if (input.operation === 'answer_analysis') {
      return {
        text: JSON.stringify({
          understood: [],
          requirements: [],
          assumptions: [],
          gaps: ['не указан стек'],
          contradictions: [],
          needsClarification: true,
          clarifyingQuestions: [
            { text: 'Какой стек используется?', why: 'влияет на примеры', options: [], allowSkip: false, critical: true },
          ],
          readyForResearch: false,
        }),
        model: 'fake-model',
        usage: { inputTokens: 10, outputTokens: 10, estimated: false },
        finishReason: 'stop',
        durationMs: 1,
        route: { providerId: 'prv_fake', providerName: 'Fake', model: 'fake-model', fallbackUsed: false, retries: 0 },
      } satisfies LLMCallResult;
    }
    return originalCall(input);
  };

  const result = await orchestrator.submitAnswer({
    projectId: project.id,
    sectionKey: 'role',
    answer: 'Сделай хорошо',
  });

  assert.equal(result.section.status, 'needs_clarification');
  assert.deepEqual(result.section.openQuestions, ['не указан стек']);
  assert.equal(app.messages.lastQuestion(project.id, 'role')?.content, 'Какой стек используется?');
});

test('interview: лимит вопросов режима останавливает опрос', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app, 'quick');
  await orchestrator.initialize(project.id);

  // quick: maxQuestionsPerSection = 2 → третий раунд закрывает раздел.
  app.messages.add({ projectId: project.id, sectionKey: 'role', role: 'assistant', kind: 'question', content: 'q1' });
  app.messages.add({ projectId: project.id, sectionKey: 'role', role: 'assistant', kind: 'question', content: 'q2' });

  const result = await orchestrator.askQuestions(project.id, 'role');
  assert.equal(result.questions.length, 0);
  assert.equal(result.sectionReady, true);
  assert.match(result.note, /лимит вопросов/);
});

/* ─────────────────────────── Исследование ─────────────────────────── */

test('research: без поискового провайдера статус unavailable, а не выдуманные источники', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app, 'professional');
  await orchestrator.initialize(project.id);

  const outcome = await orchestrator.researchSection(project.id, 'role');

  assert.equal(outcome.research.status, 'unavailable');
  assert.equal(outcome.sources.length, 0);
  assert.equal(outcome.findings.length, 0);
  assert.match(outcome.research.message, /Поисковый провайдер не настроен/);
  assert.equal(app.sources.list(project.id).length, 0);
});

test('research: в режиме quick исследование помечено skipped', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app, 'quick');
  await orchestrator.initialize(project.id);

  const outcome = await orchestrator.researchSection(project.id, 'role');
  assert.equal(outcome.research.status, 'skipped');
  assert.match(outcome.research.message, /исследование разделов отключено/);
});

/* ─────────────────────────── Синтез ─────────────────────────── */

test('synthesis: раздел синтезируется, получает оценку и помечает зависимые', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.askQuestions(project.id, 'role');
  await orchestrator.submitAnswer({
    projectId: project.id,
    sectionKey: 'role',
    answer: 'Пользователь — разработчик, нужен технический тон',
  });

  const result = await orchestrator.synthesizeSection(project.id, 'role');
  const section = app.sections.get(project.id, 'role');

  assert.equal(result.result.source, 'llm');
  assert.equal(section.status, 'ready');
  assert.ok(section.content.length > 40);
  assert.equal(section.alternatives.length, 1);
  // Взвешенная сумма по критериям: 88·0.2 + 84·0.15 + 86·0.15 + 85·0.15 + 87·0.15 + 90·0.1 + 89·0.1 = 86.8 → 87.
  assert.equal(section.quality?.total, 87);
  assert.equal(section.quality?.verdict, 'pass');
  assert.equal(section.quality?.heuristic, false);

  // role влияет на expertise, methodology, workflow и constraints.
  assert.deepEqual(
    result.affected.map((item) => item.key).sort(),
    [...SECTION_DEPENDENCIES.role].sort(),
  );
});

test('synthesis: при сбое модели раздел собирается из требований и честно помечается', async () => {
  const { app, orchestrator } = pipeline({ failOperations: new Set(['section_synthesis']) });
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  app.sections.update(project.id, 'role', {
    requirements: ['Тон технический', 'Без объяснения базовых понятий'],
  });

  const result = await orchestrator.synthesizeSection(project.id, 'role', { evaluate: false });
  const section = app.sections.get(project.id, 'role');

  assert.equal(result.result.source, 'heuristic');
  assert.equal(section.status, 'needs_revision');
  assert.match(section.content, /Тон технический/);
  assert.equal(section.quality?.heuristic, true);
  assert.equal(result.result.providerName, '');
});

/* ─────────────────────────── Сборка ─────────────────────────── */

test('assemble: сохраняет версию и переводит проект в review', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');

  const { assembly, versionId } = await orchestrator.assemble(project.id);

  assert.match(assembly.prompt, /# Промт: ревью TypeScript-кода/);
  assert.equal(assembly.source, 'llm');
  assert.equal(assembly.providerName, 'Fake Provider');
  assert.ok(assembly.prompt.length > 100);

  const version = app.versions.get(versionId);
  assert.equal(version.prompt, assembly.prompt);
  assert.equal(app.versions.list(project.id).length, 1);

  const after = app.projects.get(project.id);
  assert.equal(after.stage, 'review');
  assert.equal(after.status, 'complete');
  // Снимок маршрутизации сохранён в проекте.
  assert.ok(Object.keys(after.providerSnapshot).length > 0);
});

test('assemble: без синтезированных разделов — CONFLICT', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);

  await assert.rejects(orchestrator.assemble(project.id), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'CONFLICT');
    return true;
  });
});

test('assemble: без модели — детерминированная сборка с явной пометкой', async () => {
  const { app, orchestrator } = pipeline({ failOperations: new Set(['final_assembly']) });
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');

  const { assembly } = await orchestrator.assemble(project.id);

  assert.equal(assembly.source, 'deterministic');
  assert.match(assembly.prompt, /## ROLE/);
  assert.match(assembly.limitations.join(' '), /без модели/);
  assert.equal(assembly.quality.total > 0, true);
});

/* ─────────────────────────── Тестирование промта ─────────────────────────── */

test('testing: реальные ответы модели оцениваются и сохраняются', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');
  await orchestrator.assemble(project.id);

  const outcome = await orchestrator.testPrompt(project.id, { count: 1 });

  assert.equal(outcome.executed, true);
  assert.equal(outcome.verdict, 'pass');
  assert.equal(outcome.results.length, 1);
  assert.equal(outcome.results[0].score, 91);
  assert.equal(outcome.results[0].passed, true);
  assert.equal(outcome.model, 'fake-model');
  assert.equal(app.projects.get(project.id).stage, 'done');

  const events = app.messages.list(project.id).filter((message) => message.kind === 'event');
  assert.match(events.at(-1)?.content ?? '', /Тестирование выполнено/);
});

test('testing: без сохранённой версии — NOT_FOUND', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);

  await assert.rejects(orchestrator.testPrompt(project.id), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('testing: если ни один запрос не дошёл до модели, вердикт not_run', async () => {
  const { app, orchestrator, client } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');
  await orchestrator.assemble(project.id);

  // Ломаем только текстовые вызовы (прогон тестов), генерация кейсов работает.
  const originalCall = client.call;
  client.call = async (input) => {
    if (input.operation === 'test_generation' && input.json !== true) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'провайдер недоступен');
    }
    return originalCall(input);
  };

  const outcome = await orchestrator.testPrompt(project.id, { count: 1 });

  assert.equal(outcome.executed, false);
  assert.equal(outcome.verdict, 'not_run');
  assert.match(outcome.summary, /Тесты не выполнены/);
  assert.equal(outcome.results[0].passed, false);
  assert.match(outcome.results[0].error ?? '', /PROVIDER_UNAVAILABLE/);
});

/* ─────────────────────────── Состояние и снимок ─────────────────────────── */

test('snapshot: отражает политику режима и прогресс', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app, 'expert');
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');

  const snapshot = orchestrator.snapshot(project.id);
  const criticalTotal = getArchetype('ai_programmer').criticalSections.length;

  assert.equal(snapshot.policy.id, 'expert');
  assert.equal(snapshot.progress.total, criticalTotal);
  assert.equal(snapshot.progress.ready, 1);
  assert.match(snapshot.modeNotice, /тестирование на целевой модели: включено/);
  assert.equal(snapshot.sections.length, criticalTotal);
});

test('summary: считает версии и прогресс для списка проектов', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);
  await orchestrator.initialize(project.id);
  await orchestrator.synthesizeSection(project.id, 'role');
  await orchestrator.assemble(project.id);

  const summary = orchestrator.summary(project.id);
  assert.equal(summary.versions, 1);
  assert.equal(summary.sectionsTotal, getArchetype('ai_programmer').criticalSections.length);
  assert.equal(summary.sectionsReady, 1);
});

test('events: поток событий конвейера содержит этапы и итог', async () => {
  const { app, orchestrator } = pipeline();
  const project = newProject(app);

  const events: string[] = [];
  await orchestrator.initialize(project.id, (event) => events.push(`${event.type}:${event.message}`));

  assert.ok(events.some((event) => event.startsWith('stage:')));
  assert.ok(events.some((event) => event.startsWith('plan:')));
});
