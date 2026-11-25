/**
 * Экспорт результата: Markdown, TXT, JSON.
 *
 * В экспорт никогда не попадают API-ключи, custom headers и служебные
 * метаданные провайдеров. JSON-экспорт — самодостаточный документ с
 * разделами, источниками, оценками и историей версий.
 */
import type { ProjectRecord, SectionRecord, SourceRecord } from '../domain/types.ts';
import type { VersionRecord } from '../db/repo/versions.ts';

export interface ExportBundle {
  project: ProjectRecord;
  sections: SectionRecord[];
  sources: SourceRecord[];
  versions: VersionRecord[];
  prompt: string;
}

const BOM = '\uFEFF';

export function exportMarkdown(bundle: ExportBundle): string {
  const { project, sections, sources, prompt } = bundle;
  const latestMeta = (bundle.versions[0]?.meta ?? {}) as Record<string, unknown>;
  const quality = bundle.versions[0]?.quality;

  const lines: string[] = [];
  lines.push(`# ${project.title}`);
  lines.push('');
  lines.push(`> **Назначение:** ${String(latestMeta.purpose ?? project.idea)}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(prompt.trim());
  lines.push('');
  lines.push('---');
  lines.push('');

  if (Array.isArray(latestMeta.usage) && latestMeta.usage.length) {
    lines.push('## Как применять');
    lines.push('');
    for (const item of latestMeta.usage as string[]) lines.push(`- ${item}`);
    lines.push('');
  }

  if (quality) {
    lines.push('## Оценка качества');
    lines.push('');
    lines.push(`- Итоговый балл: **${quality.total}/100**`);
    lines.push(`- Вердикт: ${quality.verdict === 'pass' ? 'пройдено' : 'требует доработки'}`);
    if (quality.criteria.length) {
      lines.push('');
      lines.push('| Критерий | Вес | Балл | Комментарий |');
      lines.push('|---|---|---|---|');
      for (const criterion of quality.criteria) {
        lines.push(
          `| ${criterion.label} | ${Math.round(criterion.weight * 100)}% | ${criterion.score} | ${criterion.note ?? ''} |`,
        );
      }
    }
    lines.push('');
  }

  if (Array.isArray(latestMeta.assumptions) && latestMeta.assumptions.length) {
    lines.push('## Допущения');
    lines.push('');
    for (const item of latestMeta.assumptions as string[]) lines.push(`- ${item}`);
    lines.push('');
  }

  if (Array.isArray(latestMeta.limitations) && latestMeta.limitations.length) {
    lines.push('## Ограничения');
    lines.push('');
    for (const item of latestMeta.limitations as string[]) lines.push(`- ${item}`);
    lines.push('');
  }

  if (sources.length) {
    lines.push('## Источники исследования');
    lines.push('');
    const seen = new Set<string>();
    for (const source of sources) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      lines.push(
        `- [${source.title}](${source.url})${source.publisher ? ` — ${source.publisher}` : ''}${source.publishedAt ? `, ${source.publishedAt}` : ''}`,
      );
    }
    lines.push('');
  }

  if (Array.isArray(latestMeta.improvements) && latestMeta.improvements.length) {
    lines.push('## Рекомендации по улучшению');
    lines.push('');
    for (const item of latestMeta.improvements as string[]) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## Структура разделов');
  lines.push('');
  for (const section of sections) {
    lines.push(`### ${section.title}`);
    lines.push('');
    lines.push(`Статус: ${section.status}${section.quality ? ` · оценка ${section.quality.total}/100` : ''}`);
    lines.push('');
    lines.push(section.content.trim() || '_раздел не заполнен_');
    lines.push('');
  }

  return BOM + lines.join('\n');
}

export function exportText(bundle: ExportBundle): string {
  const { project, sections, prompt } = bundle;
  const lines: string[] = [];
  lines.push(project.title.toUpperCase());
  lines.push('='.repeat(Math.min(80, project.title.length)));
  lines.push('');
  lines.push(prompt.trim());
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('РАЗДЕЛЫ');
  lines.push('-'.repeat(60));
  for (const section of sections) {
    lines.push('');
    lines.push(section.title);
    lines.push('');
    lines.push(stripMarkdown(section.content.trim()) || '(не заполнен)');
  }
  return lines.join('\n');
}

export function exportJson(bundle: ExportBundle): string {
  const { project, sections, sources, versions, prompt } = bundle;
  const payload = {
    format: 'ai-prompt-architect/v1',
    exportedAt: new Date().toISOString(),
    project: {
      id: project.id,
      title: project.title,
      idea: project.idea,
      mode: project.mode,
      audience: project.audience,
      targetModel: project.targetModel,
      status: project.status,
      stage: project.stage,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      // ВАЖНО: providerSnapshot хранит только имена/модели, не ключи.
      providerSnapshot: project.providerSnapshot,
    },
    prompt,
    sections: sections.map((section) => ({
      key: section.key,
      title: section.title,
      status: section.status,
      content: section.content,
      summary: section.summary,
      requirements: section.requirements,
      openQuestions: section.openQuestions,
      research: {
        status: section.research.status,
        queries: section.research.queries,
        findings: section.research.findings,
        providers: section.research.providers,
      },
      quality: section.quality,
      alternatives: section.alternatives,
      decisions: section.decisions,
    })),
    sources: sources.map((source) => ({
      title: source.title,
      url: source.url,
      publisher: source.publisher,
      publishedAt: source.publishedAt,
      relevance: source.relevance,
      analysis: source.analysis,
    })),
    versions: versions.map((version) => ({
      id: version.id,
      label: version.label,
      prompt: version.prompt,
      quality: version.quality,
      meta: version.meta,
      createdAt: version.createdAt,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)');
}

/** Простой построчный diff для сравнения версий. */
export interface DiffLine {
  type: 'added' | 'removed' | 'same';
  text: string;
  aLine?: number;
  bLine?: number;
}

export function diffVersions(a: string, b: string): { lines: DiffLine[]; added: number; removed: number } {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  // LCS через динамическое программирование; объём версий ограничен.
  const n = aLines.length;
  const m = bLines.length;
  if (n * m > 4_000_000) {
    return {
      lines: [
        ...aLines.map((text, index) => ({ type: 'removed' as const, text, aLine: index + 1 })),
        ...bLines.map((text, index) => ({ type: 'added' as const, text, bLine: index + 1 })),
      ],
      added: m,
      removed: n,
    };
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aLines[i] === bLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      lines.push({ type: 'same', text: aLines[i], aLine: i + 1, bLine: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'removed', text: aLines[i], aLine: i + 1 });
      removed++;
      i++;
    } else {
      lines.push({ type: 'added', text: bLines[j], bLine: j + 1 });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ type: 'removed', text: aLines[i], aLine: i + 1 });
    removed++;
    i++;
  }
  while (j < m) {
    lines.push({ type: 'added', text: bLines[j], bLine: j + 1 });
    added++;
    j++;
  }

  return { lines, added, removed };
}
