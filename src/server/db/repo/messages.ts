/** Репозиторий сообщений диалога (интервью и служебные события). */
import type { DatabaseSync } from 'node:sqlite';
import { newId, nowIso } from '../../core/ids.ts';
import { allRows, getRow, parseJson, run, str, num } from '../rows.ts';

export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageKind = 'chat' | 'question' | 'answer' | 'event' | 'note';

export interface MessageRecord {
  id: string;
  projectId: string;
  sectionKey: string;
  role: MessageRole;
  kind: MessageKind;
  content: string;
  meta: Record<string, unknown>;
  createdAt: string;
}

function toMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: str(row, 'id'),
    projectId: str(row, 'project_id'),
    sectionKey: str(row, 'section_key'),
    role: str(row, 'role', 'assistant') as MessageRole,
    kind: str(row, 'kind', 'chat') as MessageKind,
    content: str(row, 'content'),
    meta: parseJson(row.meta, {}),
    createdAt: str(row, 'created_at'),
  };
}

export class MessageRepository {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  add(input: {
    projectId: string;
    sectionKey?: string;
    role: MessageRole;
    kind?: MessageKind;
    content: string;
    meta?: Record<string, unknown>;
  }): MessageRecord {
    const id = newId('msg');
    const createdAt = nowIso();
    run(
      this.db,
      `INSERT INTO messages (id, project_id, section_key, role, kind, content, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.sectionKey ?? '',
      input.role,
      input.kind ?? 'chat',
      input.content,
      JSON.stringify(input.meta ?? {}),
      createdAt,
    );
    return this.get(id);
  }

  get(id: string): MessageRecord {
    const row = getRow(this.db, 'SELECT * FROM messages WHERE id = ?', id);
    if (!row) throw new Error('Сообщение не найдено');
    return toMessage(row);
  }

  list(projectId: string, sectionKey?: string, limit = 200): MessageRecord[] {
    const rows = sectionKey
      ? allRows(
          this.db,
          'SELECT * FROM messages WHERE project_id = ? AND section_key = ? ORDER BY created_at ASC LIMIT ?',
          projectId,
          sectionKey,
          limit,
        )
      : allRows(
          this.db,
          'SELECT * FROM messages WHERE project_id = ? ORDER BY created_at ASC LIMIT ?',
          projectId,
          limit,
        );
    return rows.map(toMessage);
  }

  lastQuestion(projectId: string, sectionKey: string): MessageRecord | null {
    const row = getRow(
      this.db,
      `SELECT * FROM messages WHERE project_id = ? AND section_key = ? AND kind = 'question'
        ORDER BY created_at DESC LIMIT 1`,
      projectId,
      sectionKey,
    );
    return row ? toMessage(row) : null;
  }

  /**
   * Вопросы раздела, на которые ещё нет ответа.
   *
   * Ответ связывается с вопросом через meta.questionId. Если идентификатор не
   * передан (старые записи), ответ считается относящимся к последнему вопросу —
   * поэтому открытым остаётся только он. Интерфейс показывает ровно один
   * открытый вопрос: так опрос идёт линейно.
   */
  pendingQuestions(projectId: string, sectionKey: string): MessageRecord[] {
    const all = this.list(projectId, sectionKey, 400);
    const open: MessageRecord[] = [];
    for (const message of all) {
      if (message.kind === 'question') {
        open.push(message);
        continue;
      }
      if (message.kind !== 'answer') continue;

      const questionId = String((message.meta as Record<string, unknown>).questionId ?? '');
      if (questionId) {
        const index = open.findIndex(
          (question) => String((question.meta as Record<string, unknown>).id ?? '') === questionId,
        );
        if (index >= 0) open.splice(index, 1);
      } else if (open.length > 0) {
        // Старая запись без привязки: ответ закрывает старейший открытый вопрос.
        open.shift();
      }
    }
    return open;
  }

  count(projectId: string): number {
    const row = getRow(this.db, 'SELECT COUNT(*) AS c FROM messages WHERE project_id = ?', projectId);
    return num(row as Record<string, unknown>, 'c');
  }
}
