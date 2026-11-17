// app.ts — the server: one in-memory forge, four surfaces.
//
// Routing: GET /healthz (no auth), the git smart-HTTP paths
// /{owner}/{repo}.git/..., REST v3 under /api/v3, GraphQL at /api/graphql and
// MCP at /mcp. Everything except /healthz needs the bearer token from
// MAKEFUN_SHOP_TOKEN (401 without it); every reply carries a non-empty
// X-GitHub-Request-Id; a handler that throws becomes a 500, never a crash,
// so a malformed request cannot take the server down.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { sendError, sendJson } from './http.ts';
import type { Ctx } from './http.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Read a request body fully, up to MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new Error('request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!tooLarge) resolve(Buffer.concat(chunks) as Buffer);
    });
    req.on('error', reject);
  });
}

/** True when the request carries the trial's bearer token. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null) return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return match[1] !== '';
  return match[1] === expected;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const pathname = pathOf(req);
      const method = req.method ?? 'GET';
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const segments = pathname.split('/').filter((segment) => segment.length > 0);
      requestCounter += 1;
      const requestId = `req-${requestCounter.toString(16).padStart(8, '0')}`;

      // The env's boot check calls this twice: 200 {"ok":true}. No auth.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson({ forge, req, res, method, pathname, query: url.searchParams, segments, body: Buffer.alloc(0), json: undefined, jsonError: false, requestId } as Ctx, 200, { ok: true });
        return;
      }

      let body: Buffer = Buffer.alloc(0);
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
        res.end(JSON.stringify({ message: 'Request body is too large' }));
        return;
      }

      const isJsonRoute = pathname.startsWith('/api/v3') || pathname === '/api/graphql' || pathname === '/mcp';
      let json: unknown;
      let jsonError = false;
      if (isJsonRoute && body.length > 0) {
        try {
          json = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          jsonError = true;
        }
      }

      const ctx: Ctx = { forge, req, res, method, pathname, query: url.searchParams, segments, body, json, jsonError, requestId };

      try {
        // Everything but /healthz needs the bearer token.
        if (!authorized(req)) {
          sendError(ctx, 401, 'Unauthorized');
          return;
        }

        if (pathname.startsWith('/api/v3')) {
          if (jsonError) {
            sendError(ctx, 400, 'body is not valid JSON');
            return;
          }
          handleRest(ctx);
          return;
        }
        if (pathname === '/api/graphql') {
          handleGraphql(ctx);
          return;
        }
        if (pathname === '/mcp') {
          handleMcp(ctx);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack
        if (segments.length >= 3 && segments[1] !== undefined && segments[1].endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const repo = forge.getRepo(owner, repoName);
          if (repo === undefined) {
            sendError(ctx, 404, 'Not Found');
            return;
          }
          const action = segments[2] as string;
          if (action === 'info' && segments[3] === 'refs' && method === 'GET') {
            handleInfoRefs(ctx, repo);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            handleUploadPack(ctx, repo);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            handleReceivePack(ctx, repo);
            return;
          }
          sendError(ctx, 404, 'Not Found');
          return;
        }

        sendError(ctx, 404, 'Not Found');
      } catch (err) {
        process.stderr.write(`[app] handler failed for ${method} ${pathname}: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.writableEnded) {
          try {
            sendError(ctx, 500, 'Internal Server Error');
          } catch {
            // The response is already gone; nothing more to do.
          }
        }
      }
    })();
  });
}
