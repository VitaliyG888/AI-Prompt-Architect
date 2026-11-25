/**
 * Тонкий клиент API. Единственное место, где выполняются запросы к серверу.
 * Ошибки приводятся к AppError-подобному объекту с человекочитаемым текстом.
 */

const TOKEN_KEY = 'apa.token';

export class ApiError extends Error {
  code;
  status;
  details;

  constructor(message, code = 'UNKNOWN', status = 0, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function authHeaders() {
  const token = localStorage.getItem(TOKEN_KEY) ?? '';
  return token ? { 'x-app-token': token } : {};
}

async function request(method, path, body, options = {}) {
  const headers = { ...authHeaders(), ...(options.headers ?? {}) };
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, { method, headers, body: payload, signal: options.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new ApiError('Запрос отменён', 'CANCELLED', 0);
    throw new ApiError('Нет связи с сервером. Проверьте, запущено ли приложение.', 'NETWORK', 0);
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!response.ok) {
    const error = data?.error;
    throw new ApiError(
      error?.message ?? `Ошибка ${response.status}`,
      error?.code ?? 'HTTP_ERROR',
      response.status,
      error?.details,
    );
  }

  return data;
}

export const api = {
  get: (path, options) => request('GET', path, undefined, options),
  post: (path, body, options) => request('POST', path, body ?? {}, options),
  patch: (path, body, options) => request('PATCH', path, body ?? {}, options),
  put: (path, body, options) => request('PUT', path, body ?? {}, options),
  del: (path, options) => request('DELETE', path, undefined, options),

  // Проекты
  listProjects: () => api.get('/api/projects'),
  createProject: (input) => api.post('/api/projects', input),
  getProject: (id) => api.get(`/api/projects/${id}`),
  updateProject: (id, patch) => api.patch(`/api/projects/${id}`, patch),
  deleteProject: (id) => api.del(`/api/projects/${id}`),
  initialize: (id) => api.post(`/api/projects/${id}/initialize`),
  messages: (id, section) =>
    api.get(`/api/projects/${id}/messages${section ? `?section=${encodeURIComponent(section)}` : ''}`),

  // Разделы
  askQuestions: (id, key) => api.post(`/api/projects/${id}/sections/${key}/questions`),
  submitAnswer: (id, key, answer, questionId) =>
    api.post(`/api/projects/${id}/sections/${key}/answers`, { answer, questionId }),
  saveSection: (id, key, patch) => api.patch(`/api/projects/${id}/sections/${key}`, patch),
  research: (id, key, force) => api.post(`/api/projects/${id}/sections/${key}/research`, { force: Boolean(force) }),
  synthesize: (id, key, payload) => api.post(`/api/projects/${id}/sections/${key}/synthesize`, payload ?? {}),
  acceptAlternative: (id, key, index) =>
    api.post(`/api/projects/${id}/sections/${key}/alternatives/${index}/accept`),

  // Сборка и тесты
  assemble: (id) => api.post(`/api/projects/${id}/assemble`),
  test: (id, payload) => api.post(`/api/projects/${id}/test`, payload ?? {}),
  versions: (id) => api.get(`/api/projects/${id}/versions`),
  version: (id, versionId) => api.get(`/api/projects/${id}/versions/${versionId}`),
  diff: (id, a, b) => api.get(`/api/projects/${id}/diff?a=${a}&b=${b}`),
  sources: (id, section) =>
    api.get(`/api/projects/${id}/sources${section ? `?section=${encodeURIComponent(section)}` : ''}`),
  tests: (id) => api.get(`/api/projects/${id}/tests`),

  // Конфигурация
  catalog: () => api.get('/api/config/catalog'),
  providers: () => api.get('/api/providers'),
  createProvider: (input) => api.post('/api/providers', input),
  updateProvider: (id, patch) => api.patch(`/api/providers/${id}`, patch),
  deleteProvider: (id) => api.del(`/api/providers/${id}`),
  setDefaultProvider: (id) => api.post(`/api/providers/${id}/default`),
  testProvider: (id, model) => api.post(`/api/providers/${id}/test`, { model }),
  testProviderDraft: (draft) => api.post('/api/providers/test', { draft }),
  providerModels: (id) => api.get(`/api/providers/${id}/models`),

  routes: () => api.get('/api/routes'),
  saveRoute: (operation, payload) => api.put(`/api/routes/${operation}`, payload),

  searchProviders: () => api.get('/api/search-providers'),
  createSearchProvider: (input) => api.post('/api/search-providers', input),
  updateSearchProvider: (id, patch) => api.patch(`/api/search-providers/${id}`, patch),
  deleteSearchProvider: (id) => api.del(`/api/search-providers/${id}`),
  testSearchProvider: (id, query) => api.post(`/api/search-providers/${id}/test`, { query }),

  settings: () => api.get('/api/settings'),
  saveDefaults: (defaults) => api.put('/api/settings/defaults', defaults),
  usage: () => api.get('/api/usage'),
  health: () => api.get('/api/health'),
};

/**
 * Потоковый вызов конвейера раздела (NDJSON).
 * Возвращает управляемый объект с возможностью отмены.
 */
export function streamSectionPipeline(projectId, sectionKey, handlers) {
  const controller = new AbortController();

  void (async () => {
    try {
      const response = await fetch(`/api/projects/${projectId}/sections/${sectionKey}/pipeline`, {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const text = await response.text();
        let message = `Ошибка ${response.status}`;
        try {
          message = JSON.parse(text)?.error?.message ?? message;
        } catch {
          /* ignore */
        }
        handlers.onError?.(new ApiError(message, 'PIPELINE', response.status));
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'error') {
              handlers.onError?.(new ApiError(event.message, event.code, 0));
            } else {
              handlers.onEvent?.(event);
            }
          } catch {
            /* пропускаем некорректную строку */
          }
        }
      }
      handlers.onDone?.();
    } catch (error) {
      if (error.name === 'AbortError') return;
      handlers.onError?.(new ApiError(error.message ?? 'Поток прерван', 'NETWORK', 0));
    }
  })();

  return { cancel: () => controller.abort() };
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function hasToken() {
  return Boolean(localStorage.getItem(TOKEN_KEY));
}
