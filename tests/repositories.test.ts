/**
 * Тесты слоя хранения: CRUD, каскадное удаление, шифрование ключей,
 * нормализация маршрутов и агрегаты использования.
 *
 * Каждый тест работает на отдельной in-memory базе: тесты независимы и не
 * оставляют файлов на диске.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../src/server/db/schema.ts';
import { ProjectRepository } from '../src/server/db/repo/projects.ts';
import { SectionRepository } from '../src/server/db/repo/sections.ts';
import { MessageRepository } from '../src/server/db/repo/messages.ts';
import { SourceRepository } from '../src/server/db/repo/sources.ts';
import { ProviderRepository, toPublicProvider } from '../src/server/db/repo/providers.ts';
import { RouteRepository, OPERATIONS } from '../src/server/db/repo/routes.ts';
import { SearchProviderRepository, toPublicSearch } from '../src/server/db/repo/search.ts';
import { SettingsRepository, DEFAULT_SETTINGS } from '../src/server/db/repo/settings.ts';
import { UsageRepository } from '../src/server/db/repo/usage.ts';
import { VersionRepository } from '../src/server/db/repo/versions.ts';
import { TestRunRepository } from '../src/server/db/repo/tests.ts';
import { AppError } from '../src/server/core/errors.ts';
import type { DatabaseSync } from 'node:sqlite';

interface Harness {
  db: DatabaseSync;
  projects: ProjectRepository;
  sections: SectionRepository;
  messages: MessageRepository;
  sources: SourceRepository;
  providers: ProviderRepository;
  routes: RouteRepository;
  searchProviders: SearchProviderRepository;
  settings: SettingsRepository;
  usage: UsageRepository;
  versions: VersionRepository;
  tests: TestRunRepository;
}

function harness(): Harness {
  const db = openDatabase(':memory:');
  return {
    db,
    projects: new ProjectRepository(db),
    sections: new SectionRepository(db),
    messages: new MessageRepository(db),
    sources: new SourceRepository(db),
    providers: new ProviderRepository(db),
    routes: new RouteRepository(db),
    searchProviders: new SearchProviderRepository(db),
    settings: new SettingsRepository(db),
    usage: new UsageRepository(db),
    versions: new VersionRepository(db),
    tests: new TestRunRepository(db),
  };
}

/* ───────────────────────── Проекты и разделы ───────────────────────── */

test('projects: создание, чтение, обновление, список', () => {
  const h = harness();
  const created = h.projects.create({
    title: 'Промт для код-ревью',
    idea: 'Нужен промт для senior-ревьюера TypeScript-кода',
    mode: 'professional',
    audience: 'Тимлиды',
  });

  assert.match(created.id, /^prj_/);
  assert.equal(created.stage, 'intake');
  assert.equal(created.status, 'draft');
  assert.equal(created.mode, 'professional');

  const fetched = h.projects.get(created.id);
  assert.equal(fetched.title, 'Промт для код-ревью');

  const updated = h.projects.update(created.id, { stage: 'interview', status: 'interviewing' });
  assert.equal(updated.stage, 'interview');
  assert.equal(updated.status, 'interviewing');

  // Обновление не должно затирать поля, которые не переданы.
  assert.equal(updated.idea, created.idea);
  assert.equal(updated.audience, 'Тимлиды');

  assert.equal(h.projects.list().length, 1);
  h.projects.remove(created.id);
  assert.equal(h.projects.count(), 0);
  assert.throws(() => h.projects.get(created.id), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('projects: список считает прогресс по готовым разделам', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'quick' });
  h.sections.createMany(project.id, [
    { key: 'role', title: 'ROLE' },
    { key: 'context', title: 'CONTEXT' },
  ]);
  h.sections.update(project.id, 'role', { status: 'ready', content: 'готовый текст' });

  const [row] = h.projects.list();
  assert.equal(row.sectionsTotal, 2);
  assert.equal(row.sectionsReady, 1);
  assert.equal(row.progress, 50);
});

test('sections: создание сохраняет порядок, обновление возвращает обновлённое', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'professional' });
  const created = h.sections.createMany(project.id, [
    { key: 'role', title: 'ROLE' },
    { key: 'objective', title: 'OBJECTIVE' },
    { key: 'constraints', title: 'CONSTRAINTS' },
  ]);

  assert.deepEqual(created.map((section) => section.key), ['role', 'objective', 'constraints']);
  assert.deepEqual(created.map((section) => section.orderIndex), [0, 1, 2]);
  assert.equal(created[0].status, 'not_started');
  assert.deepEqual(created[0].requirements, []);

  const updated = h.sections.update(project.id, 'objective', {
    content: 'Цель раздела',
    status: 'ready',
    requirements: ['покрыть edge cases'],
    quality: {
      total: 82,
      criteria: [],
      mandatory: [],
      issues: [],
      verdict: 'pass',
      evaluatedAt: new Date().toISOString(),
      heuristic: false,
    },
  });

  assert.equal(updated.status, 'ready');
  assert.equal(updated.content, 'Цель раздела');
  assert.deepEqual(updated.requirements, ['покрыть edge cases']);
  assert.equal(updated.quality?.total, 82);

  // Обновление одного раздела не затрагивает соседние.
  assert.equal(h.sections.get(project.id, 'role').content, '');

  const progress = h.sections.progress(project.id);
  assert.deepEqual(progress, { total: 3, ready: 1, percent: 33 });
});

test('sections: неизвестный раздел даёт NOT_FOUND', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'quick' });
  assert.throws(() => h.sections.get(project.id, 'role'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

/* ───────────────────────── Сообщения ───────────────────────── */

test('messages: добавление, фильтрация по разделу и последний вопрос', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'quick' });

  h.messages.add({ projectId: project.id, role: 'assistant', kind: 'question', content: 'Вопрос 1', sectionKey: 'role' });
  h.messages.add({ projectId: project.id, role: 'user', kind: 'answer', content: 'Ответ 1', sectionKey: 'role' });
  h.messages.add({ projectId: project.id, role: 'assistant', kind: 'question', content: 'Вопрос 2', sectionKey: 'objective' });

  assert.equal(h.messages.count(project.id), 3);
  assert.equal(h.messages.list(project.id, 'role').length, 2);
  assert.equal(h.messages.list(project.id).length, 3);

  const last = h.messages.lastQuestion(project.id, 'role');
  assert.equal(last?.content, 'Вопрос 1');
  assert.equal(h.messages.lastQuestion(project.id, 'constraints'), null);

  // meta сохраняется как объект.
  const withMeta = h.messages.add({
    projectId: project.id,
    role: 'assistant',
    kind: 'note',
    content: 'служебное',
    meta: { source: 'heuristic' },
  });
  assert.deepEqual(withMeta.meta, { source: 'heuristic' });
});

/* ───────────────────────── Источники ───────────────────────── */

test('sources: сохранение, дедупликация URL, анализ и удаление по разделу', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'professional' });

  const stored = h.sources.addMany(project.id, 'role', [
    { title: 'A', url: 'https://a.example/1', publisher: 'a.example', snippet: 's1', relevance: 0.9 },
    { title: 'B', url: 'https://b.example/2', provider: 'Tavily' },
  ]);
  assert.equal(stored.length, 2);
  assert.equal(stored.every((source) => source.projectId === project.id), true);

  assert.deepEqual([...h.sources.dedupeUrls(project.id, 'role')].sort(), [
    'https://a.example/1',
    'https://b.example/2',
  ]);

  h.sources.setAnalysis(stored[0].id, {
    summary: 'полезно',
    strengths: ['конкретика'],
    weaknesses: [],
    applicability: 'high',
    notes: '',
  }, 0.95);

  const reread = h.sources.get(project.id, stored[0].id);
  assert.equal(reread?.analysis?.summary, 'полезно');
  assert.equal(reread?.relevance, 0.95);
  // Чужой проект не должен отдавать источник.
  assert.equal(h.sources.get('prj_unknown', stored[0].id), null);

  h.sources.addMany(project.id, 'context', [{ title: 'C', url: 'https://c.example/3' }]);
  h.sources.deleteForSection(project.id, 'role');
  assert.equal(h.sources.list(project.id, 'role').length, 0);
  assert.equal(h.sources.list(project.id).length, 1);
});

/* ───────────────────────── Провайдеры и секреты ───────────────────────── */

test('providers: ключ шифруется, наружу уходит только маска', () => {
  const h = harness();
  const provider = h.providers.create({
    name: 'OpenRouter',
    type: 'openrouter',
    protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1/',
    apiKey: 'sk-or-test-1234567890abcd',
    defaultModel: 'openai/gpt-4o-mini',
  });

  // В базе — только шифртекст.
  const row = h.db.prepare('SELECT api_key_enc FROM providers WHERE id = ?').get(provider.id) as {
    api_key_enc: string;
  };
  assert.equal(row.api_key_enc.includes('sk-or-test'), false);
  assert.match(row.api_key_enc, /^v1:/);

  // Расшифровка доступна только серверу.
  assert.equal(h.providers.apiKey(provider.id), 'sk-or-test-1234567890abcd');

  const publicView = toPublicProvider(provider);
  assert.equal(publicView.hasApiKey, true);
  assert.equal(publicView.apiKeyMasked, '••••abcd');
  assert.equal('apiKeyEnc' in publicView, false);
  assert.equal(JSON.stringify(publicView).includes('sk-or-test'), false);

  // baseUrl нормализуется без хвостового слэша.
  assert.equal(provider.baseUrl, 'https://openrouter.ai/api/v1');
});

test('providers: обновление различает «не менять», «удалить» и «заменить» ключ', () => {
  const h = harness();
  const provider = h.providers.create({
    name: 'Local',
    type: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: 'secret-one',
  });

  // undefined — ключ остаётся.
  h.providers.update(provider.id, { defaultModel: 'llama3' });
  assert.equal(h.providers.apiKey(provider.id), 'secret-one');

  // null — ключ удаляется.
  h.providers.update(provider.id, { apiKey: null });
  assert.equal(h.providers.apiKey(provider.id), '');
  assert.equal(toPublicProvider(h.providers.get(provider.id)).hasApiKey, false);

  // Новая строка — ключ заменяется.
  h.providers.update(provider.id, { apiKey: 'secret-two' });
  assert.equal(h.providers.apiKey(provider.id), 'secret-two');
});

test('providers: lastCheck сохраняется без секретов, удаление работает', () => {
  const h = harness();
  const provider = h.providers.create({
    name: 'Anthropic',
    type: 'anthropic',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'sk-ant-secret',
  });

  h.providers.setLastCheck(provider.id, { status: 'connected', checkedAt: '2026-01-01T00:00:00.000Z' });
  const reread = h.providers.get(provider.id);
  assert.equal(reread.lastCheck.status, 'connected');
  assert.equal(JSON.stringify(reread.lastCheck).includes('sk-ant-secret'), false);

  h.providers.remove(provider.id);
  assert.equal(h.providers.find(provider.id), null);
  assert.throws(() => h.providers.get(provider.id));
});

/* ───────────────────────── Маршруты ───────────────────────── */

test('routes: upsert создаёт и обновляет, частичный патч не затирает поля', () => {
  const h = harness();
  assert.equal(h.routes.get('interview'), null);

  const created = h.routes.upsert('interview', {
    providerId: null,
    model: 'gpt-4o-mini',
    params: { temperature: 0.2 },
  });
  assert.equal(created.operation, 'interview');
  assert.equal(created.model, 'gpt-4o-mini');
  assert.deepEqual(created.params, { temperature: 0.2 });
  assert.equal(created.useFallback, false);

  const patched = h.routes.upsert('interview', { useFallback: true, fallbackModel: 'claude-3-5-haiku' });
  assert.equal(patched.model, 'gpt-4o-mini');
  assert.equal(patched.useFallback, true);
  assert.equal(patched.fallbackModel, 'claude-3-5-haiku');
  assert.deepEqual(patched.params, { temperature: 0.2 });

  assert.equal(h.routes.list().length, 1);
  h.routes.remove('interview');
  assert.equal(h.routes.get('interview'), null);
});

test('routes: все операции из OPERATIONS поддерживаются репозиторием', () => {
  const h = harness();
  for (const operation of OPERATIONS) {
    h.routes.upsert(operation, { providerId: null, model: `model-${operation}` });
  }
  assert.equal(h.routes.list().length, OPERATIONS.length);
  for (const operation of OPERATIONS) {
    assert.equal(h.routes.get(operation)?.model, `model-${operation}`);
  }
});

test('routes: удаление провайдера обнуляет ссылку, а не ломает маршрут', () => {
  const h = harness();
  const provider = h.providers.create({
    name: 'P',
    type: 'custom',
    protocol: 'openai-chat',
    baseUrl: 'https://example.test/v1',
  });
  h.routes.upsert('section_synthesis', { providerId: provider.id, model: 'm' });

  h.providers.remove(provider.id);
  const route = h.routes.get('section_synthesis');
  assert.equal(route?.providerId, null);
  assert.equal(route?.model, 'm');
});

/* ───────────────────────── Поисковые провайдеры ───────────────────────── */

test('search providers: ключ скрыт, маска корректна, обновление работает', () => {
  const h = harness();
  const provider = h.searchProviders.create({
    name: 'Tavily',
    type: 'tavily',
    apiKey: 'tvly-test-key-9876',
    options: { searchDepth: 'advanced' },
  });

  assert.equal(h.searchProviders.apiKey(provider.id), 'tvly-test-key-9876');
  const publicView = toPublicSearch(provider);
  assert.equal(publicView.hasApiKey, true);
  assert.equal(publicView.apiKeyMasked, '••••9876');
  assert.equal(JSON.stringify(publicView).includes('tvly-test-key'), false);

  h.searchProviders.update(provider.id, { enabled: false, apiKey: null });
  const updated = h.searchProviders.get(provider.id);
  assert.equal(updated.enabled, false);
  assert.equal(updated.apiKeyEnc, '');
  assert.deepEqual(updated.options, { searchDepth: 'advanced' });

  h.searchProviders.remove(provider.id);
  assert.equal(h.searchProviders.list().length, 0);
});

/* ───────────────────────── Настройки и использование ───────────────────────── */

test('settings: значения по умолчанию, частичное сохранение, чтение', () => {
  const h = harness();
  assert.deepEqual(h.settings.defaults(), DEFAULT_SETTINGS);
  assert.equal(h.settings.get<string>('default_provider_id', ''), '');

  const saved = h.settings.saveDefaults({ mode: 'expert', maxSourcesPerSection: 6 });
  assert.equal(saved.mode, 'expert');
  assert.equal(saved.maxSourcesPerSection, 6);
  // Остальные поля сохраняются по умолчанию.
  assert.equal(saved.language, DEFAULT_SETTINGS.language);
  assert.equal(saved.qualityThreshold, DEFAULT_SETTINGS.qualityThreshold);

  const reread = h.settings.defaults();
  assert.equal(reread.mode, 'expert');
  assert.equal(reread.maxSourcesPerSection, 6);

  h.settings.set('default_provider_id', 'prv_123');
  assert.equal(h.settings.get<string>('default_provider_id', ''), 'prv_123');
  assert.equal(h.settings.getAll().default_provider_id, 'prv_123');
});

test('usage: события и агрегаты по провайдеру и операции', () => {
  const h = harness();
  h.usage.record({
    operation: 'interview',
    providerName: 'OpenAI',
    model: 'gpt-4o-mini',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 900,
  });
  h.usage.record({
    operation: 'interview',
    providerName: 'OpenAI',
    model: 'gpt-4o-mini',
    inputTokens: 200,
    outputTokens: 80,
    durationMs: 1100,
    status: 'ok',
  });
  h.usage.record({
    operation: 'section_synthesis',
    providerName: 'Anthropic',
    model: 'claude-3-5-sonnet',
    status: 'error',
    errorCode: 'RATE_LIMITED',
    retries: 2,
  });

  const summary = h.usage.summary();
  assert.equal(summary.requests, 3);
  assert.equal(summary.errors, 1);
  assert.equal(summary.inputTokens, 300);
  assert.equal(summary.outputTokens, 130);
  assert.equal(summary.byProvider.length, 2);

  const openai = summary.byProvider.find((row) => row.providerName === 'OpenAI');
  assert.equal(openai?.requests, 2);
  assert.equal(openai?.errors, 0);

  const byOperation = summary.byOperation.find((row) => row.operation === 'interview');
  assert.equal(byOperation?.requests, 2);

  const events = h.usage.list(10);
  assert.equal(events.length, 3);
  // Событие ошибки сохраняет код и число повторов.
  const failed = events.find((event) => event.status === 'error');
  assert.equal(failed?.errorCode, 'RATE_LIMITED');
  assert.equal(failed?.retries, 2);
});

/* ───────────────────────── Версии и тесты ───────────────────────── */

test('versions: создание, порядок по времени, последняя версия', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'quick' });

  assert.equal(h.versions.latest(project.id), null);

  const first = h.versions.create({ projectId: project.id, label: 'v1', prompt: 'первый промт', meta: { source: 'llm' } });
  const second = h.versions.create({ projectId: project.id, label: 'v2', prompt: 'второй промт' });

  assert.match(first.id, /^ver_/);
  const list = h.versions.list(project.id);
  assert.equal(list.length, 2);
  assert.equal(h.versions.latest(project.id)?.id, second.id);
  assert.deepEqual(h.versions.get(first.id).meta, { source: 'llm' });

  assert.throws(() => h.versions.get('ver_missing'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'NOT_FOUND');
    return true;
  });
});

test('tests: прогоны сохраняют результаты и последний вердикт', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'quick' });

  const run = h.tests.create({
    projectId: project.id,
    versionId: 'ver_1',
    prompt: 'текст промта',
    providerName: 'OpenAI',
    model: 'gpt-4o-mini',
    status: 'done',
    cases: [{ id: 't1', title: 'Тест', userMessage: 'запрос', checks: ['формат'], category: 'typical' }],
    results: [
      {
        id: 't1',
        title: 'Тест',
        category: 'typical',
        userMessage: 'запрос',
        response: 'ответ модели',
        score: 88,
        passed: true,
        violations: [],
        notes: '',
      },
    ],
    verdict: 'pass',
  });

  assert.match(run.id, /^tst_/);
  const latest = h.tests.latest(project.id);
  assert.equal(latest?.verdict, 'pass');
  assert.equal(latest?.results[0].score, 88);
  assert.equal(latest?.cases[0].checks.length, 1);
  assert.equal(h.tests.list(project.id).length, 1);
});

/* ───────────────────────── Каскадное удаление ───────────────────────── */

test('cascade: удаление проекта убирает разделы, сообщения, источники, версии и тесты', () => {
  const h = harness();
  const project = h.projects.create({ title: 'P', idea: 'Идея достаточной длины для валидации', mode: 'professional' });

  h.sections.createMany(project.id, [{ key: 'role', title: 'ROLE' }]);
  h.messages.add({ projectId: project.id, role: 'user', content: 'привет' });
  h.sources.addMany(project.id, 'role', [{ title: 'A', url: 'https://a.example/1' }]);
  h.versions.create({ projectId: project.id, label: 'v1', prompt: 'промт' });
  h.tests.create({
    projectId: project.id,
    versionId: 'ver_1',
    prompt: 'промт',
    providerName: '',
    model: '',
    status: 'not_run',
    cases: [],
    results: [],
    verdict: 'not_run',
  });

  // Второй проект должен остаться нетронутым.
  const other = h.projects.create({ title: 'Q', idea: 'Другая идея достаточной длины', mode: 'quick' });
  h.sections.createMany(other.id, [{ key: 'role', title: 'ROLE' }]);

  h.projects.remove(project.id);

  const counts = h.db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sections WHERE project_id = ?) AS sections,
         (SELECT COUNT(*) FROM messages WHERE project_id = ?) AS messages,
         (SELECT COUNT(*) FROM sources WHERE project_id = ?) AS sources,
         (SELECT COUNT(*) FROM versions WHERE project_id = ?) AS versions,
         (SELECT COUNT(*) FROM test_runs WHERE project_id = ?) AS tests`,
    )
    .get(project.id, project.id, project.id, project.id, project.id) as Record<string, number>;

  assert.equal(Number(counts.sections), 0);
  assert.equal(Number(counts.messages), 0);
  assert.equal(Number(counts.sources), 0);
  assert.equal(Number(counts.versions), 0);
  assert.equal(Number(counts.tests), 0);

  assert.equal(h.sections.list(other.id).length, 1);
});
