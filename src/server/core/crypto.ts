/**
 * Secret Manager: шифрование API-ключей провайдеров.
 *
 * Схема: AES-256-GCM, ключ выводится из мастер-ключа (scrypt).
 * Мастер-ключ берётся из APP_MASTER_KEY либо генерируется в data/master.key
 * с правами 0600. В базу попадает только шифртекст вида v1:<iv>:<tag>:<data>.
 * Расшифрованный ключ никогда не покидает сервер и не попадает в логи,
 * экспорт проекта или ответы API.
 */
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../env.ts';
import { AppError } from './errors.ts';

const SCRYPT_SALT = Buffer.from('ai-prompt-architect/secret-manager/v1', 'utf8');
const PREFIX = 'v1';

let cachedKey: Buffer | null = null;

function parseMasterKey(raw: string): Buffer | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 32) return decoded;
  } catch {
    /* ignore */
  }
  // Произвольная строка достаточной длины: детерминированно выводим ключ.
  if (value.length >= 24) return scryptSync(value, SCRYPT_SALT, 32);
  throw new AppError('INTERNAL', 'APP_MASTER_KEY слишком короткий: нужно не менее 24 символов');
}

function loadOrCreateMasterKey(): Buffer {
  const fromEnv = parseMasterKey(config.masterKey);
  if (fromEnv) return fromEnv;

  mkdirSync(config.dataDir, { recursive: true });
  const keyPath = join(config.dataDir, 'master.key');
  if (existsSync(keyPath)) {
    const stored = readFileSync(keyPath, 'utf8').trim();
    const parsed = parseMasterKey(stored);
    if (parsed) return parsed;
    throw new AppError('INTERNAL', `Файл ${keyPath} повреждён: ожидается 64 hex-символа`);
  }

  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* Windows: ACL выставляется отдельно */
  }
  return generated;
}

function derivedKey(): Buffer {
  if (!cachedKey) {
    const master = loadOrCreateMasterKey();
    cachedKey = scryptSync(master, SCRYPT_SALT, 32);
  }
  return cachedKey;
}

/** Шифрует секрет. Пустая строка остаётся пустой (провайдер без ключа). */
export function encryptSecret(plain: string): string {
  if (!plain) return '';
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', derivedKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/** Расшифровывает секрет. Бросает ошибку при повреждении или смене мастер-ключа. */
export function decryptSecret(payload: string): string {
  if (!payload) return '';
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new AppError('INTERNAL', 'Некорректный формат зашифрованного секрета');
  }
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derivedKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return plain.toString('utf8');
  } catch (error) {
    throw new AppError(
      'INTERNAL',
      'Не удалось расшифровать секрет: мастер-ключ изменён или данные повреждены',
      { cause: error },
    );
  }
}

/** Маска для показа в интерфейсе: последние 4 символа, остальное скрыто. */
export function maskSecret(plain: string | undefined): string {
  if (!plain) return '';
  if (plain.length <= 4) return '••••';
  return `••••${plain.slice(-4)}`;
}

/** Признак того, что строка уже является шифртекстом нашего формата. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${PREFIX}:`) && value.split(':').length === 4;
}

/** Сравнение секретов за постоянное время (для токена доступа). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
