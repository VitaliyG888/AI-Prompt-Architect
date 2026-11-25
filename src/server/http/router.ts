/**
 * Минималистичный роутер с параметрами пути.
 * Поддерживает :param и точное совпадение метода+шаблона.
 */
export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
  request: Request;
  url: URL;
}

export type RouteHandler = (context: RouteContext) => Promise<Response> | Response;

interface RouteEntry {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: RouteEntry[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const segment = route.segments[i];
        if (segment.startsWith(':')) {
          params[segment.slice(1)] = decodeURIComponent(parts[i]);
        } else if (segment !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }

  /** Проверяет, существует ли путь с другим методом (для 405). */
  hasPath(pathname: string): boolean {
    const parts = pathname.split('/').filter(Boolean);
    return this.routes.some(
      (route) =>
        route.segments.length === parts.length &&
        route.segments.every((segment, index) => segment.startsWith(':') || segment === parts[index]),
    );
  }
}
