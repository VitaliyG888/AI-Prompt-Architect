/** Юнит-тесты ядра: JSON-разбор, шифрование, SSRF, валидация, качество, архетипы, экспорт. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseLooseJson } from '../src/server/core/json.ts';
import { decryptSecret, encryptSecret, maskSecret, isEncrypted, safeEqual } from '../src/server/core/crypto.ts';
import { assertSafeUrl, validateUrlShape } from '../src/server/core/ssrf.ts';
import { AppError } from '../src/server/core/errors.ts';
import {
  asRecord,
  clampText,
  numberInRange,
  optionalString,
  recordOfStrings,
  requireEnum,
  requireString,
  stringArray,
} from '../src/server/core/validate.ts';
import { aggregateQuality, heuristicQuality, normalizeQuality, QUALITY_CRITERIA } from '../src/server/domain/quality.ts';
import { detectArchetype, getArchetype, isCriticalSection } from '../src/server/domain/archetypes.ts';
import { diffVersions, exportJson, exportMarkdown, exportText } from '../src/server/engines/exporter.ts';
import { SECTION_DEPENDENCIES, SECTION_KEYS, SECTION_TITLES } from '../src/server/domain/types.ts';
import type { ProjectRecord, SectionRecord } from '../src/server/domain/types.ts';
import type { VersionRecord } from '../src/server/db/repo/versions.ts';
import {
  SKILLS,
  SKILLS_BY_ID,
  SKILL_CATEGORY_ORDER,
  EXAMPLE_BODY_LIMIT,
  selectSkills,
  exampleIdsFor,
  truncateExample,
} from '../src/server/domain/skills.ts';
import {
  PROMPT_LIBRARY_PROMPTS,
  getLibraryPrompt,
  getLibraryPrompts,
  librarySummary,
  searchLibrary,
} from '../src/server/domain/prompt-library.ts';
import { synthesisPrompt } from '../src/server/domain/prompts.ts';

/* ─────────────────────────── JSON ─────────────────────────── */

test('parseLooseJson: извлекает JSON из markdown-обёртки', () => {
  const raw = 'Вот результат:\n```json\n{"a": 1, "b": [2, 3]}\n```\nГотово.';
  const parsed = parseLooseJson<{ a: number; b: number[] }>(raw, { expect: 'object' });
  assert.deepEqual(parsed, { a: 1, b: [2, 3] });
});

test('parseLooseJson: исправляет висячие запятые', () => {
  const parsed = parseLooseJson<{ list: number[] }>('{"list": [1, 2, 3,],}', { expect: 'object' });
  assert.deepEqual(parsed, { list: [1, 2, 3] });
});

test('parseLooseJson: берёт последний блок кода при рассуждении перед JSON', () => {
  const raw = 'Сначала подумаю.\n```\n{"step": 1}\n```\nИтог:\n```\n{"final": true}\n```';
  const parsed = parseLooseJson<{ final: boolean }>(raw, { expect: 'object' });
  assert.equal(parsed.final, true);
});

test('parseLooseJson: бросает VALIDATION_FAILED на не-JSON', () => {
  assert.throws(() => parseLooseJson('совсем не json'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'VALIDATION_FAILED');
    return true;
  });
});

test('parseLooseJson: уважает ожидание массива', () => {
  assert.deepEqual(parseLooseJson<number[]>('[1,2]', { expect: 'array' }), [1, 2]);
  assert.throws(() => parseLooseJson('{"a":1}', { expect: 'array' }));
});

/* ─────────────────────────── Секреты ─────────────────────────── */

test('crypto: шифрование и расшифровка без потерь', () => {
  const secret = 'sk-test-abcdefghijklmnop';
  const encrypted = encryptSecret(secret);
  assert.ok(isEncrypted(encrypted));
  assert.equal(decryptSecret(encrypted), secret);
  assert.notEqual(encrypted, secret);
  // Разные IV — разный шифртекст для одного значения.
  assert.notEqual(encryptSecret(secret), encryptSecret(secret));
});

test('crypto: пустая строка остаётся пустой', () => {
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');
});

test('crypto: маска показывает только хвост', () => {
  assert.equal(maskSecret('sk-1234567890abcd'), '••••abcd');
  assert.equal(maskSecret('abc'), '••••');
  assert.equal(maskSecret(''), '');
});

test('crypto: повреждённый шифртекст не расшифровывается', () => {
  assert.throws(() => decryptSecret('v1:abc:def'), (error: unknown) => {
    assert.ok(error instanceof AppError);
    return true;
  });
});

test('crypto: safeEqual сравнивает по значению', () => {
  assert.equal(safeEqual('token-123', 'token-123'), true);
  assert.equal(safeEqual('token-123', 'token-124'), false);
  assert.equal(safeEqual('short', 'much-longer-value'), false);
});

/* ─────────────────────────── SSRF ─────────────────────────── */

test('ssrf: блокирует loopback без разрешения приватных адресов', async () => {
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:8080/v1', false), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, 'BLOCKED_URL');
    return true;
  });
});

test('ssrf: блокирует metadata-адрес', async () => {
  await assert.rejects(() => assertSafeUrl('http://169.254.169.254/latest', false), /BLOCKED_URL|metadata/);
});

test('ssrf: разрешает приватные адреса при явном флаге', async () => {
  const result = await assertSafeUrl('http://127.0.0.1:8080/v1', true);
  assert.equal(result.hostname, '127.0.0.1');
  assert.deepEqual(result.addresses, ['127.0.0.1']);
});

test('ssrf: запрещает нестандартные протоколы и учётные данные в URL', async () => {
  await assert.rejects(() => assertSafeUrl('ftp://example.com/x', false), /http/);
  await assert.rejects(() => assertSafeUrl('https://user:pass@example.com/x', false), /Учётные данные/);
});

test('ssrf: validateUrlShape не делает DNS-запросов', () => {
  assert.equal(validateUrlShape('https://api.example.com/v1').ok, true);
  assert.equal(validateUrlShape('notaurl').ok, false);
  assert.equal(validateUrlShape('ftp://example.com').ok, false);
});

/* ─────────────────────────── Валидация ─────────────────────────── */

test('validate: строки, границы и перечисления', () => {
  assert.equal(requireString('  текст  ', 'f'), 'текст');
  assert.throws(() => requireString('', 'f'), /короче минимума/);
  assert.throws(() => requireString('x'.repeat(5), 'f', { max: 3 }), /длиннее максимума/);
  assert.equal(optionalString('', 'f'), undefined);
  assert.equal(optionalString(null, 'f'), undefined);
  assert.equal(requireEnum('quick', 'mode', ['quick', 'expert'] as const), 'quick');
  assert.throws(() => requireEnum('bad', 'mode', ['quick'] as const), /одним из/);
});

test('validate: числа в диапазоне и целочисленность', () => {
  assert.equal(numberInRange('5', 'n', { min: 1, max: 10 }), 5);
  assert.equal(numberInRange(undefined, 'n', {}), undefined);
  assert.throws(() => numberInRange(11, 'n', { max: 10 }), /больше/);
  assert.throws(() => numberInRange(1.5, 'n', { integer: true }), /целым/);
  assert.throws(() => numberInRange('abc', 'n', {}), /числом/);
});

test('validate: массивы, объекты и обрезка текста', () => {
  assert.deepEqual(stringArray(['a', 'b'], 'f'), ['a', 'b']);
  assert.throws(() => stringArray([1], 'f'), /строкой/);
  assert.deepEqual(recordOfStrings({ a: 'b' }, 'f'), { a: 'b' });
  assert.throws(() => asRecord([], 'f'), /объектом/);
  const long = 'a'.repeat(500);
  assert.ok(clampText(long, 100).length < 400);
  assert.ok(clampText(long, 100).includes('сокращено'));
});

/* ─────────────────────────── Качество ─────────────────────────── */

test('quality: normalize пересчитывает итог сам и требует обязательные проверки', () => {
  const report = normalizeQuality({
    criteria: QUALITY_CRITERIA.map((criterion) => ({ key: criterion.key, score: 90 })),
    mandatory: [],
    verdict: 'pass',
  });
  // Все баллы 90 → итог 90, но ни одна обязательная проверка не подтверждена.
  assert.equal(report.total, 90);
  assert.equal(report.verdict, 'revise');
  assert.equal(report.heuristic, false);
  assert.equal(report.mandatory.filter((item) => item.passed).length, 0);
});

test('quality: подтверждённые обязательные проверки дают pass', () => {
  const report = normalizeQuality({
    criteria: QUALITY_CRITERIA.map((criterion) => ({ key: criterion.key, score: 95 })),
    mandatory: [
      { key: 'requirements', passed: true },
      { key: 'no_conflicts', passed: true },
      { key: 'applicable_format', passed: true },
      { key: 'feasible', passed: true },
    ],
    verdict: 'pass',
  });
  assert.equal(report.verdict, 'pass');
  assert.ok(report.total >= 90);
});

test('quality: эвристика помечена и не выдаёт себя за модель', () => {
  const content = [
    'Ты — старший аналитик.',
    '',
    '## Процесс',
    '- Всегда проверяй входные данные',
    '- Никогда не выдумывай источники',
    '',
    'Верни результат в формате таблицы.',
  ].join('\n');
  const report = heuristicQuality(content, ['требование 1']);
  assert.equal(report.heuristic, true);
  assert.ok(report.total > 0 && report.total <= 100);
  assert.ok(report.criteria.every((item) => item.note.includes('эвристическая')));
});

test('quality: эвристика видит заглушки', () => {
  const report = heuristicQuality('TODO: заполнить раздел позже, качественно и эффективно', []);
  assert.equal(report.verdict, 'revise');
  assert.ok(report.issues.some((issue) => issue.includes('заглушк')));
});

test('quality: агрегат по разделам', () => {
  const good = normalizeQuality({
    criteria: QUALITY_CRITERIA.map((criterion) => ({ key: criterion.key, score: 90 })),
    mandatory: [
      { key: 'requirements', passed: true },
      { key: 'no_conflicts', passed: true },
      { key: 'applicable_format', passed: true },
      { key: 'feasible', passed: true },
    ],
    verdict: 'pass',
  });
  const aggregate = aggregateQuality([good, good]);
  assert.equal(aggregate.total, 90);
  assert.equal(aggregate.failedMandatory, 0);
  assert.equal(aggregateQuality([]).total, 0);
});

/* ─────────────────────────── Архетипы и разделы ─────────────────────────── */

test('archetypes: определение по ключевым словам', () => {
  assert.equal(detectArchetype('Промт для генератора изображений и стиля иллюстраций'), 'image_generator');
  assert.equal(detectArchetype('Ассистент программиста: архитектура кода и тесты'), 'ai_programmer');
  assert.equal(detectArchetype('нечто совершенно неопределённое'), 'generic');
  assert.ok(getArchetype('generic').label.length > 0);
});

test('archetypes: критичные разделы входят в канонический список', () => {
  const archetype = getArchetype('ai_programmer');
  for (const key of archetype.criticalSections) {
    assert.ok(SECTION_KEYS.includes(key), `${key} должен быть валидным разделом`);
    assert.ok(isCriticalSection('ai_programmer', key));
  }
});

test('sections: граф зависимостей ссылается только на существующие разделы', () => {
  for (const key of SECTION_KEYS) {
    assert.ok(SECTION_TITLES[key], `нет заголовка для ${key}`);
    for (const dependent of SECTION_DEPENDENCIES[key]) {
      assert.ok(SECTION_KEYS.includes(dependent), `${key} ссылается на неизвестный ${dependent}`);
    }
  }
});

/* ─────────────────────────── Архетип сайта ─────────────────────────── */

test('archetypes: сайт уходит в site_builder, а не в маркетинг', () => {
  // Раньше «лендинг» попадал в marketing_expert, и интервью спрашивало
  // про юридические ограничения вместо типа сайта и стека.
  assert.equal(detectArchetype('Нужен лендинг для салона красоты с записью онлайн'), 'site_builder');
  assert.equal(detectArchetype('Многостраничный сайт студии на Tilda'), 'site_builder');
  assert.equal(detectArchetype('Разработка сайта для интернет-магазина'), 'site_builder');

  const archetype = getArchetype('site_builder');
  const probes = Object.values(archetype.probes).flat().join(' ').toLowerCase();

  // Вопросы — про сайт: тип, стек, адаптивность. Юридической части нет.
  assert.match(probes, /лендинг|многостраничн/);
  assert.match(probes, /конструктор|tilda|wordpress|html|react|next/);
  assert.match(probes, /адаптивн|мобильн/);
  assert.doesNotMatch(probes, /юридическ/);

  for (const key of archetype.criticalSections) {
    assert.ok(SECTION_KEYS.includes(key), `${key} должен быть валидным разделом`);
  }
});

test('archetypes: ключевые слова не пересекаются между сайтом и маркетингом', () => {
  // Маркетинговые ключи не должны содержать «лендинг»: иначе архетип
  // определяется порядком перебора, а не смыслом задачи.
  assert.equal(detectArchetype('Маркетинговая стратегия и воронка продаж'), 'marketing_expert');
  assert.equal(detectArchetype('Лендинг для студии маникюра'), 'site_builder');
});

/* ─────────────────────────── Библиотека примеров ─────────────────────────── */

test('library: каталог целостен и пригоден для подстановки', () => {
  const summary = librarySummary();
  assert.ok(summary.counts.categories >= 5, 'категорий должно быть не меньше пяти');
  assert.equal(summary.counts.prompts, PROMPT_LIBRARY_PROMPTS.length);
  assert.ok(summary.counts.prompts > 0);

  const ids = new Set<string>();
  for (const prompt of PROMPT_LIBRARY_PROMPTS) {
    assert.ok(!ids.has(prompt.id), `дубликат id в библиотеке: ${prompt.id}`);
    ids.add(prompt.id);
    assert.ok(prompt.title.trim().length > 0, `пустой заголовок у ${prompt.id}`);
    assert.ok(prompt.body.trim().length > 0, `пустое тело у ${prompt.id}`);
    assert.equal(prompt.chars, prompt.body.length, `chars не совпадает с телом у ${prompt.id}`);
    assert.ok(prompt.category.length > 0);
  }

  // Каждая категория из сводки реально содержит примеры.
  for (const category of summary.categories) {
    assert.ok(category.count > 0, `категория ${category.slug} пустая`);
    assert.equal(
      PROMPT_LIBRARY_PROMPTS.filter((prompt) => prompt.category === category.slug).length,
      category.count,
      `счётчик категории ${category.slug} расходится с содержимым`,
    );
  }
});

test('library: выборка по id и поиск работают предсказуемо', () => {
  const first = PROMPT_LIBRARY_PROMPTS[0];
  const found = getLibraryPrompt(first.id);
  assert.ok(found);
  assert.equal(found.id, first.id);
  assert.equal(found.body, first.body);

  assert.equal(getLibraryPrompt('нет-такого-примера'), null);
  assert.deepEqual(getLibraryPrompts(['нет-такого-примера']), []);

  // Порядок сохраняется, отсутствующие id пропускаются.
  const second = PROMPT_LIBRARY_PROMPTS[1];
  assert.deepEqual(
    getLibraryPrompts([second.id, 'нет-такого-примера', first.id]).map((prompt) => prompt.id),
    [second.id, first.id],
  );

  // Поиск по категории не смешивает категории.
  const category = PROMPT_LIBRARY_PROMPTS[0].category;
  const searched = searchLibrary({ category, limit: 5 });
  assert.ok(searched.length > 0);
  assert.ok(searched.every((prompt) => prompt.category === category));
});

/* ─────────────────────────── Скиллы ─────────────────────────── */

test('skills: каталог целостен, идентификаторы уникальны', () => {
  const ids = new Set<string>();
  for (const skill of SKILLS) {
    assert.ok(!ids.has(skill.id), `дубликат скилла: ${skill.id}`);
    ids.add(skill.id);
    assert.ok(skill.label.trim().length > 0, `пустая подпись у ${skill.id}`);
    assert.ok(skill.guidance.length > 0, `нет обязательных требований у ${skill.id}`);
    assert.ok(skill.antiPatterns.length > 0, `нет ошибок-антипаттернов у ${skill.id}`);
    assert.ok(
      (SKILL_CATEGORY_ORDER as readonly string[]).includes(skill.category),
      `неизвестная категория у ${skill.id}`,
    );
    for (const key of skill.sections) {
      assert.ok(SECTION_KEYS.includes(key), `${skill.id} ссылается на неизвестный раздел ${key}`);
    }
    assert.equal(SKILLS_BY_ID.get(skill.id)?.id, skill.id);
  }

  // Каждая категория представлена хотя бы одним скиллом.
  for (const category of SKILL_CATEGORY_ORDER) {
    assert.ok(SKILLS.some((skill) => skill.category === category), `категория ${category} пустая`);
  }
});

test('skills: все exampleIds резолвятся в библиотеку', () => {
  const missing: string[] = [];
  for (const skill of SKILLS) {
    for (const id of skill.exampleIds) {
      if (!getLibraryPrompt(id)) missing.push(`${skill.id} -> ${id}`);
    }
  }
  assert.deepEqual(missing, [], `примеры не найдены: ${missing.join(', ')}`);
});

test('skills: подбор детерминирован и не превышает лимит', () => {
  const input = {
    idea: 'Нужен лендинг для салона красоты с записью онлайн',
    sectionKey: 'context' as const,
    archetype: 'site_builder' as const,
    limit: 3,
  };

  const first = selectSkills(input).map((entry) => entry.skill.id);
  const second = selectSkills(input).map((entry) => entry.skill.id);

  assert.deepEqual(first, second, 'подбор должен быть детерминирован');
  assert.ok(first.length <= 3);
  assert.equal(new Set(first).size, first.length, 'скиллы не должны повторяться');
  // Для сайта первым идёт скилл структуры лендинга.
  assert.equal(first[0], 'site-landing-structure');
  assert.ok(selectSkills({ ...input, limit: 1 }).length === 1);
});

test('skills: сайт получает скиллы сайтов, а не только маркетинга', () => {
  const selected = selectSkills({
    idea: 'Лендинг для салона красоты',
    sectionKey: 'expertise',
    archetype: 'site_builder',
    limit: 3,
  });

  assert.ok(selected.length > 0);
  assert.ok(
    selected.some((entry) => entry.skill.category === 'sites'),
    'сайтовая задача должна получать скиллы категории «сайты»',
  );
  // Есть причина выбора — интерфейс должен объяснять решение.
  assert.ok(selected.every((entry) => entry.reasons.length > 0));
});

test('skills: примеры выбираются по порядку скиллов без дублей', () => {
  const skills = SKILLS.filter((skill) => skill.exampleIds.length > 0).slice(0, 2);
  const ids = exampleIdsFor(skills);

  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, ids.length, 'примеры не должны дублироваться');
  for (const id of ids) assert.ok(getLibraryPrompt(id), `пример ${id} не найден`);

  const repeated = exampleIdsFor([skills[0], skills[0]]);
  assert.deepEqual(repeated, exampleIdsFor([skills[0]]));
});

test('skills: длинный пример обрезается до лимита и помечается', () => {
  const long = 'x'.repeat(EXAMPLE_BODY_LIMIT + 500);
  const truncated = truncateExample(long);

  assert.ok(truncated.length <= EXAMPLE_BODY_LIMIT + 1);
  assert.ok(truncated.endsWith('…'));
  assert.equal(truncateExample('короткий'), 'короткий');
});

/* ─────────────────────────── Промт синтеза ─────────────────────────── */

const SYNTHESIS_BASE = {
  idea: 'Лендинг для салона красоты',
  audience: 'владельцы салонов',
  targetModel: 'gpt-4o',
  mode: 'professional' as const,
  sectionTitle: 'CONTEXT — Контекст',
  sectionKey: 'context',
  requirements: ['указать тип сайта'],
  researchFindings: [],
  researchPractices: [],
  researchAvoid: [],
  researchAvailable: false,
  sources: [],
  alternatives: 1,
};

test('synthesisPrompt: без скиллов блоков D и E нет', () => {
  const pair = synthesisPrompt(SYNTHESIS_BASE);

  assert.doesNotMatch(pair.user, /D\. Профессиональные требования/);
  assert.doesNotMatch(pair.user, /E\. Примеры из библиотеки/);
  // Базовая структура A, B, C сохраняется.
  assert.match(pair.user, /A\. Требования пользователя/);
  assert.match(pair.user, /B\. Результаты исследования/);
});

test('synthesisPrompt: скиллы попадают в промт как чек-лист', () => {
  const [skill] = SKILLS;
  const pair = synthesisPrompt({
    ...SYNTHESIS_BASE,
    skills: [
      {
        label: skill.label,
        categoryLabel: 'Сайты и интерфейсы',
        guidance: skill.guidance,
        antiPatterns: skill.antiPatterns,
      },
    ],
  });

  assert.match(pair.user, /D\. Профессиональные требования/);
  assert.match(pair.user, new RegExp(skill.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Требования и антипаттерны присутствуют дословно.
  assert.ok(pair.user.includes(skill.guidance[0]));
  assert.ok(pair.user.includes(skill.antiPatterns[0]));
  // Системная часть запрещает выводить сами чек-листы в раздел.
  assert.match(pair.system, /не выводи сами чек-листы/);
});

test('synthesisPrompt: примеры помечены как образец формы', () => {
  const [prompt] = PROMPT_LIBRARY_PROMPTS;
  const pair = synthesisPrompt({
    ...SYNTHESIS_BASE,
    examples: [
      {
        title: prompt.title,
        body: truncateExample(prompt.body),
        categoryLabel: 'Сайты и интерфейсы',
      },
    ],
  });

  assert.match(pair.user, /E\. Примеры из библиотеки/);
  assert.ok(pair.user.includes(prompt.title));
  // Ключевое ограничение: пример не источник фактов.
  assert.match(pair.system, /НЕ копируй формулировки/);
  assert.match(pair.system, /не переноси факты/i);
});

/* ─────────────────────────── Экспорт и дифф ─────────────────────────── */

const project: ProjectRecord = {
  id: 'prj_test',
  title: 'Тестовый промт',
  idea: 'Идея тестового промта для поддержки',
  mode: 'professional',
  status: 'complete',
  stage: 'review',
  audience: 'клиенты',
  targetModel: 'test-model',
  providerSnapshot: {},
  settings: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const section: SectionRecord = {
  id: 'sec_1',
  projectId: 'prj_test',
  key: 'role',
  title: 'ROLE — Роль',
  orderIndex: 0,
  status: 'ready',
  content: 'Ты — старший специалист поддержки.',
  summary: 'Роль специалиста поддержки',
  requirements: ['Отвечать по шагам'],
  openQuestions: [],
  research: {
    status: 'done',
    queries: ['support prompt'],
    summary: '',
    findings: [],
    sourceIds: [],
    providers: ['tavily'],
    message: '',
    updatedAt: '',
  },
  quality: null,
  alternatives: [],
  decisions: [],
  flags: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const version: VersionRecord = {
  id: 'ver_1',
  projectId: 'prj_test',
  label: 'v1',
  prompt: 'Ты — старший специалист поддержки.\n\nОтвечай кратко.',
  quality: null,
  meta: { purpose: 'Поддержка пользователей', usage: ['Вставьте как системную инструкцию'] },
  createdAt: '2026-01-01T00:00:00.000Z',
};

test('exporter: markdown содержит промт, раздел и источники', () => {
  const markdown = exportMarkdown({
    project,
    sections: [section],
    sources: [
      {
        id: 'res_1',
        projectId: 'prj_test',
        sectionKey: 'role',
        title: 'Best practices',
        url: 'https://example.com/a',
        publisher: 'example.com',
        publishedAt: '',
        snippet: '',
        query: 'q',
        provider: 'tavily',
        relevance: 0.9,
        analysis: null,
        fetchedAt: '',
      },
    ],
    versions: [version],
    prompt: version.prompt,
  });
  assert.ok(markdown.includes('# Тестовый промт'));
  assert.ok(markdown.includes('Ты — старший специалист поддержки.'));
  assert.ok(markdown.includes('https://example.com/a'));
  assert.ok(markdown.includes('## Как применять'));
});

test('exporter: txt и json пригодны для обработки', () => {
  const bundle = { project, sections: [section], sources: [], versions: [version], prompt: version.prompt };
  const text = exportText(bundle);
  assert.ok(text.includes('Ты — старший специалист поддержки.'));

  const json = JSON.parse(exportJson(bundle)) as Record<string, unknown>;
  assert.equal((json.project as ProjectRecord).id, 'prj_test');
  assert.equal(json.prompt, version.prompt);
  assert.ok(Array.isArray(json.sections));
});

test('diff: находит добавленные и удалённые строки', () => {
  const diff = diffVersions('a\nb\nc', 'a\nc\nd');
  assert.equal(diff.removed, 1);
  assert.equal(diff.added, 1);
  assert.ok(diff.lines.some((line) => line.type === 'removed' && line.text === 'b'));
  assert.ok(diff.lines.some((line) => line.type === 'added' && line.text === 'd'));
  assert.equal(diffVersions('same', 'same').added, 0);
});
