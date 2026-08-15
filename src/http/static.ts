import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Minimal static file serving for the browser app.
 *
 * The app imports the compiled engine directly as ES modules, so every calculation
 * happens in the page with no network round-trip, which is the spec's claim that the
 * engine "could run identically in the browser", exercised rather than asserted. This
 * file exists only to hand those modules to the browser; the /solve endpoint remains
 * available for programmatic callers and is what a different front end would use.
 */

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  // Browsers refuse a @font-face served as application/octet-stream.
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

/** Roots the server will read from, relative to the repo root. */
const ALLOWED_PREFIXES = ['web/', 'dist/'] as const;

export interface StaticResult {
  readonly served: boolean;
}

const isAllowed = (relative: string): boolean =>
  ALLOWED_PREFIXES.some(
    (prefix) => relative === prefix.slice(0, -1) || relative.startsWith(prefix),
  );

/** Where the app lives. Requests for the site root are redirected here. */
export const APP_ENTRY = '/web/index.html';

const ROOT_PATHS = new Set(['/', '/web', '/web/']);

export const isRootPath = (urlPath: string): boolean =>
  ROOT_PATHS.has(decodeURIComponent(urlPath.split('?')[0] ?? '/'));

/**
 * Resolves a URL path to a file inside the allowed roots.
 *
 * Returns null for anything that escapes them; `..` segments are normalized first, so
 * a traversal attempt resolves to a path that simply fails the prefix check.
 */
export const resolveStaticPath = (root: string, urlPath: string): string | null => {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const relative = normalize(decoded.replace(/^\/+/, ''));
  if (relative.startsWith('..') || !isAllowed(relative)) return null;
  return join(root, relative);
};

export const serveStatic = async (
  root: string,
  urlPath: string,
  res: ServerResponse,
): Promise<StaticResult> => {
  // The page is served from /web/ rather than the site root so that its own relative
  // imports (./charts.js and ../dist/api/solve.js) resolve the same way in the browser
  // as they do on disk. Served at "/", `./app.js` would resolve to /app.js and 404.
  if (isRootPath(urlPath)) {
    res.writeHead(302, { location: APP_ENTRY });
    res.end();
    return { served: true };
  }

  const filePath = resolveStaticPath(root, urlPath);
  if (filePath === null) return { served: false };

  try {
    const info = await stat(filePath);
    if (!info.isFile()) return { served: false };
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      // The engine is rebuilt often during development; a stale module would silently
      // serve yesterday's mathematics.
      'cache-control': 'no-cache',
    });
    res.end(body);
    return { served: true };
  } catch {
    return { served: false };
  }
};
