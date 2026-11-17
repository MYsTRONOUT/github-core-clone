// rest.ts — the REST v3 surface under /api/v3.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id; errors are
// `{message}`; a repo under another owner is 404, never 403; the default list
// state for issues and pulls is open only. Pagination follows GitHub's
// `Link: <url>; rel="next"` on the entry's own origin.

import { isoOf, nextTimestamp, VIEWER } from './scenario.ts';
import { SCENARIO_EPOCH_SEC } from './scenario.ts';
import type { Forge, Issue, IssueComment, Label, PullRequest, Repo } from './forge.ts';
import { parseTree } from './gitcore.ts';
import { isRecord, sendError, sendJson } from './http.ts';
import type { Ctx } from './http.ts';

const OAUTH_SCOPES = 'repo, read:org';

function originOf(ctx: Ctx): string {
  const host = ctx.req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function repoUrl(ctx: Ctx, repo: Repo): string {
  return `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}`;
}

export function repoView(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const url = repoUrl(ctx, repo);
  return {
    id: repo.id,
    node_id: '',
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User', html_url: `${originOf(ctx)}/${repo.owner}` },
    private: repo.isPrivate,
    html_url: url,
    description: repo.description,
    fork: false,
    url,
    created_at: isoOf(SCENARIO_EPOCH_SEC + repo.createdSeq),
    updated_at: isoOf(SCENARIO_EPOCH_SEC + repo.createdSeq),
    pushed_at: isoOf(SCENARIO_EPOCH_SEC + repo.createdSeq),
    git_url: `git://${ctx.req.headers.host ?? '127.0.0.1'}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `${originOf(ctx)}/${repo.owner}/${repo.name}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelView(label: Label): Record<string, unknown> {
  return { id: label.id, node_id: '', name: label.name, color: label.color, description: '', default: false };
}

export function issueView(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  const url = `${repoUrl(ctx, repo)}/issues/${issue.number}`;
  return {
    id: issue.id,
    node_id: '',
    url,
    repository_url: repoUrl(ctx, repo),
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: url,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label !== undefined ? labelView(label) : { id: 0, name, color: 'ededed', description: '', default: false };
    }),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: isoOf(issue.createdAt),
    updated_at: isoOf(issue.updatedAt),
    closed_at: issue.state === 'closed' ? isoOf(issue.updatedAt) : null,
    author_association: 'OWNER',
    active_lock_reason: null,
  };
}

function commentView(ctx: Ctx, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const url = `${repoUrl(ctx, repo)}/issues/${issue.number}/comments/${comment.id}`;
  return {
    id: comment.id,
    node_id: '',
    url,
    html_url: url,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(comment.createdAt),
    updated_at: isoOf(comment.createdAt),
    author_association: 'OWNER',
  };
}

export function pullView(ctx: Ctx, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const url = `${repoUrl(ctx, repo)}/pulls/${pull.number}`;
  const headSha = ctx.forge.resolveCommit(repo, pull.head) ?? pull.headSha;
  const baseSha = ctx.forge.resolveCommit(repo, pull.base) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: '',
    url,
    html_url: url,
    diff_url: `${url}.diff`,
    patch_url: `${url}.patch`,
    issue_url: `${repoUrl(ctx, repo)}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoOf(pull.createdAt),
    updated_at: isoOf(pull.createdAt),
    closed_at: pull.state === 'closed' ? isoOf(pull.mergedAt ?? pull.createdAt) : null,
    merged_at: pull.mergedAt === null ? null : isoOf(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: true,
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    merged_by: pull.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoView(ctx, repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' }, repo: repoView(ctx, repo) },
    author_association: 'OWNER',
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** Paginate a list the GitHub way; sets the Link header when a next page exists. */
function paginate<T>(ctx: Ctx, items: readonly T[]): T[] {
  const perPageRaw = Number(ctx.query.get('per_page') ?? 30);
  const perPage = Number.isFinite(perPageRaw) ? Math.max(1, Math.min(100, Math.floor(perPageRaw))) : 30;
  const pageRaw = Number(ctx.query.get('page') ?? 1);
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.floor(pageRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const nextParams = new URLSearchParams(ctx.query);
    nextParams.set('per_page', String(perPage));
    nextParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const lastParams = new URLSearchParams(ctx.query);
    lastParams.set('per_page', String(perPage));
    lastParams.set('page', String(lastPage));
    const link = `<${originOf(ctx)}${ctx.pathname}?${nextParams.toString()}>; rel="next", <${originOf(ctx)}${ctx.pathname}?${lastParams.toString()}>; rel="last"`;
    ctx.res.setHeader('link', link);
  }
  return slice;
}

/** The repo at /repos/{owner}/{name}, or null (404) when the owner is not the viewer or it is missing. */
function findRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.forge.getRepo(owner, name) ?? null;
}

function parseNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? number : null;
}

/** Handle a request under /api/v3. Always answers; unknown routes get 404 JSON. */
export function handleRest(ctx: Ctx): void {
  const segments = ctx.segments.slice(2);
  const method = ctx.method;

  // GET /api/v3/ — the root document, with the OAuth scopes header.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    return sendJson(
      ctx,
      200,
      {
        current_user_url: `${originOf(ctx)}/api/v3/user`,
        current_user_authorizations_html_url: `${originOf(ctx)}/settings/applications`,
        authorizations_url: `${originOf(ctx)}/api/v3/authorizations`,
        code_search_url: `${originOf(ctx)}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${originOf(ctx)}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${originOf(ctx)}/api/v3/user/emails`,
        emojis_url: `${originOf(ctx)}/api/v3/emojis`,
        events_url: `${originOf(ctx)}/api/v3/events`,
        feeds_url: `${originOf(ctx)}/api/v3/feeds`,
        followers_url: `${originOf(ctx)}/api/v3/user/followers`,
        following_url: `${originOf(ctx)}/api/v3/user/following{/other_user}`,
        gists_url: `${originOf(ctx)}/api/v3/gists{/gist_id}`,
        hub_url: `${originOf(ctx)}/api/v3/hub`,
        issue_search_url: `${originOf(ctx)}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${originOf(ctx)}/api/v3/issues`,
        keys_url: `${originOf(ctx)}/api/v3/user/keys`,
        label_search_url: `${originOf(ctx)}/api/v3/search/labels?repository_id={repository_id}&q={query}{&page,per_page}`,
        notifications_url: `${originOf(ctx)}/api/v3/notifications{?since,all,participating}`,
        organization_url: `${originOf(ctx)}/api/v3/orgs/{org}`,
        organization_repositories_url: `${originOf(ctx)}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${originOf(ctx)}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${originOf(ctx)}/api/v3/gists/public`,
        rate_limit_url: `${originOf(ctx)}/api/v3/rate_limit`,
        repository_url: `${originOf(ctx)}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${originOf(ctx)}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${originOf(ctx)}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${originOf(ctx)}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${originOf(ctx)}/api/v3/gists/starred`,
        topic_search_url: `${originOf(ctx)}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${originOf(ctx)}/api/v3/users/{user}`,
        user_organizations_url: `${originOf(ctx)}/api/v3/user/orgs`,
        user_repositories_url: `${originOf(ctx)}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${originOf(ctx)}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      },
      { 'x-oauth-scopes': OAUTH_SCOPES },
    );
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    return sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    return sendJson(ctx, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: '',
      avatar_url: '',
      gravatar_id: '',
      url: `${originOf(ctx)}/api/v3/users/${VIEWER.login}`,
      html_url: `${originOf(ctx)}/${VIEWER.login}`,
      type: 'User',
      site_admin: false,
      name: VIEWER.name,
      company: null,
      blog: '',
      location: null,
      email: VIEWER.email,
      hireable: null,
      bio: null,
      twitter_username: null,
      public_repos: ctx.forge.listRepos().length,
      public_gists: 0,
      followers: 0,
      following: 0,
      created_at: isoOf(SCENARIO_EPOCH_SEC),
      updated_at: isoOf(SCENARIO_EPOCH_SEC),
    });
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const page = paginate(ctx, ctx.forge.listRepos());
      return sendJson(ctx, 200, page.map((repo) => repoView(ctx, repo)));
    }
    if (method === 'POST') {
      const body = ctx.json;
      if (!isRecord(body) || typeof body.name !== 'string' || body.name.length === 0) {
        return sendError(ctx, 422, 'name is required');
      }
      const name = body.name as string;
      if (ctx.forge.getRepo(VIEWER.login, name) !== undefined) {
        return sendError(ctx, 422, 'name already exists on this account');
      }
      const created = ctx.forge.createRepo(name, {
        description: typeof body.description === 'string' ? (body.description as string) : '',
        isPrivate: body.private === true,
      });
      if ('error' in created) return sendError(ctx, 422, 'name already exists on this account');
      return sendJson(ctx, 201, repoView(ctx, created.repo));
    }
    return sendError(ctx, 405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const rest = segments.slice(3);
    const repo = findRepo(ctx, owner, name);
    if (repo === null) return sendError(ctx, 404, 'Not Found');

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') return sendJson(ctx, 200, repoView(ctx, repo));
      if (method === 'PATCH') {
        const body = ctx.json;
        if (isRecord(body)) {
          if (typeof body.description === 'string') repo.description = body.description as string;
          if (typeof body.private === 'boolean') repo.isPrivate = body.private as boolean;
          if (typeof body.default_branch === 'string' && repo.refs.has(`refs/heads/${body.default_branch as string}`)) {
            repo.defaultBranch = body.default_branch as string;
          }
        }
        return sendJson(ctx, 200, repoView(ctx, repo));
      }
      if (method === 'DELETE') {
        ctx.forge.deleteRepo(owner, name);
        ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
        ctx.res.end();
        return;
      }
      return sendError(ctx, 405, 'Method Not Allowed');
    }

    // /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches') {
      if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
      const branches = paginate(
        ctx,
        ctx.forge.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `${repoUrl(ctx, repo)}/commits/${branch.sha}` },
          protected: false,
        })),
      );
      return sendJson(ctx, 200, branches);
    }

    // /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits') {
      if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
      const ref = ctx.query.get('sha') ?? undefined;
      const commits = paginate(
        ctx,
        ctx.forge.listCommits(repo, ref).map((commit) => ({
          sha: commit.sha,
          commit: {
            message: commit.message,
            author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) },
            committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) },
          },
          author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          parents: [],
        })),
      );
      return sendJson(ctx, 200, commits);
    }

    // /repos/{o}/{r}/git/refs[/heads/{branch}]
    if (rest.length >= 2 && rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'GET') {
          const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' as const, url: `${repoUrl(ctx, repo)}/git/commits/${sha}` } }));
          return sendJson(ctx, 200, refs);
        }
        if (method === 'POST') {
          const body = ctx.json;
          if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
            return sendError(ctx, 422, 'ref and sha are required');
          }
          const ref = body.ref as string;
          const sha = body.sha as string;
          if (!ref.startsWith('refs/')) return sendError(ctx, 422, 'ref must start with refs/');
          if (repo.refs.has(ref)) return sendError(ctx, 422, 'Reference already exists');
          if (ctx.forge.resolveCommit(repo, sha) === undefined && repo.objects.get(sha)?.type !== 'commit') {
            return sendError(ctx, 422, 'Object does not exist');
          }
          const commitSha = ctx.forge.resolveCommit(repo, sha) ?? sha;
          repo.refs.set(ref, commitSha);
          return sendJson(ctx, 201, { ref, object: { sha: commitSha, type: 'commit', url: `${repoUrl(ctx, repo)}/git/commits/${commitSha}` } });
        }
        return sendError(ctx, 405, 'Method Not Allowed');
      }
      if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
        const branch = rest.slice(3).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return sendError(ctx, 404, 'Not Found');
        return sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `${repoUrl(ctx, repo)}/git/commits/${sha}` } });
      }
      return sendError(ctx, 404, 'Not Found');
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest.length >= 1 && rest[0] === 'contents') {
      const path = rest
        .slice(1)
        .map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        })
        .join('/');
      return handleContents(ctx, repo, path);
    }

    // /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
      const body = ctx.json;
      if (!isRecord(body) || typeof body.name !== 'string' || (body.name as string).length === 0) {
        return sendError(ctx, 422, 'name is required');
      }
      const labelName = body.name as string;
      if (repo.labels.has(labelName)) return sendError(ctx, 422, 'Label already exists');
      const label = ctx.forge.addLabel(repo, labelName, typeof body.color === 'string' ? (body.color as string) : 'ededed');
      return sendJson(ctx, 201, labelView(label));
    }

    // /repos/{o}/{r}/issues[/...]
    if (rest.length >= 1 && rest[0] === 'issues') {
      return handleIssues(ctx, repo, rest.slice(1));
    }

    // /repos/{o}/{r}/pulls[/...]
    if (rest.length >= 1 && rest[0] === 'pulls') {
      return handlePulls(ctx, repo, rest.slice(1));
    }
  }

  return sendError(ctx, 404, 'Not Found');
}

function handleContents(ctx: Ctx, repo: Repo, path: string): void {
  const method = ctx.method;
  const bodyBranch = isRecord(ctx.json) && typeof ctx.json.branch === 'string' ? (ctx.json.branch as string) : undefined;
  const branch = bodyBranch ?? ctx.query.get('ref') ?? repo.defaultBranch;
  const treeOid = ctx.forge.treeFor(repo, branch);

  if (method === 'GET') {
    if (treeOid === undefined) return sendError(ctx, 404, 'Not Found');
    const files = ctx.forge.flattenTree(repo, treeOid);
    if (path === '') {
      // The root directory listing.
      const entries = directoryEntries(ctx, repo, treeOid, '');
      return sendJson(ctx, 200, entries);
    }
    const file = files.get(path);
    if (file !== undefined) {
      const object = repo.objects.get(file.oid);
      const data = object !== undefined ? object.data : Buffer.alloc(0);
      return sendJson(ctx, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: file.oid,
        url: `${repoUrl(ctx, repo)}/contents/${path}`,
        git_url: `${repoUrl(ctx, repo)}/git/blobs/${file.oid}`,
        html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: null,
        _links: { git: `${repoUrl(ctx, repo)}/git/blobs/${file.oid}`, self: `${repoUrl(ctx, repo)}/contents/${path}`, html: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
      });
    }
    // A directory: every file under the prefix.
    const prefix = `${path}/`;
    const hasChildren = [...files.keys()].some((key) => key.startsWith(prefix));
    if (hasChildren) return sendJson(ctx, 200, directoryEntries(ctx, repo, treeOid, path));
    return sendError(ctx, 404, 'Not Found');
  }

  if (method === 'PUT') {
    const body = ctx.json;
    if (!isRecord(body) || typeof body.content !== 'string') return sendError(ctx, 422, 'content is required');
    const content = Buffer.from(body.content as string, 'base64');
    const message = typeof body.message === 'string' ? (body.message as string) : `Update ${path}`;
    const targetBranch = typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const currentTree = ctx.forge.treeFor(repo, targetBranch);
    const currentFiles = currentTree === undefined ? new Map() : ctx.forge.flattenTree(repo, currentTree);
    const current = currentFiles.get(path);
    if (current !== undefined && typeof body.sha === 'string' && (body.sha as string) !== current.oid) {
      return sendError(ctx, 409, 'sha does not match the current file');
    }
    const result = ctx.forge.writeFile(repo, { branch: targetBranch, path, content, message });
    return sendJson(ctx, result.created ? 201 : 200, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.contentSha,
        size: content.length,
        url: `${repoUrl(ctx, repo)}/contents/${path}`,
        html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${targetBranch}/${path}`,
        git_url: `${repoUrl(ctx, repo)}/git/blobs/${result.contentSha}`,
        download_url: null,
        type: 'file',
        encoding: 'base64',
        content: content.toString('base64'),
        _links: { git: `${repoUrl(ctx, repo)}/git/blobs/${result.contentSha}`, self: `${repoUrl(ctx, repo)}/contents/${path}`, html: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${targetBranch}/${path}` },
      },
      commit: { sha: result.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) }, committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) } },
    });
  }

  if (method === 'DELETE') {
    const body = ctx.json;
    const message = isRecord(body) && typeof body.message === 'string' ? (body.message as string) : `Delete ${path}`;
    const targetBranch = isRecord(body) && typeof body.branch === 'string' ? (body.branch as string) : repo.defaultBranch;
    const currentTree = ctx.forge.treeFor(repo, targetBranch);
    if (currentTree === undefined) return sendError(ctx, 404, 'Not Found');
    const currentFiles = ctx.forge.flattenTree(repo, currentTree);
    const current = currentFiles.get(path);
    if (current === undefined) return sendError(ctx, 404, 'Not Found');
    if (isRecord(body) && typeof body.sha === 'string' && (body.sha as string) !== current.oid) {
      return sendError(ctx, 409, 'sha does not match the current file');
    }
    const deleted = ctx.forge.deleteFile(repo, { branch: targetBranch, path, message });
    if (deleted === null) return sendError(ctx, 404, 'Not Found');
    return sendJson(ctx, 200, {
      commit: { sha: deleted.commitSha, message, author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) }, committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(SCENARIO_EPOCH_SEC) } },
    });
  }

  return sendError(ctx, 405, 'Method Not Allowed');
}

/** The entries of one directory of a tree: its direct files and subdirectories, by name. */
function directoryEntries(ctx: Ctx, repo: Repo, treeOid: string, dir: string): Record<string, unknown>[] {
  // Navigate to the subtree at `dir`.
  let oid = treeOid;
  if (dir !== '') {
    for (const part of dir.split('/')) {
      const treeObject = repo.objects.get(oid);
      if (treeObject === undefined || treeObject.type !== 'tree') return [];
      const entry = parseTree(treeObject.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (entry === undefined) return [];
      oid = entry.oid;
    }
  }
  const treeObject = repo.objects.get(oid);
  if (treeObject === undefined || treeObject.type !== 'tree') return [];
  const entries = parseTree(treeObject.data).map((entry) => {
    const entryPath = dir === '' ? entry.name : `${dir}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const size = isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0);
    return {
      type: isDir ? 'dir' : 'file',
      size,
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      url: `${repoUrl(ctx, repo)}/contents/${entryPath}`,
      git_url: `${repoUrl(ctx, repo)}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
      download_url: isDir ? null : `${originOf(ctx)}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${entryPath}`,
      _links: {
        git: `${repoUrl(ctx, repo)}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        self: `${repoUrl(ctx, repo)}/contents/${entryPath}`,
        html: `${originOf(ctx)}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
      },
    };
  });
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return entries;
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'asc';
      const issues = paginate(
        ctx,
        ctx.forge.listIssues(repo, { state, sort, direction }).map((issue) => issueView(ctx, repo, issue)),
      );
      return sendJson(ctx, 200, issues);
    }
    if (method === 'POST') {
      const body = ctx.json;
      if (!isRecord(body) || typeof body.title !== 'string' || (body.title as string).length === 0) {
        return sendError(ctx, 422, 'title is required');
      }
      const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(ctx, 422, `Label does not exist: ${label}`);
      }
      const issue = ctx.forge.createIssue(repo, {
        title: body.title as string,
        body: typeof body.body === 'string' ? (body.body as string) : '',
        labels,
      });
      return sendJson(ctx, 201, issueView(ctx, repo, issue));
    }
    return sendError(ctx, 405, 'Method Not Allowed');
  }

  const number = parseNumber(rest[0]);
  if (number === null) return sendError(ctx, 404, 'Not Found');
  const issue = ctx.forge.getIssue(repo, number);
  if (issue === undefined) return sendError(ctx, 404, 'Not Found');

  if (rest.length === 1) {
    if (method === 'GET') return sendJson(ctx, 200, issueView(ctx, repo, issue));
    if (method === 'PATCH') {
      const body = ctx.json;
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title as string;
        if (typeof body.body === 'string') issue.body = body.body as string;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels = (body.labels as unknown[]).map(String);
          for (const label of labels) {
            if (!repo.labels.has(label)) return sendError(ctx, 422, `Label does not exist: ${label}`);
          }
          issue.labels = labels;
        }
        issue.updatedAt = nextTimestamp();
      }
      return sendJson(ctx, 200, issueView(ctx, repo, issue));
    }
    return sendError(ctx, 405, 'Method Not Allowed');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      return sendJson(ctx, 200, issue.comments.map((comment) => commentView(ctx, repo, issue, comment)));
    }
    if (method === 'POST') {
      const body = ctx.json;
      if (!isRecord(body) || typeof body.body !== 'string' || (body.body as string).length === 0) {
        return sendError(ctx, 422, 'body is required');
      }
      const comment = ctx.forge.addComment(repo, issue, body.body as string);
      return sendJson(ctx, 201, commentView(ctx, repo, issue, comment));
    }
    return sendError(ctx, 405, 'Method Not Allowed');
  }

  return sendError(ctx, 404, 'Not Found');
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): void {
  const method = ctx.method;
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const pulls = paginate(
        ctx,
        ctx.forge.listPulls(repo, state === 'all' ? undefined : state).map((pull) => pullView(ctx, repo, pull)),
      );
      return sendJson(ctx, 200, pulls);
    }
    if (method === 'POST') {
      const body = ctx.json;
      if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
        return sendError(ctx, 422, 'title, head and base are required');
      }
      const created = ctx.forge.createPull(repo, {
        title: body.title as string,
        body: typeof body.body === 'string' ? (body.body as string) : '',
        head: body.head as string,
        base: body.base as string,
      });
      if ('error' in created) return sendError(ctx, 422, `head or base does not exist: ${created.error}`);
      return sendJson(ctx, 201, pullView(ctx, repo, created));
    }
    return sendError(ctx, 405, 'Method Not Allowed');
  }

  const number = parseNumber(rest[0]);
  if (number === null) return sendError(ctx, 404, 'Not Found');
  const pull = ctx.forge.getPull(repo, number);
  if (pull === undefined) return sendError(ctx, 404, 'Not Found');

  if (rest.length === 1) {
    if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    return sendJson(ctx, 200, pullView(ctx, repo, pull));
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') return sendError(ctx, 405, 'Method Not Allowed');
    const files = ctx.forge.pullFiles(repo, pull).map((file) => ({
      sha: '',
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      blob_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/blob/${pull.head}/${file.filename}`,
      raw_url: `${originOf(ctx)}/${repo.owner}/${repo.name}/raw/${pull.head}/${file.filename}`,
      contents_url: `${repoUrl(ctx, repo)}/contents/${file.filename}?ref=${pull.head}`,
    }));
    return sendJson(ctx, 200, files);
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') return sendError(ctx, 405, 'Method Not Allowed');
    if (pull.merged) return sendError(ctx, 409, 'Pull request is already merged');
    if (pull.state === 'closed') return sendError(ctx, 405, 'Pull request is closed');
    const merged = ctx.forge.mergePull(repo, pull, 'squash');
    if ('conflict' in merged) return sendError(ctx, 405, 'Merge conflict');
    return sendJson(ctx, 200, { merged: true, sha: merged.sha, message: merged.message });
  }

  return sendError(ctx, 404, 'Not Found');
}
