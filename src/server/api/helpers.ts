/** Общие помощники API: доступ к проекту, авторизация, разбор параметров. */
import type { AppContainer } from '../app.ts';
import type { ProjectRecord, SectionKey } from '../domain/types.ts';
import { SECTION_TITLES } from '../domain/types.ts';
import { AppError } from '../core/errors.ts';
import { config } from '../env.ts';
import { safeEqual } from '../core/crypto.ts';

export interface ApiDeps {
  app: AppContainer;
}

export function requireProject(app: AppContainer, id: string): ProjectRecord {
  const project = app.projects.find(id);
  if (!project) throw new AppError('NOT_FOUND', 'Проект не найден');
  return project;
}

export function requireSectionKey(raw: string): SectionKey {
  if (!(raw in SECTION_TITLES)) {
    throw new AppError('NOT_FOUND', `Неизвестный раздел: ${raw}`);
  }
  return raw as SectionKey;
}

/**
 * Неизвестная операция в пути — это отсутствующий ресурс (404), а не ошибка
 * формата поля: так же ведёт себя requireSectionKey для разделов.
 */
export function requireOperation<T extends string>(raw: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new AppError('NOT_FOUND', `Неизвестная операция: ${raw}`);
  }
  return raw as T;
}

/**
 * Токен доступа применяется только если он задан в окружении. Это позволяет
 * открывать приложение не только с localhost, не ослабляя локальный запуск.
 */
export function assertAuthorized(request: Request): void {
  if (!config.appToken) return;
  const header = request.headers.get('x-app-token') ?? '';
  const bearer = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const provided = header || bearer;
  if (!provided || !safeEqual(provided, config.appToken)) {
    throw new AppError('UNAUTHORIZED', 'Требуется токен доступа');
  }
}
