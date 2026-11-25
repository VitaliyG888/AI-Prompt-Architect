/**
 * Защита от SSRF для пользовательских Base URL (LLM-провайдеры, поиск).
 *
 * Проверяем:
 *  - только http/https;
 *  - запрет loopback, приватных, link-local, CGNAT, metadata-адресов
 *    (169.254.169.254 и аналоги), multicast, unspecified;
 *  - DNS-резолвинг и проверку всех полученных адресов (защита от rebinding);
 *  - нормализацию URL и запрет нестандартных портов по умолчанию
 *    (разрешены 80/443 и явно заданные при ALLOW_PRIVATE_PROVIDERS).
 *
 * Локальные шлюзы (Ollama, LM Studio, OmniRoute на 127.0.0.1) разрешаются
 * только при ALLOW_PRIVATE_PROVIDERS=1.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from '../env.ts';
import { AppError } from './errors.ts';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number.parseInt(part, 10), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number, string]> = [
  ['0.0.0.0', 8, 'unspecified'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link-local/metadata'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf-protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
];

function classifyIpv4(ip: string): string | null {
  for (const [base, bits, label] of PRIVATE_V4) {
    if (inCidr4(ip, base, bits)) return label;
  }
  return null;
}

function classifyIpv6(ip: string): string | null {
  const normalized = ip.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return 'loopback/unspecified';
  if (normalized.startsWith('fe80')) return 'link-local';
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return 'unique-local';
  if (normalized.startsWith('ff')) return 'multicast';
  // IPv4-mapped: ::ffff:192.168.0.1
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return classifyIpv4(mapped[1]);
  return null;
}

export interface UrlCheckResult {
  url: URL;
  hostname: string;
  addresses: string[];
}

/**
 * Проверяет URL на безопасность. Бросает AppError('BLOCKED_URL').
 * `allowPrivate` переопределяет глобальную настройку (используется только
 * для локальных тестовых серверов в тестах).
 */
export async function assertSafeUrl(rawUrl: string, allowPrivate = config.allowPrivateProviders): Promise<UrlCheckResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError('BAD_REQUEST', `Некорректный URL: ${rawUrl}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('BLOCKED_URL', `Разрешены только http/https, получено: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AppError('BLOCKED_URL', 'Учётные данные в URL запрещены — используйте API Key');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (!allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(hostname)) {
      throw new AppError('BLOCKED_URL', `Хост ${hostname} запрещён (loopback/metadata)`);
    }
    if (url.port && !['80', '443', ''].includes(url.port)) {
      throw new AppError('BLOCKED_URL', `Порт ${url.port} запрещён: разрешены только 80/443`);
    }
  }

  const addresses: string[] = [];
  const version = isIP(hostname);
  if (version) {
    addresses.push(hostname);
  } else {
    try {
      const records = await lookup(hostname, { all: true, verbatim: true });
      for (const record of records) addresses.push(record.address);
    } catch (error) {
      throw new AppError('PROVIDER_UNAVAILABLE', `Не удалось разрешить хост ${hostname}`, { cause: error });
    }
  }

  if (addresses.length === 0) {
    throw new AppError('PROVIDER_UNAVAILABLE', `Хост ${hostname} не имеет адресов`);
  }

  if (!allowPrivate) {
    for (const address of addresses) {
      const kind = isIP(address) === 6 ? classifyIpv6(address) : classifyIpv4(address);
      if (kind) {
        throw new AppError(
          'BLOCKED_URL',
          `Адрес ${address} (${kind}) заблокирован. Для локальных шлюзов включите ALLOW_PRIVATE_PROVIDERS=1`,
        );
      }
    }
  }

  return { url, hostname, addresses };
}

/** Быстрая синхронная проверка формата (без DNS) — для валидации формы. */
export function validateUrlShape(rawUrl: string): { ok: true } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, message: 'Некорректный URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: 'Требуется http или https' };
  }
  if (!url.hostname) return { ok: false, message: 'Отсутствует хост' };
  return { ok: true };
}
