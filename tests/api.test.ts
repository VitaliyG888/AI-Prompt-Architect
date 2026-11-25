/**
 * Тесты HTTP-слоя: реальный сервер на 127.0.0.1, настоящие fetch-запросы.
 *
 * Проверяется то, что видит клиент: коды состояния, формы ответов, маскирование
 * секретов (ключ не должен попасть ни в один ответ), валидация и поток NDJSON.
 * База — ':memory:', поэтому тесты не трогают data/.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startServer, type RunningServer } from '../src/server/index.ts';
import { config } from '../src/server/env.ts';
import { getArchetype } from '../src/server/domain/archetypes.ts';

let server: RunningServer;

before(async () => {
  server = await startServer({ port: 0, databasePath: ':memory:', allowPrivateProviders: true });
});

after(async () => {
  await server.close();
});

/* ─────────────────────────── Помощники ─────────────────────────── */

interface CallOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  rawBody?: string;
  contentType?: string;
}

interface CallResult {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown>;
}

async function call(path: string, options: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = {};
  let body: string | undefined;

  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers['content-type'] = options.contentType ?? 'application/json';
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers['content-type'] = options.contentType ?? 'application/json';
  }

  if (options.token) headers['x-app-token'] = options.token;
  if (options.token === null && config.appToken) headers['x-app-token'] = 'wrong-token';

  const response = await fetch(`${server.url}${path}`, {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    ...(body === undefined ? {} : { body }),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }

  return { status: response.status, headers: response.headers, text, json: parsed };
}

function errorCode(result: CallResult): string {
  const error = result.json.error as { code?: string } | undefined;
  return error?.code ?? '';
}

async function createProject(idea = 'Промт для код-ревью TypeScript-сервиса', extra: Record<string, unknown> = {}) {
  const result = await call('/api/projects', { body: { idea, ...extra } });
  assert.equal(result.status, 201, result.text);
  return result.json.project as Record<string, unknown>;
}

/* ─────────────────────────── Диагностика ─────────────────────────── */

test('health: отдаёт состояние сервера и количество маршрутов', async () => {
  const result = await call('/api/health');
  assert.equal(result.status, 200);
  assert.equal(result.json.ok, true);
  assert.equal(result.json.version, config.version);

  const providers = result.json.providers as { total: number; enabled: number };
  assert.equal(providers.total, 0);
  assert.equal(providers.enabled, 0);

  // Одиннадцать операций получают маршрут при первом запуске.
  assert.equal(result.json.routes, 11);
  assert.equal(result.json.projects, 0);

  const search = result.json.search as { configured: boolean; providers: unknown[] };
  assert.equal(search.configured, false);
  assert.deepEqual(search.providers, []);

  // Заголовки безопасности выставляются на каждый ответ.
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('meta: перечисляет режимы, разделы и статусы', async () => {
  const result = await call('/api/meta');
  assert.equal(result.status, 200);

  const modes = result.json.modes as Array<{ id: string }>;
  assert.deepEqual(modes.map((mode) => mode.id), ['quick', 'professional', 'expert']);

  const sections = result.json.sections as Array<{ key: string; title: string }>;
  assert.equal(sections.length, 12);
  assert.ok(sections.some((section) => section.key === 'role' && section.title.startsWith('ROLE')));

  const labels = result.json.sectionStatusLabels as Record<string, string>;
  assert.equal(labels.ready, 'готов');

  const defaults = result.json.defaults as Record<string, unknown>;
  assert.equal(defaults.mode, 'professional');
});

test('catalog: протоколы, операции и типы поиска доступны клиенту', async () => {
  const result = await call('/api/config/catalog');
  assert.equal(result.status, 200);

  const protocols = result.json.protocols as Array<{ protocol: string }>;
  const ids = protocols.map((item) => item.protocol);
  for (const expected of ['openai-chat', 'openai-responses', 'anthropic-messages', 'gemini']) {
    assert.ok(ids.includes(expected), `нет протокола ${expected}`);
  }
  assert.deepEqual(result.json.supportedProtocols, ids);

  const operations = result.json.operations as Array<{ key: string; label: string }>;
  assert.equal(operations.length, 11);
  assert.ok(operations.some((operation) => operation.key === 'section_synthesis'));

  const searchTypes = result.json.searchTypes as Array<{ type: string }>;
  assert.ok(searchTypes.length >= 6);
});

/* ─────────────────────────── Проекты ─────────────────────────── */

test('projects: валидация входа и полный CRUD', async () => {
  // Слишком короткая идея — 422 с машинным кодом.
  const tooShort = await call('/api/projects', { body: { idea: 'мало' } });
  assert.equal(tooShort.status, 422);
  assert.equal(errorCode(tooShort), 'VALIDATION_FAILED');

  // Отсутствие Content-Type: application/json.
  const wrongType = await call('/api/projects', {
    rawBody: '{"idea":"Промт для код-ревью сервиса"}',
    contentType: 'text/plain',
  });
  assert.equal(wrongType.status, 400);
  assert.equal(errorCode(wrongType), 'BAD_REQUEST');

  const project = await createProject('Промт для код-ревью TypeScript-сервиса', {
    mode: 'expert',
    audience: 'backend-команда',
    targetModel: 'gpt-4.1',
  });
  assert.equal(project.mode, 'expert');
  assert.equal(project.status, 'draft');
  assert.equal(project.stage, 'intake');
  assert.equal(project.audience, 'backend-команда');
  // Заголовок выводится из идеи, если не передан.
  assert.match(String(project.title), /Промт для код-ревью/);

  const list = await call('/api/projects');
  assert.equal(list.status, 200);
  assert.equal((list.json.projects as unknown[]).length, 1);

  const fetched = await call(`/api/projects/${project.id}`);
  assert.equal(fetched.status, 200);
  const snapshot = fetched.json as Record<string, unknown>;
  assert.ok(snapshot.project && typeof snapshot.project === 'object');
  assert.deepEqual(snapshot.sections, []);
  assert.deepEqual(snapshot.messages, []);
  assert.deepEqual(snapshot.sources, []);
  assert.deepEqual(snapshot.versions, []);
  const progress = snapshot.progress as { total: number; ready: number };
  assert.equal(progress.ready, 0);
  const policy = snapshot.policy as { id: string };
  assert.equal(policy.id, 'expert');
  // Ключи провайдеров не попадают даже в служебные поля снимка.
  assert.doesNotMatch(fetched.text, /apiKeyEnc|api_key_enc/);

  const patched = await call(`/api/projects/${project.id}`, {
    method: 'PATCH',
    body: { title: 'Код-ревью API', mode: 'quick' },
  });
  assert.equal(patched.status, 200);
  const updated = patched.json.project as Record<string, unknown>;
  assert.equal(updated.title, 'Код-ревью API');
  assert.equal(updated.mode, 'quick');
  // Незатронутые поля сохраняются.
  assert.equal(updated.audience, 'backend-команда');

  const badMode = await call(`/api/projects/${project.id}`, { method: 'PATCH', body: { mode: 'turbo' } });
  assert.equal(badMode.status, 422);

  const removed = await call(`/api/projects/${project.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(removed.text, '');

  const gone = await call(`/api/projects/${project.id}`);
  assert.equal(gone.status, 404);
  assert.equal(errorCode(gone), 'NOT_FOUND');
});

test('projects: неизвестный раздел и проект дают 404, чужой метод — 405', async () => {
  const project = await createProject('Промт для анализа логов продакшена');

  const unknownSection = await call(`/api/projects/${project.id}/sections/unknown_key`, {
    method: 'PATCH',
    body: { content: 'текст' },
  });
  assert.equal(unknownSection.status, 404);
  assert.equal(errorCode(unknownSection), 'NOT_FOUND');

  const missingProject = await call('/api/projects/prj_missing');
  assert.equal(missingProject.status, 404);

  const methodNotAllowed = await call('/api/projects', { method: 'DELETE' });
  assert.equal(methodNotAllowed.status, 405);
  assert.equal(errorCode(methodNotAllowed), 'BAD_REQUEST');

  const unknownRoute = await call('/api/definitely-not-a-route');
  assert.equal(unknownRoute.status, 404);

  await call(`/api/projects/${project.id}`, { method: 'DELETE' });
});

test('projects: инициализация создаёт критические разделы архетипа', async () => {
  const project = await createProject('Промт для код-ревью TypeScript-сервиса');

  const init = await call(`/api/projects/${project.id}/initialize`, { method: 'POST' });
  assert.equal(init.status, 200, init.text);

  const sections = init.json.sections as Array<{ key: string; status: string }>;
  const critical = getArchetype('ai_programmer').criticalSections;
  assert.equal(sections.length, critical.length);
  assert.deepEqual(
    sections.map((section) => section.key).sort(),
    [...critical].sort(),
  );
  // Без настроенного провайдера план строится эвристикой — честно и явно.
  const plan = init.json.plan as { source: string };
  assert.equal(plan.source, 'heuristic');

  const snapshot = await call(`/api/projects/${project.id}`);
  const body = snapshot.json as Record<string, unknown>;
  const progress = body.progress as { total: number };
  assert.equal(progress.total, critical.length);
  const messages = body.messages as Array<{ kind: string }>;
  assert.ok(messages.some((message) => message.kind === 'event'));

  await call(`/api/projects/${project.id}`, { method: 'DELETE' });
});

/* ─────────────────────────── Провайдеры ─────────────────────────── */

test('providers: ключ шифруется, в ответах только маска', async () => {
  const secret = 'sk-live-abcdefgh-1234';
  const created = await call('/api/providers', {
    body: {
      name: 'OpenRouter',
      type: 'openrouter',
      protocol: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      defaultModel: 'anthropic/claude-sonnet-4',
      apiKey: secret,
    },
  });
  assert.equal(created.status, 201, created.text);

  const provider = created.json.provider as Record<string, unknown>;
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.apiKeyMasked, '••••1234');
  assert.equal(provider.apiKey, undefined);
  // Главное требование: открытый ключ не утекает ни в одном поле ответа.
  assert.ok(!created.text.includes(secret), 'открытый ключ попал в ответ API');
  assert.ok(!created.text.includes('apiKeyEnc'));

  const list = await call('/api/providers');
  assert.ok(!list.text.includes(secret));
  const listed = (list.json.providers as Array<Record<string, unknown>>)[0];
  assert.equal(listed.apiKeyMasked, '••••1234');

  // PATCH без apiKey сохраняет существующий ключ.
  const renamed = await call(`/api/providers/${provider.id}`, { method: 'PATCH', body: { name: 'OpenRouter main' } });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.json.provider as Record<string, unknown>).hasApiKey, true);
  assert.ok(!renamed.text.includes(secret));

  // Явная очистка ключа.
  const cleared = await call(`/api/providers/${provider.id}`, { method: 'PATCH', body: { clearApiKey: true } });
  assert.equal(cleared.status, 200);
  assert.equal((cleared.json.provider as Record<string, unknown>).hasApiKey, false);
  assert.equal((cleared.json.provider as Record<string, unknown>).apiKeyMasked, '');

  // Небезопасные значения custom headers отбрасываются, безопасные остаются.
  const withHeaders = await call(`/api/providers/${provider.id}`, {
    method: 'PATCH',
    body: { customHeaders: { 'HTTP-Referer': 'https://example.com', Host: 'evil.example' } },
  });
  const headers = (withHeaders.json.provider as Record<string, unknown>).customHeaders as Record<string, string>;
  assert.equal(headers['HTTP-Referer'], 'https://example.com');
  assert.equal(headers.Host, undefined);

  const assignedDefault = await call(`/api/providers/${provider.id}/default`, { method: 'POST' });
  assert.equal(assignedDefault.status, 200);
  assert.equal(assignedDefault.json.defaultProviderId, provider.id);

  const removed = await call(`/api/providers/${provider.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);

  const defaultsAfter = await call('/api/providers');
  assert.equal(defaultsAfter.json.defaultProviderId, '');
});

test('providers: валидация протокола и Base URL', async () => {
  const badProtocol = await call('/api/providers', {
    body: { name: 'X', type: 'custom', protocol: 'grpc', baseUrl: 'https://example.com/v1' },
  });
  assert.equal(badProtocol.status, 422);

  const badUrl = await call('/api/providers', {
    body: { name: 'X', type: 'custom', protocol: 'openai-chat', baseUrl: 'not-a-url' },
  });
  assert.equal(badUrl.status, 422);
  assert.match(String((badUrl.json.error as { message?: string }).message), /baseUrl/);

  const badScheme = await call('/api/providers', {
    body: { name: 'X', type: 'custom', protocol: 'openai-chat', baseUrl: 'ftp://example.com' },
  });
  assert.equal(badScheme.status, 422);

  // Трейлинг слэши нормализуются.
  const trimmed = await call('/api/providers', {
    body: { name: 'Local', type: 'custom', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:8080/v1///' },
  });
  assert.equal(trimmed.status, 201);
  assert.equal((trimmed.json.provider as Record<string, unknown>).baseUrl, 'http://127.0.0.1:8080/v1');

  await call(`/api/providers/${(trimmed.json.provider as Record<string, unknown>).id}`, { method: 'DELETE' });

  const missing = await call('/api/providers/prv_missing', { method: 'PATCH', body: { name: 'X' } });
  assert.equal(missing.status, 404);
});

/* ─────────────────────────── Маршруты операций ─────────────────────────── */

test('routes: назначение провайдера, параметры генерации и валидация', async () => {
  const provider = await call('/api/providers', {
    body: {
      name: 'Primary',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-test-9876',
    },
  });
  const providerId = (provider.json.provider as Record<string, unknown>).id as string;

  const list = await call('/api/routes');
  assert.equal(list.status, 200);
  const routes = list.json.routes as Array<{ operation: string }>;
  assert.equal(routes.length, 11);
  // Порядок стабилен: операции отсортированы.
  assert.deepEqual(routes.map((route) => route.operation), [...routes.map((r) => r.operation)].sort());

  const updated = await call('/api/routes/section_synthesis', {
    method: 'PUT',
    body: {
      providerId,
      model: 'gpt-4.1-mini',
      params: { temperature: 0.4, maxOutputTokens: 4000, reasoningEffort: 'medium' },
      useFallback: true,
      fallbackProviderId: providerId,
      fallbackModel: 'gpt-4.1-mini',
    },
  });
  assert.equal(updated.status, 200, updated.text);
  const route = updated.json.route as Record<string, unknown>;
  assert.equal(route.providerId, providerId);
  assert.equal(route.useFallback, true);
  const params = route.params as Record<string, number>;
  assert.equal(params.temperature, 0.4);
  assert.equal(params.maxOutputTokens, 4000);

  // Параметры вне диапазона отклоняются.
  const badTemp = await call('/api/routes/section_synthesis', {
    method: 'PUT',
    body: { providerId, params: { temperature: 5 } },
  });
  assert.equal(badTemp.status, 422);

  const badOperation = await call('/api/routes/nope', { method: 'PUT', body: {} });
  assert.equal(badOperation.status, 404);

  // Ссылка на несуществующего провайдера не проходит.
  const badProvider = await call('/api/routes/interview', {
    method: 'PUT',
    body: { providerId: 'prv_missing' },
  });
  assert.equal(badProvider.status, 404);

  // Отвязать провайдера можно через null.
  const detached = await call('/api/routes/section_synthesis', { method: 'PUT', body: { providerId: null } });
  assert.equal(detached.status, 200);
  assert.equal((detached.json.route as Record<string, unknown>).providerId, null);

  await call(`/api/providers/${providerId}`, { method: 'DELETE' });
});

/* ─────────────────────────── Поиск ─────────────────────────── */

test('search-providers: ключ маскируется, статус честно показывает готовность', async () => {
  const secret = 'tvly-secret-0000';
  const created = await call('/api/search-providers', {
    body: { name: 'Tavily', type: 'tavily', apiKey: secret, baseUrl: 'https://api.tavily.com' },
  });
  assert.equal(created.status, 201, created.text);
  const provider = created.json.provider as Record<string, unknown>;
  assert.equal(provider.hasApiKey, true);
  assert.equal(provider.apiKeyMasked, '••••0000');
  assert.ok(!created.text.includes(secret));

  const list = await call('/api/search-providers');
  assert.equal(list.json.configured, true);
  const status = list.json.status as Array<{ available: boolean }>;
  assert.equal(status.length, 1);
  assert.equal(status[0].available, true);

  const badType = await call('/api/search-providers', { body: { name: 'X', type: 'bing' } });
  assert.equal(badType.status, 422);

  const removed = await call(`/api/search-providers/${provider.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);

  const after = await call('/api/search-providers');
  assert.equal(after.json.configured, false);
});

/* ─────────────────────────── Настройки ─────────────────────────── */

test('settings: значения по умолчанию сохраняются и валидируются', async () => {
  const initial = await call('/api/settings');
  assert.equal(initial.status, 200);
  const defaults = initial.json.defaults as Record<string, unknown>;
  assert.equal(defaults.mode, 'professional');
  assert.equal(defaults.language, 'ru');

  const saved = await call('/api/settings/defaults', {
    method: 'PUT',
    body: { mode: 'expert', maxSourcesPerSection: 6, qualityThreshold: 85, autoTest: true },
  });
  assert.equal(saved.status, 200, saved.text);
  const next = saved.json.defaults as Record<string, unknown>;
  assert.equal(next.mode, 'expert');
  assert.equal(next.maxSourcesPerSection, 6);
  assert.equal(next.qualityThreshold, 85);
  assert.equal(next.autoTest, true);
  // Непереданные поля остаются прежними.
  assert.equal(next.language, 'ru');

  const badMode = await call('/api/settings/defaults', { method: 'PUT', body: { mode: 'ultra' } });
  assert.equal(badMode.status, 422);

  const badSources = await call('/api/settings/defaults', { method: 'PUT', body: { maxSourcesPerSection: 99 } });
  assert.equal(badSources.status, 422);

  await call('/api/settings/defaults', { method: 'PUT', body: { mode: 'professional', maxSourcesPerSection: 4 } });
});

/* ─────────────────────────── Экспорт ─────────────────────────── */

test('export: без версии — 409, после сборки — md/txt/json', async () => {
  const project = await createProject('Промт для технической документации API');
  const id = String(project.id);

  const beforeVersion = await call(`/api/projects/${id}/export?format=md`);
  assert.equal(beforeVersion.status, 409);
  assert.equal(errorCode(beforeVersion), 'CONFLICT');

  // Версия создаётся движком сборки; здесь проверяется именно слой экспорта.
  server.app.versions.create({
    projectId: id,
    label: 'v1',
    prompt: '# Итоговый промт\n\nТы технический писатель.',
    quality: null,
    meta: { purpose: 'документация API', usage: ['Вставьте промт в системное сообщение'] },
  });

  const md = await call(`/api/projects/${id}/export?format=md`);
  assert.equal(md.status, 200);
  assert.match(String(md.headers.get('content-type')), /text\/markdown/);
  assert.match(String(md.headers.get('content-disposition')), /attachment; filename=".*\.md"/);
  assert.match(md.text, /# Промт для технической документации API/);
  assert.match(md.text, /Ты технический писатель\./);

  const txt = await call(`/api/projects/${id}/export?format=txt`);
  assert.equal(txt.status, 200);
  assert.match(String(txt.headers.get('content-type')), /text\/plain/);
  assert.match(String(txt.headers.get('content-disposition')), /\.txt"/);
  assert.match(txt.text, /Ты технический писатель\./);

  const json = await call(`/api/projects/${id}/export?format=json`);
  assert.equal(json.status, 200);
  assert.match(String(json.headers.get('content-type')), /application\/json/);
  const bundle = json.json as Record<string, unknown>;
  assert.equal(bundle.prompt, '# Итоговый промт\n\nТы технический писатель.');
  assert.ok(bundle.project);
  assert.equal((bundle.versions as unknown[]).length, 1);
  // Экспорт не содержит служебных полей провайдеров.
  assert.doesNotMatch(json.text, /apiKeyEnc|api_key_enc/);

  const badFormat = await call(`/api/projects/${id}/export?format=pdf`);
  assert.equal(badFormat.status, 422);

  const latest = await call(`/api/projects/${id}/versions`);
  assert.equal((latest.json.versions as unknown[]).length, 1);
  const versionId = String((latest.json.versions as Array<Record<string, unknown>>)[0].id);

  const one = await call(`/api/projects/${id}/versions/${versionId}`);
  assert.equal(one.status, 200);
  assert.equal((one.json.version as Record<string, unknown>).label, 'v1');

  // Версия другого проекта недоступна по чужому id.
  const other = await createProject('Другой промт для проверки изоляции версий');
  const foreign = await call(`/api/projects/${other.id}/versions/${versionId}`);
  assert.equal(foreign.status, 404);

  const diff = await call(`/api/projects/${id}/diff`);
  assert.equal(diff.status, 404);
  assert.equal(errorCode(diff), 'NOT_FOUND');

  await call(`/api/projects/${id}`, { method: 'DELETE' });
  await call(`/api/projects/${other.id}`, { method: 'DELETE' });
});

/* ─────────────────────────── Поток конвейера ─────────────────────────── */

test('pipeline: NDJSON-поток отдаёт start → step → section → done', async () => {
  const project = await createProject('Промт для ревью инфраструктурного кода', { mode: 'professional' });
  const id = String(project.id);

  await call(`/api/projects/${id}/initialize`, { method: 'POST' });

  const response = await fetch(`${server.url}/api/projects/${id}/sections/role/pipeline`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.match(String(response.headers.get('content-type')), /application\/x-ndjson/);

  const raw = await response.text();
  const events = raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  assert.ok(events.length >= 4, `ожидались события конвейера, получено: ${raw}`);
  assert.equal(events[0].type, 'start');
  assert.equal(events[0].section, 'role');
  assert.equal(events[events.length - 1].type, 'done');

  // Синтез без настроенного провайдера не падает: раздел собирается
  // детерминированно из требований и честно помечается как незавершённый.
  const section = events.find((event) => event.type === 'section');
  assert.ok(section, 'нет события section');
  assert.equal((section.section as Record<string, unknown>).status, 'needs_revision');
  // Исследование без поискового провайдера не выдумывает источники.
  const research = events.find((event) => event.type === 'research');
  assert.ok(research, 'нет события research');
  assert.equal(research.status, 'unavailable');
  assert.equal(research.sources, 0);

  const snapshot = await call(`/api/projects/${id}`);
  const body = snapshot.json as Record<string, unknown>;
  assert.ok((body.sections as unknown[]).length > 0);

  await call(`/api/projects/${id}`, { method: 'DELETE' });
});

/* ─────────────────────────── Авторизация ─────────────────────────── */

test('auth: при пустом APP_TOKEN локальный доступ открыт', async () => {
  const result = await call('/api/health', { token: null });
  if (config.appToken) {
    assert.equal(result.status, 401);
    assert.equal(errorCode(result), 'UNAUTHORIZED');
  } else {
    // Токен не задан — локальная работа без заголовка разрешена.
    assert.equal(result.status, 200);
  }
});

test('usage: сводка и события доступны и пусты на чистой базе', async () => {
  const result = await call('/api/usage');
  assert.equal(result.status, 200);
  const summary = result.json.summary as Record<string, unknown>;
  assert.ok(summary);
  assert.deepEqual(result.json.events, []);
});
