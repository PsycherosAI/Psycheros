/**
 * Entity Loom — Router
 *
 * Maps incoming HTTP requests to the appropriate stage handler.
 * Only one stage can run at a time; the router enforces this.
 */

import type { Handler, RouteHandlerContext } from "./server.ts";

export interface Route {
  method: string;
  pattern: string | RegExp;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string | RegExp, handler: Handler): void {
    this.routes.push({ method, pattern, handler });
  }

  /** Register routes from a stage module */
  addRoutes(
    routes: Array<
      { method: string; pattern: string | RegExp; handler: Handler }
    >,
  ): void {
    for (const route of routes) {
      this.add(route.method, route.pattern, route.handler);
    }
  }

  match(
    method: string,
    pathname: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      if (typeof route.pattern === "string") {
        if (pathname === route.pattern) {
          return { handler: route.handler, params: {} };
        }
      } else {
        const match = pathname.match(route.pattern);
        if (match) {
          const params: Record<string, string> = {};
          for (let i = 1; i < match.length; i++) {
            params[`param${i}`] = match[i];
          }
          return { handler: route.handler, params };
        }
      }
    }
    return null;
  }

  /** Handle a request, returning null if no route matched */
  async handle(
    req: Request,
    ctx: RouteHandlerContext,
  ): Promise<Response | null> {
    const url = new URL(req.url);
    const result = this.match(req.method, url.pathname);
    if (!result) return null;
    return result.handler(req, { ...ctx, params: result.params });
  }
}
