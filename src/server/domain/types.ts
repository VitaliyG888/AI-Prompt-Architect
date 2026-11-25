/** Общие типы домена: проекты, разделы, статусы, качество, исследование. */

export const SECTION_KEYS = [
  'role',
  'context',
  'objective',
  'expertise',
  'methodology',
  'workflow',
  'tools',
  'constraints',
  'output_format',
  'quality_criteria',
  'error_handling',
  'specialized',
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

export const SECTION_TITLES: Record<SectionKey, string> = {
  role: 'ROLE — Роль',
  context: 'CONTEXT — Контекст',
  objective: 'OBJECTIVE — Цель',
  expertise: 'EXPERTISE — Компетенции',
  methodology: 'METHODOLOGY — Методология',
  workflow: 'WORKFLOW — Рабочий процесс',
  tools: 'TOOLS & SOURCES — Инструменты и источники',
  constraints: 'CONSTRAINTS — Ограничения',
  output_format: 'OUTPUT FORMAT — Формат результата',
  quality_criteria: 'QUALITY CRITERIA — Критерии качества',
  error_handling: 'ERROR HANDLING — Нестандартные ситуации',
  specialized: 'SPECIALIZED MODULES — Специализированные разделы',
};

/** Граф зависимостей между разделами (кто на кого влияет). */
export const SECTION_DEPENDENCIES: Record<SectionKey, SectionKey[]> = {
  role: ['expertise', 'methodology', 'workflow', 'constraints'],
  context: ['objective', 'constraints', 'output_format'],
  objective: ['workflow', 'output_format', 'quality_criteria', 'error_handling'],
  expertise: ['methodology', 'workflow', 'tools'],
  methodology: ['workflow', 'quality_criteria', 'error_handling'],
  workflow: ['output_format', 'quality_criteria', 'error_handling'],
  tools: ['workflow', 'constraints', 'error_handling'],
  constraints: ['output_format', 'error_handling'],
  output_format: ['quality_criteria'],
  quality_criteria: [],
  error_handling: [],
  specialized: ['methodology', 'workflow', 'quality_criteria'],
};

export type SectionStatus =
  | 'not_started'
  | 'awaiting_answer'
  | 'needs_clarification'
  | 'researching'
  | 'analyzing'
  | 'ready'
  | 'needs_revision';

export const SECTION_STATUS_LABELS: Record<SectionStatus, string> = {
  not_started: 'не начат',
  awaiting_answer: 'ожидает ответа',
  needs_clarification: 'требует уточнения',
  researching: 'исследование выполняется',
  analyzing: 'анализируется',
  ready: 'готов',
  needs_revision: 'требует пересмотра',
};

export type ProjectMode = 'quick' | 'professional' | 'expert';

export type ProjectStatus =
  | 'draft'
  | 'interviewing'
  | 'researching'
  | 'assembling'
  | 'testing'
  | 'complete'
  | 'error';

export type ProjectStage =
  | 'intake'
  | 'plan'
  | 'interview'
  | 'synthesis'
  | 'assembly'
  | 'review'
  | 'testing'
  | 'done';

export type ResearchStatus = 'pending' | 'running' | 'done' | 'skipped' | 'unavailable' | 'error';

export interface QualityCriterionScore {
  key: string;
  label: string;
  weight: number;
  score: number;
  note: string;
}

export interface QualityReport {
  total: number;
  criteria: QualityCriterionScore[];
  mandatory: Array<{ key: string; label: string; passed: boolean; note: string }>;
  issues: string[];
  verdict: 'pass' | 'revise' | 'pending';
  evaluatedAt: string;
  /** true — оценка выставлена эвристикой, а не моделью. */
  heuristic: boolean;
}

export interface SourceAnalysis {
  summary: string;
  strengths: string[];
  weaknesses: string[];
  applicability: 'high' | 'medium' | 'low';
  notes: string;
}

export interface SourceRecord {
  id: string;
  projectId: string;
  sectionKey: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string;
  snippet: string;
  query: string;
  provider: string;
  relevance: number | null;
  analysis: SourceAnalysis | null;
  fetchedAt: string;
}

export interface SectionResearch {
  status: ResearchStatus;
  queries: string[];
  summary: string;
  findings: string[];
  sourceIds: string[];
  providers: string[];
  message: string;
  updatedAt: string;
}

export interface SectionRecord {
  id: string;
  projectId: string;
  key: SectionKey;
  title: string;
  orderIndex: number;
  status: SectionStatus;
  content: string;
  summary: string;
  requirements: string[];
  openQuestions: string[];
  research: SectionResearch;
  quality: QualityReport | null;
  alternatives: Array<{ label: string; content: string; rationale: string }>;
  decisions: Array<{ question: string; choice: string; source: 'user' | 'ai' | 'research' }>;
  flags: string[];
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  title: string;
  idea: string;
  mode: ProjectMode;
  status: ProjectStatus;
  stage: ProjectStage;
  audience: string;
  targetModel: string;
  providerSnapshot: Record<string, unknown>;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Режимы работы: какие шаги включены. */
export interface ModePolicy {
  id: ProjectMode;
  label: string;
  description: string;
  researchPerSection: boolean;
  maxSourcesPerSection: number;
  alternatives: number;
  qualityStrict: boolean;
  testOnTargetModel: boolean;
  maxQuestionsPerSection: number;
  iterativeRounds: number;
}

export const MODE_POLICIES: Record<ProjectMode, ModePolicy> = {
  quick: {
    id: 'quick',
    label: 'Quick',
    description: 'Короткое интервью, минимум исследований, быстрый результат.',
    researchPerSection: false,
    maxSourcesPerSection: 0,
    alternatives: 1,
    qualityStrict: false,
    testOnTargetModel: false,
    maxQuestionsPerSection: 2,
    iterativeRounds: 1,
  },
  professional: {
    id: 'professional',
    label: 'Professional',
    description: 'Адаптивное интервью, исследование каждого раздела, синтез и контроль качества.',
    researchPerSection: true,
    maxSourcesPerSection: 4,
    alternatives: 2,
    qualityStrict: true,
    testOnTargetModel: false,
    maxQuestionsPerSection: 4,
    iterativeRounds: 2,
  },
  expert: {
    id: 'expert',
    label: 'Expert',
    description: 'Глубокое исследование, несколько вариантов, расширенная проверка и тестирование на целевой модели.',
    researchPerSection: true,
    maxSourcesPerSection: 6,
    alternatives: 3,
    qualityStrict: true,
    testOnTargetModel: true,
    maxQuestionsPerSection: 6,
    iterativeRounds: 3,
  },
};
