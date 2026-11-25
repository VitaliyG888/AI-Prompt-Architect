/**
 * Конфигурация сервера. Читается из переменных окружения и .env (без внешних зависимостей).
 * Секреты никогда не логируются и не отдаются в клиент.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(here, '..', '..');

function loadDotEnv(): void {
  const path = join(projectRoot, '.env');
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 4319),
  host: process.env.HOST ?? '127.0.0.1',
  dataDir: resolve(projectRoot, process.env.APP_DATA_DIR ?? './data'),
  masterKey: process.env.APP_MASTER_KEY ?? '',
  allowPrivateProviders: bool(process.env.ALLOW_PRIVATE_PROVIDERS, false),
  appToken: process.env.APP_TOKEN ?? '',
  maxContextChars: int(process.env.MAX_CONTEXT_CHARS, 24000),
  projectRoot,
  webDir: join(projectRoot, 'web'),
  version: '0.1.0',
} as const;

export const isProduction = process.env.NODE_ENV === 'production';
