import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import { solve } from '../api/solve.ts';
import { assertSerializable, statusFor } from '../api/serialize.ts';
import { serveStatic } from './static.ts';
import type { SolveRequest } from '../api/schema.ts';

/** Repo root, two levels up from src/http/. */
const REPO_ROOT = resolve(dirname(import.meta.filename), '..', '..');

/**
 * The whole HTTP surface: read a body, parse JSON, call the engine, write JSON.
 *
 * Deliberately thin and dependency-free. Deleting this file removes the network and
 * leaves the engine untouched; every calculation is reachable by importing `solve`
 * directly, which is also how the tests exercise it.
 */

const MAX_BODY_BYTES = 1_000_000;

const send = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
};

export const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
  const url = req.url ?? '/';

  // GET serves the browser app and the compiled engine modules. The calculation API
  // below is untouched by it; deleting this branch together with static.ts leaves a
  // pure API server.
  if (req.method === 'GET') {
    const result = await serveStatic(REPO_ROOT, url, res);
    if (result.served) return;
    send(res, 404, { error: { code: 'NOT_FOUND', message: `Nothing at ${url}.` } });
    return;
  }

  if (req.method !== 'POST' || !url.startsWith('/solve')) {
    send(res, 404, { error: { code: 'NOT_FOUND', message: 'The only endpoint is POST /solve.' } });
    return;
  }

  let request: SolveRequest;
  try {
    const body = await readBody(req);
    request = body.trim() === '' ? {} : (JSON.parse(body) as SolveRequest);
  } catch (cause) {
    send(res, 400, {
      error: {
        code: 'INVALID_REQUEST',
        message: `The request body could not be read as JSON: ${(cause as Error).message}`,
      },
    });
    return;
  }

  const result = solve(request);
  if (!result.ok) {
    send(res, statusFor(result.error.code), {
      error: {
        code: result.error.code,
        message: result.error.message,
        ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
      },
    });
    return;
  }

  try {
    assertSerializable(result.value);
  } catch (cause) {
    // A non-finite number reaching JSON would be silently rewritten to null, which is
    // indistinguishable from "not computed". That is an engine bug, not bad input.
    send(res, 500, { error: { code: 'INTERNAL', message: (cause as Error).message } });
    return;
  }

  send(res, 200, result.value);
};

export const createKineticsServer = (): Server =>
  createServer((req, res) => {
    handle(req, res).catch((cause: unknown) => {
      send(res, 500, { error: { code: 'INTERNAL', message: (cause as Error).message } });
    });
  });

const isEntryPoint = process.argv[1] !== undefined && import.meta.filename === process.argv[1];
if (isEntryPoint) {
  const port = Number(process.env.PORT ?? 3000);
  createKineticsServer().listen(port, () => {
    process.stdout.write(`Kinetics engine listening on http://localhost:${port}/solve\n`);
  });
}
