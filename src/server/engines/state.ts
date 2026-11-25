/**
 * Состояние проекта для передачи в LLM.
 *
 * Требование продукта: не отправлять всю историю проекта в каждый запрос.
 * Здесь собирается структурированный, ограниченный по объёму контекст:
 * идея, подтверждённые требования, краткие резюме готовых разделов,
 * находки исследования. Утверждённые требования не сокращаются первыми.
 */
import type { ProjectRecord, SectionRecord } from '../domain/types.ts';
import { clampText } from '../core/validate.ts';

export interface ContextBudget {
  maxChars: number;
}

export interface StructuredContext {
  project: string;
  requirements: string;
  sections: string;
  research: string;
  totalChars: number;
}

const DEFAULT_BUDGET: ContextBudget = { maxChars: 24000 };

/** Требования пользователя — неприкосновенны: обрезаются последними. */
export function collectRequirements(sections: SectionRecord[]): Array<{ section: string; items: string[] }> {
  return sections
    .filter((section) => section.requirements.length > 0)
    .map((section) => ({ section: section.title, items: section.requirements }));
}

export function buildStructuredContext(
  project: ProjectRecord,
  sections: SectionRecord[],
  options: Partial<ContextBudget> = {},
): StructuredContext {
  const budget = { ...DEFAULT_BUDGET, ...options };

  const projectBlock = [
    `Название: ${project.title}`,
    `Идея: ${project.idea}`,
    project.audience ? `Аудитория: ${project.audience}` : '',
    project.targetModel ? `Целевая модель: ${project.targetModel}` : '',
    `Режим: ${project.mode}`,
  ]
    .filter(Boolean)
    .join('\n');

  const requirementLines = collectRequirements(sections)
    .map((group) => `### ${group.section}\n${group.items.map((item) => `- ${item}`).join('\n')}`)
    .join('\n');

  const sectionLines = sections
    .filter((section) => section.status === 'ready' && section.summary)
    .map((section) => `- ${section.title}: ${section.summary}`)
    .join('\n');

  const researchLines = sections
    .filter((section) => section.research.status === 'done' && section.research.findings.length > 0)
    .map((section) => `### ${section.title}\n${section.research.findings.slice(0, 5).map((f) => `- ${f}`).join('\n')}`)
    .join('\n');

  // Приоритет при сокращении: требования → проект → резюме разделов → исследование.
  const fixedChars = projectBlock.length + requirementLines.length;
  const remaining = Math.max(0, budget.maxChars - fixedChars);
  const sectionBudget = Math.floor(remaining * 0.4);
  const researchBudget = remaining - sectionBudget;

  const sectionsOut = sectionLines.length > sectionBudget ? clampText(sectionLines, sectionBudget) : sectionLines;
  const researchOut = researchLines.length > researchBudget ? clampText(researchLines, researchBudget) : researchLines;

  return {
    project: projectBlock,
    requirements: requirementLines || 'нет подтверждённых требований',
    sections: sectionsOut || 'готовых разделов пока нет',
    research: researchOut || 'исследование ещё не проводилось',
    totalChars: projectBlock.length + requirementLines.length + sectionsOut.length + researchOut.length,
  };
}

/** Компактный транскрипт интервью для одного раздела. */
export function sectionTranscript(
  messages: Array<{ role: string; kind: string; content: string }>,
  maxChars = 6000,
): string {
  const filtered = messages.filter((message) => message.role !== 'system');
  const lines = filtered.map((message) => {
    const label = message.role === 'user' ? 'Пользователь' : message.kind === 'question' ? 'Вопрос' : 'Ассистент';
    return `${label}: ${clampText(message.content, 1200)}`;
  });
  const text = lines.join('\n\n');
  return text.length > maxChars ? clampText(text, maxChars) : text;
}

/** Проверяет, что раздел не противоречит уже готовым разделам (для QA). */
export function readySectionSummaries(sections: SectionRecord[], excludeKey: string): string {
  const lines = sections
    .filter((section) => section.key !== excludeKey && section.status === 'ready' && section.summary)
    .map((section) => `- ${section.title}: ${section.summary}`);
  return lines.join('\n');
}
