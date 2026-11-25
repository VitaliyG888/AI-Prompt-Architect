#!/usr/bin/env node
/**
 * Сборка библиотеки примеров промтов из исходного docx.
 *
 * Источник: promts/Промты для маркетологов _ gora-academy.ru.docx
 * Результат: src/server/domain/prompt-library.json
 *
 * Скрипт читает docx как zip (разбор центрального каталога + inflateRaw),
 * достаёт word/document.xml, разбирает абзацы по стилям и собирает
 * структурированный каталог: категория → промт → тело.
 *
 * В документе три разных способа разметки, поэтому у категории есть стратегия:
 *   headings  — промты выделены Heading2/Heading3 (большинство разделов);
 *   single    — весь раздел это один промт без подзаголовков;
 *   separator — промты разделены строкой «ПРОМТ N.» и линиями «=====».
 *
 * Дополнительно ловятся «осиротевшие» промты: абзац с императивом
 * («Создай…», «Напиши…») внутри чужого тела означает новый промт без заголовка.
 *
 * Запуск: node scripts/build-prompt-library.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'promts', 'Промты для маркетологов _ gora-academy.ru.docx');
const OUT = join(root, 'src', 'server', 'domain', 'prompt-library.json');

/* ─────────────────────────── Минимальный zip ─────────────────────────── */

function readZipEntry(buf, wanted) {
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip: не найден EOCD');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: битый центральный каталог');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    if (name === wanted) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(start, start + compSize);
      return method === 0 ? raw : inflateRawSync(raw);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip: нет записи ${wanted}`);
}

/* ─────────────────────────── Разбор document.xml ─────────────────────────── */

const XML_ENTITIES = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
  ['&#10;', '\n'],
  ['&amp;', '&'],
];

function decodeXml(text) {
  let out = text;
  for (const [from, to] of XML_ENTITIES) out = out.split(from).join(to);
  return out;
}

function paragraphText(xml) {
  let out = '';
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g;
  let match;
  while ((match = re.exec(xml))) {
    if (match[1] !== undefined) out += decodeXml(match[1]);
    else if (match[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

function parseParagraphs(xml) {
  const paragraphs = [];
  const re = /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
  let match;
  while ((match = re.exec(xml))) {
    const p = match[0];
    const styleMatch = p.match(/<w:pStyle\s+w:val="([^"]+)"/);
    const style = styleMatch ? styleMatch[1] : '';
    const text = paragraphText(p).replace(/\u00a0/g, ' ').trimEnd();
    paragraphs.push({
      style,
      numbered: /<w:numPr>/.test(p),
      bold: /<w:b\s*\/>|<w:b\s[^>]*\/>/.test(p),
      text,
    });
  }
  return paragraphs;
}

/* ─────────────────────────── Категории ─────────────────────────── */

const CATEGORY_META = {
  'Стратегия и планирование': {
    slug: 'strategy',
    label: 'Стратегия и планирование',
    tags: ['стратегия', 'планирование'],
    strategy: 'headings',
  },
  'ЦА и конкуренты': {
    slug: 'audience',
    label: 'Целевая аудитория и конкуренты',
    tags: ['аудитория', 'конкуренты'],
    strategy: 'headings',
  },
  Сайты: { slug: 'sites', label: 'Сайты и лендинги', tags: ['сайт', 'лендинг'], strategy: 'headings' },
  Копирайтинг: { slug: 'copywriting', label: 'Копирайтинг и тексты', tags: ['текст', 'копирайтинг'], strategy: 'headings' },
  'Рекламные объявления': {
    slug: 'ads',
    label: 'Рекламные объявления',
    tags: ['реклама', 'объявления'],
    strategy: 'headings',
  },
  Контент: { slug: 'content', label: 'Контент и YouTube', tags: ['контент', 'youtube'], strategy: 'headings' },
  Изображения: { slug: 'images', label: 'Изображения', tags: ['изображения', 'визуал'], strategy: 'headings' },
  'Универсальная структура промпта': {
    slug: 'meta',
    label: 'Структура промпта',
    tags: ['промт', 'структура'],
    strategy: 'single',
  },
  'Grok Build': { slug: 'tools', label: 'Сборка веб-приложений', tags: ['инструменты', 'html'], strategy: 'separator' },
};

const TAG_RULES = [
  [/лендинг|landing/i, 'лендинг'],
  [/сайт|вёрстк|верстк|tilda|тильда/i, 'сайт'],
  [/seo/i, 'seo'],
  [/заголовок|headline/i, 'заголовки'],
  [/оффер|утп|4u/i, 'оффер'],
  [/текст|статья|копирайт|редактур/i, 'текст'],
  [/сценар|сценарий|youtube/i, 'видео'],
  [/объявлен|директ|таргет|реклам/i, 'реклама'],
  [/контент-план|контент план/i, 'контент-план'],
  [/аудитор|анализ|аудит/i, 'анализ'],
  [/ц а|целевой аудитор|сегмент|5w|кастдев/i, 'аудитория'],
  [/конкурент/i, 'конкуренты'],
  [/утп|позиционирован/i, 'позиционирование'],
  [/kpi|метрик/i, 'метрики'],
  [/промпт|промт/i, 'промптинг'],
  [/изображен|картинк|визуал|промпт для генерации/i, 'изображения'],
  [/калькулятор|квиз/i, 'интерактив'],
  [/отзыв/i, 'отзывы'],
  [/слоган/i, 'слоганы'],
  [/email|рассылк/i, 'email'],
];

function detectTags(title, body) {
  const tags = new Set();
  const haystack = `${title}\n${body.slice(0, 1200)}`;
  for (const [re, tag] of TAG_RULES) if (re.test(haystack)) tags.add(tag);
  return [...tags];
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function extractVariables(body) {
  const found = new Set();
  const re = /\[([^\[\]\n]{2,70})\]/g;
  let match;
  while ((match = re.exec(body))) {
    const value = match[1].trim();
    if (/^[a-zа-яё\s,|/«»"'()\-–—]+$/iu.test(value) && !value.includes(']')) found.add(value);
  }
  return [...found].slice(0, 20);
}

/** Убирает хвостовые пробелы и схлопывает пустые строки, сохраняя абзацы. */
function cleanBody(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, '');
    if (!trimmed.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(trimmed);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/* ─────────────────────────── Разбиение на промты ─────────────────────────── */

/** Императивы, с которых начинается самостоятельный промт. */
const IMPERATIVE = /^(Создай|Напиши|Сделай|Разработай|Придумай|Проанализируй|Составь|Перепиши|Сгенерируй|Собери|Спроектируй|Опиши|Найди)\s/u;

/** Похоже ли, что абзац — это новый промт без заголовка внутри чужого тела. */
function isOrphanStart(paragraph, current) {
  if (paragraph.style) return false;
  if (!IMPERATIVE.test(paragraph.text.trim())) return false;
  const bodyLength = current.lines.join('\n').length;
  // Порог отсекает обычные продолжения вроде «Сделай акцент на…» короткой строкой.
  return bodyLength > 300 && paragraph.text.trim().length > 120;
}

function deriveTitle(text) {
  const firstSentence = text.trim().split(/(?<=[.!?])\s/)[0] ?? text.trim();
  const title = firstSentence.replace(/\s+/g, ' ').trim();
  return title.length > 70 ? `${title.slice(0, 67).trimEnd()}…` : title;
}

function pushLine(prompt, paragraph) {
  prompt.lines.push(paragraph.numbered ? `- ${paragraph.text}` : paragraph.text);
}

/** Стратегия headings: заголовок = Heading2/Heading3 или markdown-решётка. */
function promptsFromHeadings(section) {
  const out = [];
  let current = null;
  const close = () => {
    if (current) out.push(current);
    current = null;
  };

  for (const paragraph of section.paragraphs) {
    const style = paragraph.style;
    if (style === 'Heading2' || style === 'Heading3') {
      close();
      current = { title: paragraph.text.trim(), lines: [] };
      continue;
    }
    if (!current && !style && /^#{1,3}\s+\S/.test(paragraph.text)) {
      current = { title: paragraph.text.replace(/^#{1,3}\s+/, '').trim(), lines: [] };
      continue;
    }
    // Текст до первого подзаголовка — вводный, а не промт.
    if (!current) continue;
    if (isOrphanStart(paragraph, current)) {
      close();
      current = { title: deriveTitle(paragraph.text), lines: [] };
    }
    pushLine(current, paragraph);
  }
  close();
  return out;
}

/** Стратегия single: весь раздел — один промт; пример отбивается строкой «Пример:». */
function promptsFromSingle(section, label) {
  const lines = section.paragraphs.map((paragraph) =>
    paragraph.numbered ? `- ${paragraph.text}` : paragraph.text,
  );
  const markerIndex = lines.findIndex((line) => /^Пример\s*:?\s*$/u.test(line.trim()));
  if (markerIndex < 0) return [{ title: label, lines }];
  return [
    { title: label, lines: lines.slice(0, markerIndex) },
    { title: 'Пример заполнения структуры', lines: lines.slice(markerIndex + 1) },
  ];
}

/** Стратегия separator: промты разделены «ПРОМТ N.» и линиями из «=». */
function promptsFromSeparators(section) {
  const out = [];
  let current = null;
  const close = () => {
    if (current) out.push(current);
    current = null;
  };

  for (const paragraph of section.paragraphs) {
    const text = paragraph.text.trim();
    if (!text) continue;
    // Декоративные линии-разделители не несут содержимого.
    if (/^[=\-–—_*~]{5,}$/u.test(text)) continue;

    const separator = text.match(/^ПРОМТ\s+(\d+)\s*[.:)]?\s*(.*)$/iu);
    if (separator) {
      close();
      const title = separator[2].trim() || `Промт ${separator[1]}`;
      current = { title: title.replace(/\s+/g, ' '), lines: [] };
      continue;
    }
    if (!current) continue; // шапка раздела до первого «ПРОМТ N.»

    if (isOrphanStart(paragraph, current)) {
      close();
      current = { title: deriveTitle(text), lines: [] };
    }
    pushLine(current, paragraph);
  }
  close();
  return out;
}

function promptsForSection(section, meta) {
  const strategy = meta.strategy ?? 'headings';
  if (strategy === 'single') return promptsFromSingle(section, section.title);
  if (strategy === 'separator') return promptsFromSeparators(section);
  return promptsFromHeadings(section);
}

/* ─────────────────────────── Сборка каталога ─────────────────────────── */

/** Категория для промта, найденного «без заголовка»: ищем по смыслу. */
function categoryForDerived(text, fallbackSlug) {
  if (/html|веб-приложени|сайт|лендинг|квиз|игр/iu.test(text)) return 'sites';
  return fallbackSlug;
}

function build() {
  const buf = readFileSync(SOURCE);
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8');
  const paragraphs = parseParagraphs(xml);

  // 1. Нарезаем документ по Heading1.
  const sections = [];
  let currentSection = null;
  for (const paragraph of paragraphs) {
    if (paragraph.style === 'Heading1') {
      currentSection = { title: paragraph.text.trim(), paragraphs: [] };
      sections.push(currentSection);
      continue;
    }
    if (!currentSection) {
      currentSection = { title: '', paragraphs: [] };
      sections.push(currentSection);
    }
    currentSection.paragraphs.push(paragraph);
  }

  // 2. Каждый раздел разбираем своей стратегией.
  const prompts = [];
  const seen = new Set();
  const categories = [];

  for (const section of sections) {
    const meta = CATEGORY_META[section.title] ?? {
      slug: section.title ? slugify(section.title) : 'misc',
      label: section.title || 'Без категории',
      tags: [],
      strategy: 'headings',
    };

    const drafted = promptsForSection(section, meta);
    let count = 0;

    for (const draft of drafted) {
      const body = cleanBody(draft.lines);
      const title = draft.title.replace(/\s+/g, ' ').trim();

      // Слишком короткие фрагменты — подзаголовки-разделители, не промты.
      if (body.length < 60) continue;
      if (title.length < 3) continue;

      const hash = createHash('sha1').update(`${title}\n${body}`).digest('hex').slice(0, 12);
      if (seen.has(hash)) continue;
      seen.add(hash);

      // Промт без заголовка мог попасть в чужой раздел — уточняем категорию.
      const category = categoryForDerived(title, meta.slug);
      const categoryMeta =
        Object.values(CATEGORY_META).find((entry) => entry.slug === category) ?? meta;

      prompts.push({
        id: `${category}-${slugify(title) || hash}`,
        hash,
        category,
        categoryLabel: categoryMeta.label,
        title,
        body,
        chars: body.length,
        variables: extractVariables(body),
        tags: [...new Set([...categoryMeta.tags, ...detectTags(title, body)])],
      });
      count += 1;
    }

    if (count > 0 && section.title) {
      categories.push({ title: section.title, count });
    }
  }

  // 3. Итоговый каталог в порядке объявления категорий.
  const order = Object.values(CATEGORY_META).map((entry) => entry.slug);
  const resultCategories = order
    .map((slug) => {
      const items = prompts.filter((prompt) => prompt.category === slug);
      if (!items.length) return null;
      const meta = Object.values(CATEGORY_META).find((entry) => entry.slug === slug);
      return { slug, label: meta.label, count: items.length, tags: meta.tags };
    })
    .filter(Boolean);

  // Категории, которых нет в CATEGORY_META, но которые реально дали промты.
  for (const extra of prompts) {
    if (resultCategories.some((entry) => entry.slug === extra.category)) continue;
    const count = prompts.filter((prompt) => prompt.category === extra.category).length;
    resultCategories.push({
      slug: extra.category,
      label: extra.categoryLabel,
      count,
      tags: [],
    });
  }

  const catalog = {
    source: 'promts/Промты для маркетологов _ gora-academy.ru.docx',
    generatedAt: new Date().toISOString(),
    counts: { categories: resultCategories.length, prompts: prompts.length },
    categories: resultCategories,
    prompts: prompts.sort(
      (a, b) =>
        order.indexOf(a.category) - order.indexOf(b.category) || a.title.localeCompare(b.title, 'ru'),
    ),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');

  const totalChars = prompts.reduce((sum, prompt) => sum + prompt.chars, 0);
  console.log(`категорий: ${resultCategories.length}`);
  console.log(`промтов:   ${prompts.length}`);
  console.log(`символов:  ${totalChars}`);
  for (const category of resultCategories) {
    const sizes = prompts.filter((p) => p.category === category.slug).map((p) => p.chars);
    console.log(
      `  ${category.slug.padEnd(12)} ${String(category.count).padStart(3)} шт · медиана ${median(sizes)} симв. · ${category.label}`,
    );
  }
  const big = prompts.filter((p) => p.chars > 6000);
  if (big.length) console.log(`длинных (>6000): ${big.length}: ${big.map((p) => p.title).slice(0, 5).join('; ')}`);

  const ids = new Set(prompts.map((p) => p.id));
  if (ids.size !== prompts.length) {
    const duplicates = prompts.map((p) => p.id).filter((id, index, all) => all.indexOf(id) !== index);
    console.warn(`ВНИМАНИЕ: дубли id — ${[...new Set(duplicates)].join(', ')}`);
  }
  console.log(`→ ${OUT}`);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

build();
