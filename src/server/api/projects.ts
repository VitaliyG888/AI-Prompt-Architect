/** API проектов, разделов, интервью, исследования, синтеза, сборки и тестов. */
import type { Router } from '../http/router.ts';
import type { ApiDeps } from './helpers.ts';
import { requireProject, requireSectionKey } from './helpers.ts';
import { json, readJsonBody, noContent, ndjsonStreamResponse, streamEvents } from '../http/respond.ts';
import { asRecord, optionalEnum, optionalString, requireBoolean, requireEnum, requireString, stringArray } from '../core/validate.ts';
import { MODE_POLICIES, SECTION_STATUS_LABELS, SECTION_TITLES, type ProjectMode } from '../domain/types.ts';
import { exportJson, exportMarkdown, exportText, diffVersions } from '../engines/exporter.ts';
import { AppError, toAppError } from '../core/errors.ts';
import { describeSearchStatus } from '../engines/research.ts';

export function registerProjectRoutes(router: Router, deps: ApiDeps): void {
  const { app } = deps;

  router.get('/api/projects', () => json({ projects: app.projects.list() }));

  router.post('/api/projects', async ({ request }) => {
    const body = await readJsonBody(request);
    const idea = requireString(body.idea, 'idea', { min: 10, max: 20_000 });
    const mode = optionalEnum(body.mode, 'mode', ['quick', 'professional', 'expert'] as const) ?? app.settings.defaults().mode;
    const title = optionalString(body.title, 'title', { max: 160 }) ?? deriveTitle(idea);
    const audience = optionalString(body.audience, 'audience', { max: 400 }) ?? '';
    const targetModel = optionalString(body.targetModel, 'targetModel', { max: 200 }) ?? '';

    const project = app.projects.create({ title, idea, mode: mode as ProjectMode, audience, targetModel });
    return json({ project }, 201);
  });

  router.get('/api/projects/:id', ({ params }) => {
    const snapshot = app.orchestrator.snapshot(params.id);
    return json({
      ...snapshot,
      messages: app.messages.list(params.id, undefined, 300),
      sources: app.sources.list(params.id),
      versions: app.versions.list(params.id).map((version) => ({
        id: version.id,
        label: version.label,
        quality: version.quality,
        createdAt: version.createdAt,
        meta: version.meta,
      })),
      tests: app.tests.list(params.id).slice(0, 5),
      sectionStatusLabels: SECTION_STATUS_LABELS,
      searchStatus: app.search.available(),
      defaults: app.settings.defaults(),
    });
  });

  router.patch('/api/projects/:id', async ({ params, request }) => {
    requireProject(app, params.id);
    const body = await readJsonBody(request);
    const project = app.projects.update(params.id, {
      title: optionalString(body.title, 'title', { max: 160 }),
      audience: optionalString(body.audience, 'audience', { max: 400 }),
      targetModel: optionalString(body.targetModel, 'targetModel', { max: 200 }),
      mode: optionalEnum(body.mode, 'mode', ['quick', 'professional', 'expert'] as const),
    });
    return json({ project });
  });

  router.delete('/api/projects/:id', ({ params }) => {
    requireProject(app, params.id);
    app.projects.remove(params.id);
    return noContent();
  });

  router.post('/api/projects/:id/initialize', async ({ params }) => {
    const result = await app.orchestrator.initialize(params.id);
    return json({
      project: result.project,
      sections: result.sections,
      plan: result.plan,
    });
  });

  router.get('/api/projects/:id/messages', ({ params, query }) => {
    requireProject(app, params.id);
    const sectionKey = query.get('section');
    return json({ messages: app.messages.list(params.id, sectionKey ?? undefined, 400) });
  });

  router.post('/api/projects/:id/sections/:key/questions', async ({ params }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    const result = await app.orchestrator.askQuestions(params.id, key);
    return json(result);
  });

  router.post('/api/projects/:id/sections/:key/answers', async ({ params, request }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    const body = await readJsonBody(request);
    const answer = requireString(body.answer, 'answer', { min: 1, max: 20_000 });
    const questionId = optionalString(body.questionId, 'questionId', { max: 80 });
    const result = await app.orchestrator.submitAnswer({
      projectId: params.id,
      sectionKey: key,
      answer,
      questionId,
    });
    return json(result);
  });

  router.patch('/api/projects/:id/sections/:key', async ({ params, request }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    const body = await readJsonBody(request);
    const patch: Parameters<typeof app.sections.update>[2] = {};
    if (body.content !== undefined) patch.content = requireString(body.content, 'content', { min: 0, max: 60_000 });
    if (body.summary !== undefined) patch.summary = requireString(body.summary, 'summary', { min: 0, max: 2000 });
    if (body.status !== undefined) {
      patch.status = requireEnum(body.status, 'status', [
        'not_started',
        'awaiting_answer',
        'needs_clarification',
        'researching',
        'analyzing',
        'ready',
        'needs_revision',
      ] as const);
    }
    if (body.requirements !== undefined) patch.requirements = stringArray(body.requirements, 'requirements', 50);
    if (body.flags !== undefined) patch.flags = stringArray(body.flags, 'flags', 50);
    const section = app.sections.update(params.id, key, patch);
    app.projects.touch(params.id);
    return json({ section });
  });

  router.post('/api/projects/:id/sections/:key/research', async ({ params, request }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    let force = false;
    if (request.headers.get('content-type')?.includes('application/json')) {
      const body = await readJsonBody(request);
      force = body.force === true;
    }
    const outcome = await app.orchestrator.researchSection(params.id, key, force);
    return json({
      research: outcome.research,
      sources: outcome.sources,
      findings: outcome.findings,
      practices: outcome.practices,
      avoid: outcome.avoid,
    });
  });

  router.post('/api/projects/:id/sections/:key/synthesize', async ({ params, request }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    const body = request.headers.get('content-type')?.includes('application/json') ? await readJsonBody(request) : {};
    const feedback = optionalString(body.feedback, 'feedback', { max: 4000 });
    const evaluate = body.evaluate === undefined ? true : requireBoolean(body.evaluate, 'evaluate');
    const result = await app.orchestrator.synthesizeSection(params.id, key, { feedback, evaluate });
    return json({
      section: result.result.section,
      quality: result.quality,
      affected: result.affected,
      fromResearch: result.result.fromResearch,
      rejected: result.result.rejected,
      openQuestions: result.result.openQuestions,
      source: result.result.source,
      providerName: result.result.providerName,
      model: result.result.model,
    });
  });

  /**
   * Полный конвейер раздела с потоковой отдачей прогресса (NDJSON).
   * Шаги: research → synthesize → quality. Ошибка шага не обрывает поток
   * молча: клиент получает событие error с кодом.
   */
  router.post('/api/projects/:id/sections/:key/pipeline', ({ params, request }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);

    const { stream, send, close } = streamEvents();

    void (async () => {
      try {
        send({ type: 'start', section: key });
        const policy = MODE_POLICIES[app.projects.get(params.id).mode];

        if (policy.researchPerSection) {
          send({ type: 'step', step: 'research', message: 'Исследование источников…' });
          const outcome = await app.orchestrator.researchSection(params.id, key);
          send({
            type: 'research',
            status: outcome.research.status,
            message: outcome.research.message,
            sources: outcome.sources.length,
            findings: outcome.findings,
          });
        }

        send({ type: 'step', step: 'synthesis', message: 'Синтез раздела…' });
        const synthesized = await app.orchestrator.synthesizeSection(params.id, key);
        send({
          type: 'section',
          section: synthesized.result.section,
          quality: synthesized.quality,
          affected: synthesized.affected,
        });

        send({ type: 'done', section: key });
      } catch (error) {
        const appError = toAppError(error);
        send({ type: 'error', code: appError.code, message: appError.message });
      } finally {
        close();
      }
    })();

    // Тело запроса для этого эндпоинта не требуется.
    void request;
    return ndjsonStreamResponse(stream);
  });

  router.post('/api/projects/:id/sections/:key/alternatives/:index/accept', ({ params }) => {
    requireProject(app, params.id);
    const key = requireSectionKey(params.key);
    const index = Number.parseInt(params.index, 10);
    const section = app.sections.get(params.id, key);
    const alternative = section.alternatives[index];
    if (!alternative) throw new AppError('NOT_FOUND', 'Альтернатива не найдена');

    const updated = app.sections.update(params.id, key, {
      content: alternative.content,
      status: 'ready',
      decisions: [
        ...section.decisions,
        { question: 'Выбор варианта раздела', choice: alternative.label, source: 'user' as const },
      ],
      alternatives: section.alternatives.filter((_, i) => i !== index),
    });
    return json({ section: updated });
  });

  router.post('/api/projects/:id/assemble', async ({ params }) => {
    requireProject(app, params.id);
    const result = await app.orchestrator.assemble(params.id);
    return json({
      prompt: result.assembly.prompt,
      purpose: result.assembly.purpose,
      usage: result.assembly.usage,
      assumptions: result.assembly.assumptions,
      limitations: result.assembly.limitations,
      improvements: result.assembly.improvements,
      conflictsResolved: result.assembly.conflictsResolved,
      quality: result.assembly.quality,
      sources: result.assembly.sources,
      source: result.assembly.source,
      versionId: result.versionId,
    });
  });

  router.post('/api/projects/:id/test', async ({ params, request }) => {
    requireProject(app, params.id);
    const body = request.headers.get('content-type')?.includes('application/json') ? await readJsonBody(request) : {};
    const versionId = optionalString(body.versionId, 'versionId', { max: 60 });
    const count = body.count === undefined ? undefined : Number(body.count);
    const outcome = await app.orchestrator.testPrompt(params.id, {
      versionId,
      ...(Number.isFinite(count) ? { count: Math.min(8, Math.max(1, count as number)) } : {}),
    });

    const version = versionId ? app.versions.get(versionId) : app.versions.latest(params.id);
    if (version) {
      app.tests.create({
        projectId: params.id,
        versionId: version.id,
        prompt: version.prompt,
        providerName: outcome.providerName,
        model: outcome.model,
        status: outcome.executed ? 'done' : 'not_run',
        cases: outcome.cases,
        results: outcome.results,
        verdict: outcome.verdict,
      });
    }

    return json(outcome);
  });

  router.get('/api/projects/:id/versions', ({ params }) => {
    requireProject(app, params.id);
    return json({ versions: app.versions.list(params.id) });
  });

  router.get('/api/projects/:id/versions/:versionId', ({ params }) => {
    requireProject(app, params.id);
    const version = app.versions.get(params.versionId);
    if (version.projectId !== params.id) throw new AppError('NOT_FOUND', 'Версия не найдена');
    return json({ version });
  });

  router.get('/api/projects/:id/diff', ({ params, query }) => {
    requireProject(app, params.id);
    const versions = app.versions.list(params.id);
    const a = query.get('a') ? app.versions.get(query.get('a')!) : versions[1];
    const b = query.get('b') ? app.versions.get(query.get('b')!) : versions[0];
    if (!a || !b) throw new AppError('NOT_FOUND', 'Для сравнения нужно минимум две версии');
    const diff = diffVersions(a.prompt, b.prompt);
    return json({
      a: { id: a.id, label: a.label, createdAt: a.createdAt },
      b: { id: b.id, label: b.label, createdAt: b.createdAt },
      ...diff,
    });
  });

  router.get('/api/projects/:id/export', ({ params, query }) => {
    const project = requireProject(app, params.id);
    const format = query.get('format') ?? 'md';
    if (!['md', 'txt', 'json'].includes(format)) {
      throw new AppError('VALIDATION_FAILED', 'format должен быть md, txt или json');
    }

    const versions = app.versions.list(params.id);
    const latest = versions[0];
    if (!latest) throw new AppError('CONFLICT', 'Нет сохранённой версии промта: выполните сборку');

    const bundle = {
      project,
      sections: app.sections.list(params.id),
      sources: app.sources.list(params.id),
      versions,
      prompt: latest.prompt,
    };

    if (format === 'json') {
      return new Response(exportJson(bundle), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': contentDisposition(project.title, 'json'),
          'cache-control': 'no-store',
        },
      });
    }
    if (format === 'txt') {
      return new Response(exportText(bundle), {
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-disposition': contentDisposition(project.title, 'txt'),
          'cache-control': 'no-store',
        },
      });
    }
    return new Response(exportMarkdown(bundle), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': contentDisposition(project.title, 'md'),
        'cache-control': 'no-store',
      },
    });
  });

  router.get('/api/projects/:id/sources', ({ params, query }) => {
    requireProject(app, params.id);
    return json({ sources: app.sources.list(params.id, query.get('section') ?? undefined) });
  });

  router.get('/api/projects/:id/tests', ({ params }) => {
    requireProject(app, params.id);
    return json({ tests: app.tests.list(params.id) });
  });

  router.get('/api/projects/:id/search-status', async ({ params }) => {
    requireProject(app, params.id);
    return json(await describeSearchStatus(app.search));
  });

  router.get('/api/meta', () =>
    json({
      modes: Object.values(MODE_POLICIES),
      sections: Object.entries(SECTION_TITLES).map(([key, title]) => ({ key, title })),
      sectionStatusLabels: SECTION_STATUS_LABELS,
      searchProviders: app.search.available(),
      defaults: app.settings.defaults(),
    }),
  );
}

function deriveTitle(idea: string): string {
  const firstLine = idea.trim().split(/\r?\n/)[0] ?? '';
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= 70) return cleaned || 'Новый промт';
  return cleaned.slice(0, 67).trimEnd() + '…';
}

/**
 * Content-Disposition с поддержкой не-ASCII имён файлов.
 *
 * HTTP-заголовки допускают только байты 0x00–0xFF, поэтому кириллический
 * заголовок проекта нельзя положить в `filename=` напрямую. Отдаём ASCII-имя
 * как fallback и полное — через RFC 5987 (`filename*`).
 */
function contentDisposition(title: string, extension: string): string {
  const base = (title || 'prompt').trim() || 'prompt';
  const ascii = base
    .replace(/[^\x20-\x7e]+/g, '')
    .replace(/["\\]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const safeAscii = ascii || 'prompt';
  const encoded = encodeURIComponent(`${base.slice(0, 60)}.${extension}`).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${safeAscii}.${extension}"; filename*=UTF-8''${encoded}`;
}

export { asRecord };
