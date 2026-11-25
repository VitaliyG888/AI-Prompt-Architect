/**
 * Тесты адаптеров протоколов и поисковых провайдеров.
 *
 * Каждый адаптер проверяется против реального локального HTTP-сервера:
 * проверяется и тело запроса (то, что уходит провайдеру), и разбор ответа,
 * и классификация ошибок. Никаких моков fetch — только сетевой уровень.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';

import { openDatabase } from '../src/server/db/schema.ts';
import { ProviderRepository } from '../src/server/db/repo/providers.ts';
import { RouteRepository } from '../src/server/db/repo/routes.ts';
import { UsageRepository } from '../src/server/db/repo/usage.ts';
import { SettingsRepository } from '../src/server/db/repo/settings.ts';
import { LLMClient } from '../src/server/llm/client.ts';
import { getAdapter } from '../src/server/llm/registry.ts';
import { AppError, toAppError } from '../src/server/core/errors.ts';
import { tavilyAdapter } from '../src/server/search/adapters/tavily.ts';
import { braveAdapter } from '../src/server/search/adapters/brave.ts';
import { googleCseAdapter, searxngAdapter, serpApiAdapter, customSearchAdapter } from '../src/server/search/adapters/misc.ts';
import type { ProviderConnection } from '../src/server/llm/types.ts';

/* ─────────────────────────── Мок-сервер ─────────────────────────── */

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
}

interface MockServer {
  baseUrl: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

type Handler = (request: RecordedRequest, response: ServerResponse) => void;

async function mockServer(handler: Handler): Promise<MockServer> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = null;
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = null;
        }
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : String(value ?? ''),
          ]),
        ),
        body,
        raw,
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(text);
}

function connection(baseUrl: string, apiKey = 'test-key-1234'): ProviderConnection {
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    protocol: 'openai-chat',
    customHeaders: {},
    organizationId: '',
    timeoutMs: 5000,
    extra: {},
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await promise;
    assert.fail(`ожидалась ошибка ${code}`);
  } catch (error) {
    const appError = toAppError(error);
    assert.equal(appError.code, code, `получено: ${appError.code} (${appError.message})`);
    return appError;
  }
}

/* ─────────────────────────── OpenAI Chat ─────────────────────────── */

test('openai-chat: тело запроса содержит модель, system и json-формат', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      model: 'gpt-4o-mini-2024-07-18',
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 25, completion_tokens: 7 },
    }),
  );

  try {
    const adapter = getAdapter('openai-chat');
    const result = await adapter.complete(connection(mock.baseUrl), {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Ты архитектор' },
        { role: 'user', content: 'Спроектируй раздел' },
      ],
      params: { temperature: 0.3, topP: 0.9, maxOutputTokens: 512 },
      json: true,
    });

    const request = mock.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.path, '/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer test-key-1234');

    const body = request.body as Record<string, unknown>;
    assert.equal(body.model, 'gpt-4o-mini');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.max_tokens, 512);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.messages, [
      { role: 'system', content: 'Ты архитектор' },
      { role: 'user', content: 'Спроектируй раздел' },
    ]);

    assert.equal(result.text, '{"ok":true}');
    assert.equal(result.usage.inputTokens, 25);
    assert.equal(result.usage.outputTokens, 7);
    assert.equal(result.usage.estimated, false);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.model, 'gpt-4o-mini-2024-07-18');
  } finally {
    await mock.close();
  }
});

test('openai-chat: без usage токены оцениваются и помечаются estimated', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { choices: [{ message: { content: 'ответ модели' } }] }),
  );

  try {
    const adapter = getAdapter('openai-chat');
    const result = await adapter.complete(connection(mock.baseUrl), {
      model: 'm',
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.equal(result.usage.estimated, true);
    assert.ok(result.usage.inputTokens > 0);
    assert.ok(result.usage.outputTokens > 0);
  } finally {
    await mock.close();
  }
});

test('openai-chat: пустой ответ — UPSTREAM_ERROR, а не пустая строка', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { choices: [{ message: { content: '' } }] }),
  );

  try {
    const adapter = getAdapter('openai-chat');
    await expectCode(
      adapter.complete(connection(mock.baseUrl), { model: 'm', messages: [{ role: 'user', content: 'x' }] }),
      'UPSTREAM_ERROR',
    );
  } finally {
    await mock.close();
  }
});

test('openai-chat: классификация HTTP-ошибок провайдера', async () => {
  const cases: Array<[number, string]> = [
    [401, 'PROVIDER_AUTH_FAILED'],
    [403, 'PROVIDER_AUTH_FAILED'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'PROVIDER_UNAVAILABLE'],
    [400, 'UPSTREAM_ERROR'],
  ];

  const adapter = getAdapter('openai-chat');

  // Отдельный сервер на каждый статус: адаптер дописывает /chat/completions,
  // поэтому статус нельзя кодировать в пути base URL.
  for (const [status, code] of cases) {
    const mock = await mockServer((_request, response) =>
      sendJson(response, status, { error: { message: 'провайдер отказал' } }),
    );
    try {
      await expectCode(
        adapter.complete(connection(mock.baseUrl), {
          model: 'm',
          messages: [{ role: 'user', content: 'x' }],
        }),
        code,
      );
    } finally {
      await mock.close();
    }
  }
});

test('openai-chat: ошибка содержит сообщение провайдера, но не ключ', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 401, { error: { message: 'Invalid API key provided' } }),
  );

  try {
    const adapter = getAdapter('openai-chat');
    const error = await expectCode(
      adapter.complete(connection(mock.baseUrl, 'sk-super-secret-key'), {
        model: 'm',
        messages: [{ role: 'user', content: 'x' }],
      }),
      'PROVIDER_AUTH_FAILED',
    );
    assert.match(error.message, /Invalid API key provided/);
    assert.equal(error.message.includes('sk-super-secret-key'), false);
  } finally {
    await mock.close();
  }
});

test('openai-chat: listModels отдаёт идентификаторы и контекст', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      data: [
        { id: 'gpt-4o', context_length: 128000 },
        { id: 'o3-mini' },
        { noId: true },
      ],
    }),
  );

  try {
    const adapter = getAdapter('openai-chat');
    const models = await adapter.listModels!(connection(mock.baseUrl));
    assert.deepEqual(models.map((model) => model.id), ['gpt-4o', 'o3-mini']);
    assert.equal(models[0].contextLength, 128000);
    assert.equal(mock.requests[0].path, '/models');
  } finally {
    await mock.close();
  }
});

/* ─────────────────────────── Anthropic ─────────────────────────── */

test('anthropic: system выносится отдельно, max_tokens обязателен', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      model: 'claude-3-5-sonnet-20241022',
      content: [
        { type: 'text', text: 'часть один. ' },
        { type: 'text', text: 'часть два.' },
      ],
      stop_reason: 'end_turn',
      usage: { input_tokens: 40, output_tokens: 12 },
    }),
  );

  try {
    const adapter = getAdapter('anthropic-messages');
    const result = await adapter.complete({ ...connection(mock.baseUrl), protocol: 'anthropic-messages' }, {
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'system', content: 'Ты QA-инженер' },
        { role: 'user', content: 'Проверь раздел' },
        { role: 'assistant', content: 'Проверил' },
      ],
    });

    const request = mock.requests[0];
    assert.equal(request.path, '/v1/messages');
    assert.equal(request.headers['x-api-key'], 'test-key-1234');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');

    const body = request.body as Record<string, unknown>;
    assert.equal(body.system, 'Ты QA-инженер');
    assert.equal(body.max_tokens, 4096);
    // system не должен попадать в messages.
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'Проверь раздел' },
      { role: 'assistant', content: 'Проверил' },
    ]);

    assert.equal(result.text, 'часть один. часть два.');
    assert.equal(result.usage.inputTokens, 40);
    assert.equal(result.finishReason, 'end_turn');
  } finally {
    await mock.close();
  }
});

test('anthropic: json-режим добавляет инструкцию к system', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { content: [{ type: 'text', text: '{}' }] }),
  );

  try {
    const adapter = getAdapter('anthropic-messages');
    await adapter.complete({ ...connection(mock.baseUrl), protocol: 'anthropic-messages' }, {
      model: 'claude',
      messages: [{ role: 'user', content: 'верни json' }],
      json: true,
    });

    const body = mock.requests[0].body as Record<string, unknown>;
    assert.match(String(body.system), /valid JSON/);
  } finally {
    await mock.close();
  }
});

test('anthropic: baseUrl с /v1 не дублируется', async () => {
  const mock = await mockServer((_request, response) => sendJson(response, 200, { content: [{ type: 'text', text: 'ok' }] }));

  try {
    const adapter = getAdapter('anthropic-messages');
    await adapter.complete({ ...connection(`${mock.baseUrl}/v1`), protocol: 'anthropic-messages' }, {
      model: 'claude',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(mock.requests[0].path, '/v1/messages');
  } finally {
    await mock.close();
  }
});

test('anthropic: listModels отдаёт display_name как label', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { data: [{ id: 'claude-3-5-sonnet', display_name: 'Claude 3.5 Sonnet' }] }),
  );

  try {
    const adapter = getAdapter('anthropic-messages');
    const models = await adapter.listModels!({ ...connection(mock.baseUrl), protocol: 'anthropic-messages' });
    assert.deepEqual(models, [{ id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' }]);
  } finally {
    await mock.close();
  }
});

/* ─────────────────────────── Gemini ─────────────────────────── */

test('gemini: contents/systemInstruction/generationConfig формируются корректно', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      modelVersion: 'gemini-2.0-flash',
      candidates: [{ content: { parts: [{ text: 'готовый раздел' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 9 },
    }),
  );

  try {
    const adapter = getAdapter('gemini');
    const result = await adapter.complete({ ...connection(mock.baseUrl, 'goog-key'), protocol: 'gemini' }, {
      model: 'models/gemini-2.0-flash',
      messages: [
        { role: 'system', content: 'Ты ассистент' },
        { role: 'user', content: 'Первый вопрос' },
        { role: 'assistant', content: 'Ответ' },
      ],
      params: { temperature: 0.5, maxOutputTokens: 800 },
      json: true,
    });

    const request = mock.requests[0];
    // Префикс models/ не должен дублироваться.
    assert.equal(request.path, '/models/gemini-2.0-flash:generateContent');
    assert.equal(request.headers['x-goog-api-key'], 'goog-key');

    const body = request.body as Record<string, unknown>;
    assert.deepEqual(body.contents, [
      { role: 'user', parts: [{ text: 'Первый вопрос' }] },
      { role: 'model', parts: [{ text: 'Ответ' }] },
    ]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Ты ассистент' }] });
    assert.deepEqual(body.generationConfig, {
      temperature: 0.5,
      maxOutputTokens: 800,
      responseMimeType: 'application/json',
    });

    assert.equal(result.text, 'готовый раздел');
    assert.equal(result.usage.outputTokens, 9);
    assert.equal(result.model, 'gemini-2.0-flash');
  } finally {
    await mock.close();
  }
});

test('gemini: listModels отбрасывает модели без generateContent', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      models: [
        { name: 'models/gemini-2.0-flash', displayName: 'Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
      ],
    }),
  );

  try {
    const adapter = getAdapter('gemini');
    const models = await adapter.listModels!({ ...connection(mock.baseUrl), protocol: 'gemini' });
    assert.deepEqual(models, [{ id: 'gemini-2.0-flash', label: 'Flash', contextLength: 1048576 }]);
  } finally {
    await mock.close();
  }
});

/* ─────────────────────────── OpenAI Responses ─────────────────────────── */

test('openai-responses: instructions и input-части', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      model: 'gpt-4.1',
      output_text: 'ответ responses',
      usage: { input_tokens: 11, output_tokens: 5 },
      status: 'completed',
    }),
  );

  try {
    const adapter = getAdapter('openai-responses');
    const result = await adapter.complete({ ...connection(mock.baseUrl), protocol: 'openai-responses' }, {
      model: 'gpt-4.1',
      messages: [
        { role: 'system', content: 'Системная роль' },
        { role: 'user', content: 'Запрос' },
      ],
      params: { maxOutputTokens: 300 },
    });

    const request = mock.requests[0];
    assert.equal(request.path, '/responses');
    const body = request.body as Record<string, unknown>;
    assert.equal(body.instructions, 'Системная роль');
    assert.equal(body.max_output_tokens, 300);
    assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: 'Запрос' }] }]);

    assert.equal(result.text, 'ответ responses');
    assert.equal(result.finishReason, 'completed');
  } finally {
    await mock.close();
  }
});

test('openai-responses: текст собирается из output[].content при отсутствии output_text', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'строка один' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'строка два' }] },
      ],
    }),
  );

  try {
    const adapter = getAdapter('openai-responses');
    const result = await adapter.complete({ ...connection(mock.baseUrl), protocol: 'openai-responses' }, {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
    });
    assert.equal(result.text, 'строка один\nстрока два');
  } finally {
    await mock.close();
  }
});

/* ─────────────────────────── LLMClient ─────────────────────────── */

interface ClientHarness {
  client: LLMClient;
  providers: ProviderRepository;
  routes: RouteRepository;
  usage: UsageRepository;
  db: ReturnType<typeof openDatabase>;
}

function clientHarness(): ClientHarness {
  const db = openDatabase(':memory:');
  const providers = new ProviderRepository(db);
  const routes = new RouteRepository(db);
  const usage = new UsageRepository(db);
  const settings = new SettingsRepository(db);
  const client = new LLMClient({ providers, routes, usage, settings, allowPrivate: true, retryBaseMs: 1 });
  return { client, providers, routes, usage, db };
}

test('client: повторяет временную ошибку и фиксирует повторы в usage', async () => {
  let calls = 0;
  const mock = await mockServer((_request, response) => {
    calls++;
    if (calls === 1) {
      sendJson(response, 503, { error: { message: 'временно недоступно' } });
      return;
    }
    sendJson(response, 200, {
      model: 'gpt-4o-mini',
      choices: [{ message: { content: 'получилось' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    });
  });

  try {
    const h = clientHarness();
    const provider = h.providers.create({
      name: 'Mock',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      defaultModel: 'gpt-4o-mini',
      maxRetries: 1,
    });
    h.routes.upsert('interview', { providerId: provider.id, model: 'gpt-4o-mini' });

    const result = await h.client.call({
      operation: 'interview',
      messages: [{ role: 'user', content: 'привет' }],
    });

    assert.equal(result.text, 'получилось');
    assert.equal(result.route.retries, 1);
    assert.equal(mock.requests.length, 2);

    const events = h.usage.list(10);
    assert.equal(events.length, 2);
    assert.equal(events.filter((event) => event.status === 'error').length, 1);
    assert.equal(events.filter((event) => event.status === 'ok').length, 1);
    assert.equal(events.find((event) => event.status === 'ok')?.retries, 1);

    h.db.close();
  } finally {
    await mock.close();
  }
});

test('client: не повторяет ошибку аутентификации', async () => {
  const mock = await mockServer((_request, response) => sendJson(response, 401, { error: 'nope' }));

  try {
    const h = clientHarness();
    const provider = h.providers.create({
      name: 'Mock',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: mock.baseUrl,
      apiKey: 'k',
      defaultModel: 'm',
      maxRetries: 3,
    });
    h.routes.upsert('interview', { providerId: provider.id, model: 'm' });

    await expectCode(
      h.client.call({ operation: 'interview', messages: [{ role: 'user', content: 'x' }] }),
      'PROVIDER_AUTH_FAILED',
    );
    assert.equal(mock.requests.length, 1);

    h.db.close();
  } finally {
    await mock.close();
  }
});

test('client: переключается на резервный маршрут', async () => {
  const primary = await mockServer((_request, response) => sendJson(response, 500, { error: 'сломался' }));
  const fallback = await mockServer((_request, response) =>
    sendJson(response, 200, {
      model: 'claude',
      content: [{ type: 'text', text: 'ответ резерва' }],
    }),
  );

  try {
    const h = clientHarness();
    const primaryProvider = h.providers.create({
      name: 'Primary',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: primary.baseUrl,
      defaultModel: 'm',
      maxRetries: 0,
    });
    const fallbackProvider = h.providers.create({
      name: 'Fallback',
      type: 'anthropic',
      protocol: 'anthropic-messages',
      baseUrl: fallback.baseUrl,
      defaultModel: 'claude-3-5-haiku',
      maxRetries: 0,
    });
    h.routes.upsert('section_synthesis', {
      providerId: primaryProvider.id,
      model: 'm',
      fallbackProviderId: fallbackProvider.id,
      fallbackModel: 'claude-3-5-haiku',
      useFallback: true,
    });

    const result = await h.client.call({
      operation: 'section_synthesis',
      messages: [{ role: 'user', content: 'x' }],
    });

    assert.equal(result.text, 'ответ резерва');
    assert.equal(result.route.fallbackUsed, true);
    assert.equal(result.route.providerName, 'Fallback');

    h.db.close();
  } finally {
    await primary.close();
    await fallback.close();
  }
});

test('client: пользовательские заголовки не переопределяют авторизацию', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { choices: [{ message: { content: 'ok' } }] }),
  );

  try {
    const h = clientHarness();
    const provider = h.providers.create({
      name: 'Mock',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: mock.baseUrl,
      apiKey: 'real-key',
      defaultModel: 'm',
      maxRetries: 0,
      // Попытка подменить авторизацию заголовком и добавить безопасный заголовок.
      customHeaders: { authorization: 'Bearer injected', 'x-custom-trace': 'abc' },
    });
    h.routes.upsert('interview', { providerId: provider.id, model: 'm' });

    await h.client.call({ operation: 'interview', messages: [{ role: 'user', content: 'x' }] });

    const headers = mock.requests[0].headers;
    assert.equal(headers.authorization, 'Bearer real-key');
    assert.equal(headers['x-custom-trace'], 'abc');

    h.db.close();
  } finally {
    await mock.close();
  }
});

test('client: без настроенного провайдера — PROVIDER_NOT_CONFIGURED', async () => {
  const h = clientHarness();
  try {
    await expectCode(
      h.client.call({ operation: 'interview', messages: [{ role: 'user', content: 'x' }] }),
      'PROVIDER_NOT_CONFIGURED',
    );
  } finally {
    h.db.close();
  }
});

test('client: пустая модель у провайдера и маршрута — MODEL_NOT_FOUND', async () => {
  const h = clientHarness();
  try {
    h.providers.create({
      name: 'NoModel',
      type: 'custom',
      protocol: 'openai-chat',
      baseUrl: 'https://example.test/v1',
    });
    await expectCode(
      h.client.call({ operation: 'interview', messages: [{ role: 'user', content: 'x' }] }),
      'MODEL_NOT_FOUND',
    );
  } finally {
    h.db.close();
  }
});

/* ─────────────────────────── Поисковые адаптеры ─────────────────────────── */

test('tavily: запрос и разбор результатов', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      results: [
        {
          title: 'Prompt Engineering Guide',
          url: 'https://example.com/guide?utm_source=x',
          content: 'Подробное руководство',
          published_date: '2026-01-01',
          score: 0.87,
        },
        { title: 'Без ссылки' },
      ],
    }),
  );

  try {
    const hits = await tavilyAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: 'tvly-key', options: { searchDepth: 'advanced' } },
      { query: 'prompt engineering', limit: 3 },
    );

    const request = mock.requests[0];
    assert.equal(request.path, '/search');
    assert.equal(request.headers.authorization, 'Bearer tvly-key');
    const body = request.body as Record<string, unknown>;
    assert.equal(body.query, 'prompt engineering');
    assert.equal(body.max_results, 3);
    assert.equal(body.search_depth, 'advanced');

    assert.equal(hits.length, 1);
    assert.equal(hits[0].title, 'Prompt Engineering Guide');
    // Трекинг-параметр удалён нормализацией URL.
    assert.equal(hits[0].url.includes('utm_source'), false);
    assert.equal(hits[0].publisher, 'example.com');
    assert.equal(hits[0].score, 0.87);
  } finally {
    await mock.close();
  }
});

test('tavily: без ключа — SEARCH_NOT_CONFIGURED', async () => {
  await expectCode(
    tavilyAdapter.search({ baseUrl: 'https://api.tavily.com', apiKey: '', options: {} }, { query: 'x' }),
    'SEARCH_NOT_CONFIGURED',
  );
});

test('brave: GET-параметры и разбор результатов', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      web: {
        results: [
          { title: 'Brave результат', url: 'https://news.example.com/a', description: 'описание', page_age: '2026-02-02' },
        ],
      },
    }),
  );

  try {
    const hits = await braveAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: 'brave-key', options: {} },
      { query: 'system prompt', limit: 4, language: 'ru', region: 'ru' },
    );

    const params = new URLSearchParams(mock.requests[0].query);
    assert.equal(mock.requests[0].method, 'GET');
    assert.equal(params.get('q'), 'system prompt');
    assert.equal(params.get('count'), '4');
    assert.equal(params.get('search_lang'), 'ru');
    assert.equal(params.get('country'), 'RU');
    assert.equal(mock.requests[0].headers['x-subscription-token'], 'brave-key');

    assert.equal(hits.length, 1);
    assert.equal(hits[0].publishedAt, '2026-02-02');
    assert.equal(hits[0].publisher, 'news.example.com');
  } finally {
    await mock.close();
  }
});

test('serpapi: ключ в query, позиция превращается в score', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      organic_results: [
        { title: 'Первый', link: 'https://a.example/1', snippet: 'сниппет', position: 1 },
        { title: 'Второй', link: 'https://b.example/2', position: 6 },
      ],
    }),
  );

  try {
    const hits = await serpApiAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: 'serp-key', options: { engine: 'google' } },
      { query: 'test', limit: 2 },
    );

    const params = new URLSearchParams(mock.requests[0].query);
    assert.equal(mock.requests[0].path, '/search.json');
    assert.equal(params.get('api_key'), 'serp-key');
    assert.equal(params.get('engine'), 'google');
    assert.equal(params.get('num'), '2');

    assert.equal(hits.length, 2);
    assert.ok((hits[0].score ?? 0) > (hits[1].score ?? 0));
  } finally {
    await mock.close();
  }
});

test('google-cse: путь не дублируется и требует cx', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, { items: [{ title: 'G', link: 'https://g.example/1', snippet: 's' }] }),
  );

  try {
    // Base URL уже содержит метод — второй /customsearch/v1 был бы ошибкой.
    const hits = await googleCseAdapter.search(
      { baseUrl: `${mock.baseUrl}/customsearch/v1`, apiKey: 'g-key', options: { cx: 'cx-123' } },
      { query: 'prompt', limit: 1 },
    );
    assert.equal(mock.requests[0].path, '/customsearch/v1');
    const params = new URLSearchParams(mock.requests[0].query);
    assert.equal(params.get('cx'), 'cx-123');
    assert.equal(params.get('key'), 'g-key');
    assert.equal(hits.length, 1);
  } finally {
    await mock.close();
  }
});

test('google-cse: корневой baseUrl получает полный путь', async () => {
  const mock = await mockServer((_request, response) => sendJson(response, 200, { items: [] }));

  try {
    await googleCseAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: 'g-key', options: { cx: 'cx-123' } },
      { query: 'prompt' },
    );
    assert.equal(mock.requests[0].path, '/customsearch/v1');
  } finally {
    await mock.close();
  }
});

test('google-cse: без cx — SEARCH_NOT_CONFIGURED', async () => {
  await expectCode(
    googleCseAdapter.search({ baseUrl: 'https://www.googleapis.com', apiKey: 'k', options: {} }, { query: 'x' }),
    'SEARCH_NOT_CONFIGURED',
  );
});

test('searxng: работает без ключа и ограничивает выдачу', async () => {
  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, {
      results: [
        { title: 'A', url: 'https://a.example/1', content: 'c1', score: 0.9 },
        { title: 'B', url: 'https://b.example/2', content: 'c2' },
        { title: 'C', url: 'https://c.example/3' },
      ],
    }),
  );

  try {
    const hits = await searxngAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: '', options: {} },
      { query: 'prompt', limit: 2, language: 'ru' },
    );

    const params = new URLSearchParams(mock.requests[0].query);
    assert.equal(params.get('format'), 'json');
    assert.equal(params.get('q'), 'prompt');
    assert.equal(hits.length, 2);
    assert.equal(hits[0].publisher, 'a.example');
  } finally {
    await mock.close();
  }
});

test('custom: требует baseUrl и понимает массив в корне ответа', async () => {
  await expectCode(
    customSearchAdapter.search({ baseUrl: '', apiKey: '', options: {} }, { query: 'x' }),
    'SEARCH_NOT_CONFIGURED',
  );

  const mock = await mockServer((_request, response) =>
    sendJson(response, 200, [
      { title: 'Свой шлюз', link: 'https://custom.example/1', description: 'описание' },
      { title: 'Без ссылки' },
    ]),
  );

  try {
    const hits = await customSearchAdapter.search(
      { baseUrl: mock.baseUrl, apiKey: 'custom-key', options: { extraBody: { tenant: 'acme' } } },
      { query: 'prompt', limit: 5 },
    );

    const body = mock.requests[0].body as Record<string, unknown>;
    assert.equal(body.query, 'prompt');
    assert.equal(body.tenant, 'acme');
    assert.equal(mock.requests[0].headers.authorization, 'Bearer custom-key');

    assert.equal(hits.length, 1);
    assert.equal(hits[0].url, 'https://custom.example/1');
    assert.equal(hits[0].snippet, 'описание');
  } finally {
    await mock.close();
  }
});

test('search: не-200 ответ провайдера превращается в понятную ошибку', async () => {
  const mock = await mockServer((_request, response) => sendJson(response, 429, { error: 'лимит' }));

  try {
    await expectCode(
      braveAdapter.search({ baseUrl: mock.baseUrl, apiKey: 'k', options: {} }, { query: 'x' }),
      'RATE_LIMITED',
    );
  } finally {
    await mock.close();
  }
});
