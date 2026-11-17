// mcp.ts — the MCP surface at POST /mcp: JSON-RPC 2.0 Streamable HTTP.
//
// Both eras: the modern 2026-07-28 revision (server/discover, no handshake, no
// session) and the legacy 2025-11-25 handshake (initialize +
// notifications/initialized). The tools act on the same forge as REST, so a
// repo created here reads back identically over REST and GraphQL.

import { VIEWER } from './scenario.ts';
import type { Forge, Repo } from './forge.ts';
import { isRecord, sendJson } from './http.ts';
import type { Ctx } from './http.ts';
import { issueView, pullView, repoView } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2024-11-05'];
const CURRENT_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
    additionalProperties: boolean;
  };
}

/** The tool catalogue, frozen so two tools/list calls are byte-identical. */
const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_pull_request',
    description: 'Get one pull request in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function toolByName(name: string): ToolDef | undefined {
  const wanted = name.toLowerCase();
  return TOOLS.find((tool) => tool.name === wanted || tool.name.toLowerCase().endsWith(wanted) || wanted.endsWith(tool.name));
}

function findRepo(forge: Forge, owner: unknown, repo: unknown): Repo | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  return forge.getRepo(owner, repo) ?? null;
}

interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent: unknown;
  isError?: boolean;
}

function toolOk(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function missingArg(name: string): ToolResult {
  return toolError(`missing required argument: ${name}`);
}

/** Run one tools/call and return its result payload. */
function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): ToolResult {
  const forge = ctx.forge;
  const tool = toolByName(name);
  if (tool === undefined) return toolError(`unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') return missingArg(required);
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (forge.getRepo(VIEWER.login, repoName) !== undefined) return toolError(`repository already exists: ${repoName}`);
      const created = forge.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      if ('error' in created) return toolError(`repository already exists: ${repoName}`);
      return toolOk(repoView(ctx, created.repo));
    }
    case 'get_repo': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      return toolOk(repoView(ctx, repo));
    }
    case 'create_issue': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const issue = forge.createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolOk(issueView(ctx, repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = forge.listIssues(repo, { state, sort: 'created', direction: 'asc' });
      return toolOk(issues.map((issue) => issueView(ctx, repo, issue)));
    }
    case 'get_issue': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const issue = forge.getIssue(repo, Number(args.issue_number));
      if (issue === undefined) return toolError(`issue not found: ${String(args.issue_number)}`);
      return toolOk(issueView(ctx, repo, issue));
    }
    case 'create_pull_request': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const created = forge.createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in created) return toolError(`head or base does not exist: ${created.error}`);
      return toolOk(pullView(ctx, repo, created));
    }
    case 'list_pull_requests': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const pulls = forge.listPulls(repo, state === 'all' ? undefined : state);
      return toolOk(pulls.map((pull) => pullView(ctx, repo, pull)));
    }
    case 'get_pull_request': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const pull = forge.getPull(repo, Number(args.pull_number));
      if (pull === undefined) return toolError(`pull request not found: ${String(args.pull_number)}`);
      return toolOk(pullView(ctx, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(forge, args.owner, args.repo);
      if (repo === null) return toolError(`repository not found: ${String(args.owner)}/${String(args.repo)}`);
      const pull = forge.getPull(repo, Number(args.pull_number));
      if (pull === undefined) return toolError(`pull request not found: ${String(args.pull_number)}`);
      if (pull.merged) return toolError('pull request is already merged');
      if (pull.state === 'closed') return toolError('pull request is closed');
      const merged = forge.mergePull(repo, pull, 'squash');
      if ('conflict' in merged) return toolError('merge conflict');
      const view = pullView(ctx, repo, pull) as Record<string, unknown>;
      return toolOk({ ...view, merged: true, sha: merged.sha, message: merged.message });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Handle one JSON-RPC request object; returns null for a notification (no reply). */
function handleRpc(ctx: Ctx, request: JsonRpcRequest, protocolVersion: string): Record<string, unknown> | null {
  const id = request.id;
  const isNotification = id === undefined;
  if (typeof request.method !== 'string') {
    if (isNotification) return null;
    return rpcError(id, -32600, 'Invalid Request: method is required');
  }
  const method = request.method;
  const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    if (isNotification) return null;
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method === 'initialize') {
    if (isNotification) return null;
    const requested = typeof params.protocolVersion === 'string' ? (params.protocolVersion as string) : CURRENT_VERSION;
    const version = SUPPORTED_VERSIONS.includes(requested) ? requested : CURRENT_VERSION;
    return rpcResult(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }
  if (method === 'ping') {
    if (isNotification) return null;
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    if (isNotification) return null;
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (isNotification) return null;
    const name = params.name;
    if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'Invalid params: tool name is required');
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = toolByName(name);
    if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const result = callTool(ctx, name, args);
    return rpcResult(id, result);
  }
  if (method === 'resources/list') {
    if (isNotification) return null;
    return rpcResult(id, { resources: [] });
  }
  if (method === 'prompts/list') {
    if (isNotification) return null;
    return rpcResult(id, { prompts: [] });
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** POST /mcp. */
export function handleMcp(ctx: Ctx): void {
  if (ctx.method !== 'POST') {
    ctx.res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': ctx.requestId });
    ctx.res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }
  const protocolVersion =
    typeof ctx.req.headers['mcp-protocol-version'] === 'string'
      ? (ctx.req.headers['mcp-protocol-version'] as string)
      : CURRENT_VERSION;
  const extraHeaders: Record<string, string> = { 'mcp-protocol-version': protocolVersion };

  if (ctx.jsonError) {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: body is not valid JSON' } }, extraHeaders);
  }
  if (Array.isArray(ctx.json)) {
    const replies: Record<string, unknown>[] = [];
    for (const entry of ctx.json) {
      if (!isRecord(entry)) {
        replies.push(rpcError(null, -32600, 'Invalid Request'));
        continue;
      }
      const reply = handleRpc(ctx, entry as JsonRpcRequest, protocolVersion);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) {
      ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId, ...extraHeaders });
      ctx.res.end();
      return;
    }
    return sendJson(ctx, 200, replies, extraHeaders);
  }
  if (!isRecord(ctx.json)) {
    return sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: expected a JSON-RPC object' } }, extraHeaders);
  }
  const reply = handleRpc(ctx, ctx.json as JsonRpcRequest, protocolVersion);
  if (reply === null) {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId, ...extraHeaders });
    ctx.res.end();
    return;
  }
  return sendJson(ctx, 200, reply, extraHeaders);
}
