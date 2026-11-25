/**
 * Архетипы задач и эвристика их определения.
 *
 * Структура интервью адаптируется: для AI-программиста важны архитектура и
 * тестирование, для генератора изображений — стиль и композиция. Архетип
 * задаёт акценты вопросов и шаблоны исследовательских запросов, но не
 * жёсткий опросник: финальный план формирует LLM.
 */
import type { SectionKey } from './types.ts';

export type ArchetypeId =
  | 'ai_programmer'
  | 'site_builder'
  | 'financial_analyst'
  | 'research_agent'
  | 'marketing_expert'
  | 'image_generator'
  | 'business_consultant'
  | 'generic';

export interface Archetype {
  id: ArchetypeId;
  label: string;
  /** Разделы, без которых промт неполон. */
  criticalSections: SectionKey[];
  /** Что обязательно выяснить в каждом разделе. */
  probes: Partial<Record<SectionKey, string[]>>;
  /** Шаблоны поисковых запросов; {topic} заменяется на тему проекта. */
  researchTemplates: string[];
  /** Типичные риски неполного промта. */
  risks: string[];
}

const COMMON: Archetype['probes'] = {
  role: ['уровень экспертизы', 'границы ответственности', 'стиль ответа'],
  context: ['среда применения', 'аудитория', 'входные данные', 'текущая проблема'],
  objective: ['главный результат', 'подзадачи', 'приоритеты при конфликте целей'],
  output_format: ['структура ответа', 'язык', 'объём', 'нужен ли JSON/таблицы'],
  constraints: ['чего нельзя делать', 'требования безопасности', 'допустимые допущения'],
};

const ARCHETYPES: Archetype[] = [
  {
    id: 'ai_programmer',
    label: 'AI-программист',
    criticalSections: ['role', 'context', 'objective', 'expertise', 'methodology', 'workflow', 'constraints', 'output_format', 'quality_criteria', 'error_handling'],
    probes: {
      ...COMMON,
      expertise: ['языки и версии', 'фреймворки', 'работа с репозиторием и git', 'тестирование'],
      methodology: ['подход к отладке', 'как проверять гипотезы', 'работа с legacy-кодом'],
      workflow: ['порядок анализа → изменения → тесты', 'точки согласования', 'работа с миграциями'],
      constraints: ['запрещённые зависимости', 'лицензии', 'обратная совместимость', 'секреты в коде'],
      quality_criteria: ['проходит линтер и тесты', 'нет ли регрессий', 'читаемость diff'],
      error_handling: ['поведение при падении тестов', 'при недоступности документации'],
    },
    researchTemplates: [
      'prompt engineering best practices for AI coding agent {topic}',
      'system prompt structure for software engineering assistant architecture testing',
      'LLM agent coding workflow specification repository constraints',
    ],
    risks: ['нет требований к тестам', 'не указаны версии стека', 'нет критериев готовности кода'],
  },
  {
    id: 'site_builder',
    label: 'Разработка сайта',
    criticalSections: [
      'role',
      'context',
      'objective',
      'expertise',
      'methodology',
      'workflow',
      'constraints',
      'output_format',
      'quality_criteria',
    ],
    probes: {
      ...COMMON,
      context: [
        'тип сайта: лендинг, многостраничный, каталог или интернет-магазин',
        'сфера и продукт (например, салон красоты)',
        'аудитория и главное действие посетителя',
        'есть ли готовые тексты, фото и контакты',
      ],
      objective: [
        'главная цель: заявка, звонок, запись или покупка',
        'ключевые метрики успеха',
        'что важнее при конфликте: конверсия или информативность',
      ],
      expertise: [
        'на чём собираем: конструктор (Tilda, WordPress) или код (HTML/CSS/JS, React, Next.js)',
        'фреймворк и версия, если это код',
        'нужна ли CMS и кто будет редактировать контент',
        'адаптивность и мобильная версия',
        'требования к скорости загрузки',
      ],
      methodology: [
        'структура страниц и навигация: какие страницы и что на каждой',
        'логика блоков: оффер на первом экране, затем доказательства и призыв к действию',
        'сетка, отступы и переиспользуемые компоненты',
        'семантика, доступность, alt-тексты',
      ],
      workflow: [
        'порядок: требования → прототип → вёрстка → проверка в браузерах',
        'точки согласования макета',
        'проверка на разрешениях 320–1440',
        'передача на публикацию, домен и аналитику',
      ],
      tools: [
        'конструктор или стек и версии',
        'шрифты, иконки, изображения',
        'формы, аналитика, интеграции (заявки в Telegram или CRM)',
      ],
      constraints: [
        'не выдумывать отзывы, цифры, награды и кейсы',
        'указывать только реальные услуги, цены и контакты',
        'не использовать чужие изображения как свои',
      ],
      output_format: [
        'структура страниц и секций с назначением каждой',
        'готовый код (HTML/CSS/JS) или набор блоков конструктора',
        'тексты страницы и alt-тексты',
        'правила адаптивности: что меняется на мобильных',
      ],
      quality_criteria: [
        'цель страницы достижима с первого экрана',
        'корректная адаптивность на 320, 480, 768, 1024, 1440',
        'нет битых ссылок, пустых форм и заглушек',
        'базовая SEO-разметка и быстрая загрузка',
      ],
      error_handling: [
        'что делать, если нет контента или фото',
        'поведение при отсутствии доступа к хостингу или CMS',
        'как помечать места, требующие решения владельца',
      ],
    },
    researchTemplates: [
      'prompt engineering website generation landing page structure sections',
      'LLM prompt for building responsive website html css best practices',
      'website prompt specification navigation seo accessibility conversion',
    ],
    risks: [
      'не задан тип сайта: лендинг или многостраничный',
      'не выбран конструктор или стек',
      'нет структуры страниц и мобильной версии',
    ],
  },
  {
    id: 'financial_analyst',
    label: 'Финансовый аналитик',
    criticalSections: ['role', 'context', 'objective', 'methodology', 'tools', 'constraints', 'output_format', 'quality_criteria', 'error_handling'],
    probes: {
      ...COMMON,
      methodology: ['методология расчёта', 'допущения модели', 'работа с неопределённостью'],
      tools: ['источники данных', 'периодичность', 'валюты и единицы'],
      constraints: ['не является инвестиционной рекомендацией', 'запрет на выдуманные цифры', 'требования регуляторов'],
      quality_criteria: ['воспроизводимость расчёта', 'явные допущения', 'проверяемость источников'],
    },
    researchTemplates: [
      'prompt engineering for financial analysis assistant methodology assumptions',
      'LLM system prompt financial analyst data sources verification',
      'best practices financial modeling prompt structure uncertainty',
    ],
    risks: ['выдуманные показатели', 'отсутствие допущений', 'нет разделения факта и оценки'],
  },
  {
    id: 'research_agent',
    label: 'Исследовательский агент',
    criticalSections: ['role', 'context', 'objective', 'methodology', 'tools', 'output_format', 'quality_criteria', 'error_handling'],
    probes: {
      ...COMMON,
      methodology: ['стратегия поиска', 'оценка достоверности источников', 'проверка фактов', 'работа с противоречиями'],
      tools: ['доступные поисковые инструменты', 'лимиты', 'языки источников'],
      output_format: ['формат цитирования', 'структура отчёта', 'уровень детализации'],
      error_handling: ['что делать при отсутствии источников', 'как помечать непроверенное'],
    },
    researchTemplates: [
      'prompt engineering research agent source evaluation fact checking',
      'LLM research workflow citation discipline system prompt',
      'multi source synthesis prompt best practices contradictions',
    ],
    risks: ['нет правил цитирования', 'источники не различаются по качеству', 'нет обработки противоречий'],
  },
  {
    id: 'marketing_expert',
    label: 'Маркетинговый эксперт',
    criticalSections: ['role', 'context', 'objective', 'methodology', 'output_format', 'constraints', 'quality_criteria'],
    probes: {
      ...COMMON,
      context: ['продукт', 'сегмент', 'конкуренты', 'каналы'],
      objective: ['метрика успеха', 'воронка', 'сроки'],
      methodology: ['структура сообщения', 'работа с возражениями', 'A/B-гипотезы'],
      constraints: ['запрещённые обещания', 'юридические ограничения', 'тон бренда'],
    },
    researchTemplates: [
      'prompt engineering marketing copy assistant brand voice structure',
      'LLM prompt for campaign messaging value proposition best practices',
      'marketing prompt constraints claims compliance',
    ],
    risks: ['нет метрики успеха', 'не задан тон бренда', 'обещания без доказательств'],
  },
  {
    id: 'image_generator',
    label: 'Генератор изображений',
    criticalSections: ['role', 'context', 'objective', 'output_format', 'constraints'],
    probes: {
      ...COMMON,
      objective: ['сюжет', 'настроение', 'назначение изображения'],
      output_format: ['субъект', 'стиль', 'композиция', 'освещение', 'материалы', 'технические параметры', 'соотношение сторон'],
      constraints: ['запрещённые элементы', 'авторские права', 'политика контента'],
    },
    researchTemplates: [
      'prompt engineering image generation composition lighting materials structure',
      'best practices text to image prompt descriptors style',
      'image prompt negative prompts technical parameters aspect ratio',
    ],
    risks: ['нет технических параметров', 'стиль описан субъективно', 'нет негативных ограничений'],
  },
  {
    id: 'business_consultant',
    label: 'Бизнес-консультант',
    criticalSections: ['role', 'context', 'objective', 'methodology', 'output_format', 'quality_criteria', 'error_handling'],
    probes: {
      ...COMMON,
      context: ['отрасль', 'масштаб бизнеса', 'стадия', 'ограничения ресурсов'],
      objective: ['тип решения', 'горизонт планирования', 'кто принимает решение'],
      methodology: ['структура анализа', 'фреймворки', 'работа с недостающими данными'],
      output_format: ['формат рекомендаций', 'уровень детализации', 'наличие плана действий'],
    },
    researchTemplates: [
      'prompt engineering business consultant structured recommendations framework',
      'LLM prompt consulting analysis assumptions recommendations format',
      'business advisory prompt best practices decision support',
    ],
    risks: ['общие советы без привязки к контексту', 'нет плана действий', 'не отделены факты от гипотез'],
  },
  {
    id: 'generic',
    label: 'Универсальная задача',
    criticalSections: ['role', 'context', 'objective', 'output_format', 'constraints', 'quality_criteria'],
    probes: {
      ...COMMON,
      methodology: ['подход к решению', 'как проверяется результат'],
      quality_criteria: ['признаки хорошего результата', 'чего избегать'],
      error_handling: ['поведение при недостатке данных'],
    },
    researchTemplates: [
      'prompt engineering best practices structure role context objective output format',
      'system prompt design guide constraints quality criteria',
      'professional prompt structure methodology workflow',
    ],
    risks: ['нет критериев качества', 'не определён формат результата', 'размытая цель'],
  },
];

const KEYWORDS: Array<{ id: ArchetypeId; words: string[] }> = [
  {
    id: 'site_builder',
    words: ['сайт', 'лендинг', 'landing', 'многостраничн', 'одностраничн', 'интернет-магазин', 'каталог', 'tilda', 'тильда', 'wordpress', 'вёрстк', 'верстк', 'веб-сайт', 'website', 'web-сайт', 'разработка сайта'],
  },
  {
    id: 'ai_programmer',
    words: ['код', 'программ', 'разработ', 'python', 'javascript', 'typescript', 'backend', 'frontend', 'api', 'рефактор', 'баг', 'тест', 'архитектур', 'developer', 'code', 'debug'],
  },
  {
    id: 'financial_analyst',
    words: ['финанс', 'инвест', 'акци', 'отчётност', 'бюджет', 'выручк', 'маржа', 'dcf', 'оценк', 'audit', 'p&l', 'cfo', 'финмодел'],
  },
  {
    id: 'research_agent',
    words: ['исследован', 'поиск', 'источник', 'обзор', 'аналитик', 'факт', 'citation', 'research', 'literature', 'данных', 'отчёт по'],
  },
  {
    id: 'marketing_expert',
    words: ['маркет', 'реклам', 'контент', 'бренд', 'воронк', 'seo', 'smm', 'кампани', 'позиционирован', 'copywriting', 'копирайт', 'продвижен'],
  },
  {
    id: 'image_generator',
    words: ['изображен', 'картин', 'иллюстрац', 'фото', 'стил', 'midjourney', 'stable diffusion', 'dall-e', 'арт', 'визуал', 'image', 'render'],
  },
  {
    id: 'business_consultant',
    words: ['бизнес', 'стратег', 'консульт', 'процесс', 'оптимизац', 'рост', 'рынок', 'конкурент', 'management', 'kpi'],
  },
];

export function detectArchetype(idea: string): ArchetypeId {
  const text = idea.toLowerCase();
  let best: { id: ArchetypeId; score: number } = { id: 'generic', score: 0 };
  for (const entry of KEYWORDS) {
    let score = 0;
    for (const word of entry.words) {
      if (text.includes(word)) score += word.length > 5 ? 2 : 1;
    }
    if (score > best.score) best = { id: entry.id, score };
  }
  return best.score === 0 ? 'generic' : best.id;
}

export function getArchetype(id: ArchetypeId): Archetype {
  return ARCHETYPES.find((item) => item.id === id) ?? ARCHETYPES[ARCHETYPES.length - 1];
}

export function listArchetypes(): Array<Pick<Archetype, 'id' | 'label' | 'criticalSections'>> {
  return ARCHETYPES.map(({ id, label, criticalSections }) => ({ id, label, criticalSections }));
}

/** Раздел обязателен для данного архетипа. */
export function isCriticalSection(archetypeId: ArchetypeId, section: SectionKey): boolean {
  return getArchetype(archetypeId).criticalSections.includes(section);
}
