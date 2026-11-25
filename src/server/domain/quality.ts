/**
 * Quality Assurance: оценки разделов.
 *
 * Модель выставляет баллы, но код всё равно:
 *  - нормализует веса (сумма = 1);
 *  - пересчитывает итог сам, а не доверяет полю total от модели;
 *  - отдельно проверяет обязательные условия, которые нельзя компенсировать баллами;
 *  - умеет выдать эвристическую оценку, если LLM недоступна.
 */
import type { QualityCriterionScore, QualityReport } from './types.ts';

export const QUALITY_CRITERIA: Array<{ key: string; label: string; weight: number }> = [
  { key: 'fit', label: 'Соответствие задаче', weight: 0.2 },
  { key: 'completeness', label: 'Полнота', weight: 0.15 },
  { key: 'clarity', label: 'Однозначность формулировок', weight: 0.15 },
  { key: 'applicability', label: 'Практическая применимость', weight: 0.15 },
  { key: 'coherence', label: 'Логическая согласованность', weight: 0.15 },
  { key: 'professionalism', label: 'Профессиональное качество', weight: 0.1 },
  { key: 'consistency', label: 'Отсутствие противоречий', weight: 0.1 },
];

export const MANDATORY_CHECKS: Array<{ key: string; label: string }> = [
  { key: 'requirements', label: 'Учтены требования пользователя' },
  { key: 'no_conflicts', label: 'Нет противоречий с другими разделами' },
  { key: 'applicable_format', label: 'Формат результата применим на практике' },
  { key: 'feasible', label: 'Нет инструкций, невыполнимых для целевой модели' },
];

const clamp = (value: number, min = 0, max = 100): number => Math.min(max, Math.max(min, Math.round(value)));

export interface RawQualityReport {
  criteria?: Array<{ key?: string; label?: string; weight?: number; score?: number; note?: string }>;
  mandatory?: Array<{ key?: string; label?: string; passed?: boolean; note?: string }>;
  issues?: string[];
  verdict?: string;
  suggestion?: string;
}

/** Приводит ответ модели к нормализованному отчёту. */
export function normalizeQuality(raw: RawQualityReport): QualityReport {
  const byKey = new Map((raw.criteria ?? []).map((item) => [String(item.key ?? ''), item]));

  const criteria: QualityCriterionScore[] = QUALITY_CRITERIA.map((definition) => {
    const found = byKey.get(definition.key);
    const score = clamp(Number(found?.score ?? 0));
    return {
      key: definition.key,
      label: definition.label,
      weight: definition.weight,
      score,
      note: String(found?.note ?? '').slice(0, 400),
    };
  });

  const providedWeight = (raw.criteria ?? []).reduce((acc, item) => acc + (Number(item.weight) || 0), 0);
  const weightSum = criteria.reduce((acc, item) => acc + item.weight, 0);
  const total = clamp(
    criteria.reduce((acc, item) => acc + item.score * item.weight, 0) / (weightSum || 1) ||
      (providedWeight > 0 ? 0 : 0),
  );

  const mandatoryByKey = new Map((raw.mandatory ?? []).map((item) => [String(item.key ?? ''), item]));
  const mandatory = MANDATORY_CHECKS.map((check) => {
    const found = mandatoryByKey.get(check.key);
    // Отсутствие проверки в ответе модели трактуем как непройденную.
    return {
      key: check.key,
      label: check.label,
      passed: found ? found.passed === true : false,
      note: String(found?.note ?? (found ? '' : 'модель не подтвердила выполнение')),
    };
  });

  const failedMandatory = mandatory.filter((item) => !item.passed).length;
  const reportedVerdict = raw.verdict === 'pass' ? 'pass' : 'revise';
  const verdict: QualityReport['verdict'] =
    failedMandatory > 0 || reportedVerdict === 'revise' ? 'revise' : 'pass';

  return {
    total,
    criteria,
    mandatory,
    issues: (raw.issues ?? []).filter((item): item is string => typeof item === 'string').slice(0, 20),
    verdict,
    evaluatedAt: new Date().toISOString(),
    heuristic: false,
  };
}

/**
 * Эвристическая оценка без LLM: используется, когда модель недоступна, и
 * всегда помечается heuristic: true. Не выдаёт себя за оценку модели.
 */
export function heuristicQuality(content: string, requirements: string[] = []): QualityReport {
  const text = content.trim();
  const length = text.length;
  const hasStructure = /(^|\n)[-*0-9]/.test(text) || /\n\n/.test(text);
  const imperative = /\b(ты|вы|должен|не|всегда|никогда|используй|проверяй|верни|сначала)\b/i.test(text);
  const vague = (text.match(/\b(качественно|эффективно|оптимально|хорошо|правильно)\b/gi) ?? []).length;
  const placeholder = /\b(TODO|TBD|заполнить|placeholder)\b/i.test(text);

  const completeness = clamp(Math.min(100, (length / 900) * 100));
  const clarity = clamp(80 - vague * 6 - (placeholder ? 30 : 0) + (imperative ? 10 : 0));
  const applicability = clamp((imperative ? 75 : 45) + (hasStructure ? 10 : 0));
  const coherence = clamp(hasStructure ? 78 : 58);
  const professionalism = clamp(60 + (length > 400 ? 15 : 0) + (imperative ? 10 : 0));
  const consistency = clamp(placeholder ? 45 : 75);
  const fit = clamp(requirements.length === 0 ? 60 : 55 + Math.min(35, requirements.length * 7));

  const scores: Record<string, number> = {
    fit,
    completeness,
    clarity,
    applicability,
    coherence,
    professionalism,
    consistency,
  };

  const criteria = QUALITY_CRITERIA.map((definition) => ({
    key: definition.key,
    label: definition.label,
    weight: definition.weight,
    score: scores[definition.key] ?? 50,
    note: 'эвристическая оценка без модели',
  }));

  const total = clamp(criteria.reduce((acc, item) => acc + item.score * item.weight, 0));

  return {
    total,
    criteria,
    mandatory: MANDATORY_CHECKS.map((check) => ({
      key: check.key,
      label: check.label,
      passed: check.key === 'requirements' ? requirements.length > 0 : !placeholder,
      note: 'проверено эвристикой',
    })),
    issues: [
      ...(length < 300 ? ['Раздел слишком короткий для полноценной инструкции'] : []),
      ...(placeholder ? ['В тексте остались заглушки (TODO/заполнить)'] : []),
      ...(vague > 0 ? ['Есть размытые формулировки без критериев'] : []),
    ],
    verdict: total >= 72 && !placeholder ? 'pass' : 'revise',
    evaluatedAt: new Date().toISOString(),
    heuristic: true,
  };
}

/** Итоговая оценка всего промта из оценок разделов. */
export function aggregateQuality(reports: QualityReport[]): {
  total: number;
  verdict: 'pass' | 'revise';
  weakSections: string[];
  failedMandatory: number;
} {
  if (reports.length === 0) return { total: 0, verdict: 'revise', weakSections: [], failedMandatory: 0 };
  const total = clamp(reports.reduce((acc, item) => acc + item.total, 0) / reports.length);
  const failedMandatory = reports.reduce(
    (acc, item) => acc + item.mandatory.filter((check) => !check.passed).length,
    0,
  );
  const weakSections = reports.filter((item) => item.total < 60).map(() => '');
  return {
    total,
    verdict: total >= 78 && failedMandatory === 0 ? 'pass' : 'revise',
    weakSections,
    failedMandatory,
  };
}
