// http.ts — the tiny request context and response helpers every surface shares.
//
// One rule matters here: every reply carries `application/json` (or the git
// advertisement content type) and a non-empty `X-GitHub-Request-Id`, so the
// helpers are the only way a handler answers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Forge } from './forge.ts';

export interface Ctx {
  forge: Forge;
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  query: URLSearchParams;
  segments: string[];
  /** The request body, always a Buffer (empty when there is none). */
  body: Buffer;
  /** The parsed JSON body, or undefined when the body is empty or not JSON. */
  json: unknown;
  /** True when the body was present but did not parse as JSON. */
  jsonError: boolean;
  requestId: string;
}

/** Send a JSON object with the forge's headers, plus any extra headers. */
export function sendJson(ctx: Ctx, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(value);
  const body = Buffer.from(text, 'utf8');
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    'content-length': body.length,
    ...extraHeaders,
  });
  ctx.res.end(body);
}

/** Send raw bytes with a given content type. */
export function sendBuffer(ctx: Ctx, status: number, contentType: string, body: Buffer): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': ctx.requestId,
    'content-length': body.length,
  });
  ctx.res.end(body);
}

/** Send a JSON error body `{message}`. */
export function sendError(ctx: Ctx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Read a request's JSON body; returns undefined for an empty body, throws on malformed JSON. */
export function parseJsonBody(ctx: Ctx): unknown {
  if (ctx.body.length === 0) return undefined;
  return JSON.parse(ctx.body.toString('utf8')) as unknown;
}

/** True when the value is a plain object (not an array, not null). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
