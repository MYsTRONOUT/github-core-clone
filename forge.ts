// forge.ts — the shared in-memory store every surface reads and writes.
//
// One store, four faces: git smart HTTP, REST v3, GraphQL and MCP all mutate the same
// repos, refs, objects, issues and pull requests, so a push, a contents edit and a
// GraphQL mutation all see the same history. Nothing here touches the wall clock:
// timestamps are logical ticks from scenario.ts, so live and replay runs agree.

import { buildCommit, buildTag, buildTree, collectReachable, hashObject, isObjectId, parseCommit, parseTag, parseTree } from './gitcore.ts';
import type { GitObject, GitObjectType, TreeEntry } from './gitcore.ts';
import { nextTimestamp, VIEWER } from './scenario.ts';

export type IssueState = 'open' | 'closed';
export type PullState = 'open' | 'closed';

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: IssueComment[];
  createdAt: number;
  updatedAt: number;
  createdSeq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  createdAt: number;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  issueSeq: number;
  pullSeq: number;
  createdSeq: number;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Opaque global ids: base64url of `Type:part:part`, never the plain number. */
export function encodeGlobalId(type: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${type}:${parts.join(':')}`, 'utf8').toString('base64url');
}

/** Decode an opaque global id back into its type and parts. */
export function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^[A-Za-z]+(:[A-Za-z0-9_.-]+)+$/.test(text)) return null;
  const [type, ...parts] = text.split(':');
  if (type === undefined || parts.length === 0) return null;
  return { type, parts };
}

const GIT_AUTHOR = `${VIEWER.name} <${VIEWER.email}>`;

export class Forge {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private objectSeq = 0;
  private creationSeq = 0;

  static repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Forge.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): { repo: Repo } | { error: 'exists' } {
    const owner = VIEWER.login;
    if (this.repos.has(Forge.repoKey(owner, name))) return { error: 'exists' };
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      issueSeq: 0,
      pullSeq: 0,
      createdSeq: this.creationSeq,
    };
    this.creationSeq += 1;
    this.repos.set(Forge.repoKey(owner, name), repo);
    return { repo };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // ------------------------------------------------------------ objects and refs

  objectId(): number {
    this.objectSeq += 1;
    return this.objectSeq;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid) => repo.objects.get(oid);
  }

  /** Resolve a branch name, a tag name, a full ref or an oid to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (repo.refs.has(ref)) return repo.refs.get(ref);
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return undefined;
  }

  /** The commit a ref points at, following an annotated tag to its target. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    const oid = this.resolveRef(repo, ref);
    if (oid === undefined) return undefined;
    const object = repo.objects.get(oid);
    if (object === undefined) return undefined;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      return target !== undefined && target.type === 'commit' ? tag.object : undefined;
    }
    return object.type === 'commit' ? oid : undefined;
  }

  headCommit(repo: Repo): string | undefined {
    return this.resolveCommit(repo, repo.defaultBranch);
  }

  /** The commit for a ref, or undefined when the repo has no commits yet. */
  commitFor(repo: Repo, ref?: string): string | undefined {
    if (ref === undefined || ref === '') return this.headCommit(repo);
    return this.resolveCommit(repo, ref);
  }

  // ------------------------------------------------------------ trees and files

  /** Flatten a tree into path -> {oid, mode}, walking directories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const files = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') files.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return files;
  }

  /** Build the nested trees for a flattened path -> oid map; returns the root tree oid. */
  buildTreeFromMap(repo: Repo, files: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const build = (paths: readonly string[], prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, string[]>();
      for (const path of paths) {
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const file = files.get(path);
          if (file !== undefined) entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          const list = dirs.get(dir) ?? [];
          list.push(path);
          dirs.set(dir, list);
        }
      }
      for (const [dir, dirPaths] of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(dirPaths, prefix === '' ? dir : `${prefix}/${dir}`) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build([...files.keys()], '');
  }

  /** The tree a ref points at, or undefined when the repo has no commits yet. */
  treeFor(repo: Repo, ref?: string): string | undefined {
    const commitOid = this.commitFor(repo, ref);
    if (commitOid === undefined) return undefined;
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return undefined;
    return parseCommit(commit.data).tree;
  }

  /** Create a commit object on top of a tree; returns its oid. */
  commitTree(
    repo: Repo,
    fields: { tree: string; parents?: readonly string[]; message: string; author?: string; committer?: string },
  ): string {
    const timestamp = nextTimestamp();
    const author = fields.author ?? GIT_AUTHOR;
    const committer = fields.committer ?? GIT_AUTHOR;
    const data = buildCommit({ tree: fields.tree, parents: fields.parents, message: fields.message, author, committer, timestamp });
    return this.putObject(repo, 'commit', data);
  }

  /** Create an annotated tag object; returns its oid. */
  createTag(repo: Repo, name: string, target: string, message: string): string {
    const timestamp = nextTimestamp();
    const targetObject = repo.objects.get(target);
    const type = targetObject !== undefined ? targetObject.type : 'commit';
    const data = buildTag({ object: target, type, tag: name, message, tagger: GIT_AUTHOR, timestamp });
    return this.putObject(repo, 'tag', data);
  }

  /** The commits reachable from a ref, newest first (parents after their children). */
  listCommits(repo: Repo, ref?: string): { sha: string; message: string; author: string }[] {
    const tip = this.commitFor(repo, ref);
    if (tip === undefined) return [];
    const out: { sha: string; message: string; author: string }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, author: commit.author });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const branches: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    return branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  // ------------------------------------------------------------ contents commits

  /** Write or replace one file, committing the result on `branch`. */
  writeFile(
    repo: Repo,
    fields: { branch: string; path: string; content: Buffer; message: string },
  ): { commitSha: string; contentSha: string; created: boolean } {
    const parentTree = this.treeFor(repo, fields.branch);
    const files = parentTree === undefined ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, parentTree);
    const created = !files.has(fields.path);
    const contentSha = this.putObject(repo, 'blob', fields.content);
    files.set(fields.path, { oid: contentSha, mode: '100644' });
    const tree = this.buildTreeFromMap(repo, files);
    const parent = this.commitFor(repo, fields.branch);
    const commitSha = this.commitTree(repo, {
      tree,
      parents: parent === undefined ? [] : [parent],
      message: fields.message,
    });
    repo.refs.set(`refs/heads/${fields.branch}`, commitSha);
    return { commitSha, contentSha, created };
  }

  /** Delete one file, committing the result on `branch`; null when the file is absent. */
  deleteFile(
    repo: Repo,
    fields: { branch: string; path: string; message: string },
  ): { commitSha: string } | null {
    const parentTree = this.treeFor(repo, fields.branch);
    if (parentTree === undefined) return null;
    const files = this.flattenTree(repo, parentTree);
    if (!files.has(fields.path)) return null;
    files.delete(fields.path);
    const tree = this.buildTreeFromMap(repo, files);
    const parent = this.commitFor(repo, fields.branch);
    const commitSha = this.commitTree(repo, {
      tree,
      parents: parent === undefined ? [] : [parent],
      message: fields.message,
    });
    repo.refs.set(`refs/heads/${fields.branch}`, commitSha);
    return { commitSha };
  }

  // ------------------------------------------------------------ labels, issues, comments

  addLabel(repo: Repo, name: string, color: string): Label {
    const label = { id: this.objectId(), name, color };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo: Repo, fields: { title: string; body?: string; labels?: string[] }): Issue {
    const timestamp = nextTimestamp();
    repo.issueSeq += 1;
    const issue: Issue = {
      id: this.objectId(),
      number: repo.issueSeq,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: fields.labels ?? [],
      comments: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      createdSeq: this.creationSeq,
    };
    this.creationSeq += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  listIssues(repo: Repo, options: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    if (options.state === 'open' || options.state === 'closed') list = list.filter((issue) => issue.state === options.state);
    const direction = options.direction === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      if (a.createdSeq !== b.createdSeq) return (a.createdSeq - b.createdSeq) * direction;
      return (a.number - b.number) * direction;
    });
    return list;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.objectId(), body, createdAt: nextTimestamp() };
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------ pull requests

  createPull(
    repo: Repo,
    fields: { title: string; body?: string; head: string; base: string },
  ): PullRequest | { error: 'head-missing' | 'base-missing' } {
    const headSha = this.resolveCommit(repo, fields.head);
    if (headSha === undefined) return { error: 'head-missing' };
    const baseSha = this.resolveCommit(repo, fields.base);
    if (baseSha === undefined) return { error: 'base-missing' };
    const timestamp = nextTimestamp();
    repo.pullSeq += 1;
    const pull: PullRequest = {
      id: this.objectId(),
      number: repo.pullSeq,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      head: fields.head,
      base: fields.base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: timestamp,
      createdSeq: this.creationSeq,
    };
    this.creationSeq += 1;
    repo.pulls.push(pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }

  listPulls(repo: Repo, state?: string): PullRequest[] {
    const list = [...repo.pulls];
    if (state === 'open' || state === 'closed') return list.filter((pull) => pull.state === state);
    return list;
  }

  /** The newest commit reachable from both `a` and `b`. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const ancestors = collectReachable([b], this.lookup(repo), { allowMissing: true });
    const seen = new Set<string>();
    const queue: string[] = [a];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return undefined;
  }

  /** Diff two trees as a path -> {old, new} map of blob oids. */
  diffTrees(repo: Repo, oldTree: string | undefined, newTree: string | undefined): Map<string, { old: string | null; next: string | null }> {
    const oldFiles = oldTree === undefined ? new Map() : this.flattenTree(repo, oldTree);
    const newFiles = newTree === undefined ? new Map() : this.flattenTree(repo, newTree);
    const out = new Map<string, { old: string | null; next: string | null }>();
    for (const [path, file] of oldFiles) {
      const nextFile = newFiles.get(path);
      if (nextFile === undefined) out.set(path, { old: file.oid, next: null });
      else if (nextFile.oid !== file.oid) out.set(path, { old: file.oid, next: nextFile.oid });
    }
    for (const [path, file] of newFiles) {
      if (!oldFiles.has(path)) out.set(path, { old: null, next: file.oid });
    }
    return out;
  }

  /** Count the lines added and removed between two blob contents (multiset diff). */
  lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const countLines = (data: Buffer | null): Map<string, number> => {
      const counts = new Map<string, number>();
      if (data === null) return counts;
      const text = data.toString('utf8');
      for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const oldCounts = countLines(oldData);
    const newCounts = countLines(newData);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newCounts) {
      const oldCount = oldCounts.get(line) ?? 0;
      if (count > oldCount) additions += count - oldCount;
    }
    for (const [line, count] of oldCounts) {
      const newCount = newCounts.get(line) ?? 0;
      if (count > newCount) deletions += count - newCount;
    }
    return { additions, deletions };
  }

  /** The files a pull request changes, against its merge-base. */
  pullFiles(repo: Repo, pull: PullRequest): FileChange[] {
    const headSha = this.resolveCommit(repo, pull.head) ?? pull.headSha;
    const baseSha = this.resolveCommit(repo, pull.base) ?? pull.baseSha;
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === undefined ? undefined : this.treeFor(repo, base);
    const headTree = this.treeFor(repo, headSha);
    const diff = this.diffTrees(repo, baseTree, headTree);
    const out: FileChange[] = [];
    for (const [path, change] of [...diff.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const oldData = change.old === null ? null : (repo.objects.get(change.old)?.data ?? null);
      const newData = change.next === null ? null : (repo.objects.get(change.next)?.data ?? null);
      const { additions, deletions } = this.lineDiff(oldData, newData);
      out.push({
        filename: path,
        status: change.old === null ? 'added' : change.next === null ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return out;
  }

  /** True when the pull request cannot merge cleanly onto its base. */
  pullConflicts(repo: Repo, pull: PullRequest): boolean {
    const headSha = this.resolveCommit(repo, pull.head) ?? pull.headSha;
    const baseSha = this.resolveCommit(repo, pull.base) ?? pull.baseSha;
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === undefined ? undefined : this.treeFor(repo, base);
    const headTree = this.treeFor(repo, headSha);
    const baseCurrentTree = this.treeFor(repo, baseSha);
    const headDiff = this.diffTrees(repo, baseTree, headTree);
    const baseDiff = this.diffTrees(repo, baseTree, baseCurrentTree);
    for (const [path, headChange] of headDiff) {
      const baseChange = baseDiff.get(path);
      if (baseChange === undefined) continue;
      if (baseChange.next !== headChange.next) return true;
    }
    return false;
  }

  /**
   * Squash-merge a pull request onto its base branch: one commit on the base whose
   * tree is the three-way merge, whose parent is the base tip. Returns the merge
   * commit sha, or `conflict` when the base moved under the head.
   */
  mergePull(repo: Repo, pull: PullRequest, method: string): { sha: string; message: string } | { conflict: true } {
    if (this.pullConflicts(repo, pull)) return { conflict: true };
    const headSha = this.resolveCommit(repo, pull.head) ?? pull.headSha;
    const baseSha = this.resolveCommit(repo, pull.base) ?? pull.baseSha;
    const base = this.mergeBase(repo, headSha, baseSha);
    const baseTree = base === undefined ? undefined : this.treeFor(repo, base);
    const headTree = this.treeFor(repo, headSha);
    const baseCurrentTree = this.treeFor(repo, baseSha);
    const files = baseCurrentTree === undefined ? new Map<string, { oid: string; mode: string }>() : this.flattenTree(repo, baseCurrentTree);
    const headDiff = this.diffTrees(repo, baseTree, headTree);
    for (const [path, change] of headDiff) {
      if (change.next === null) files.delete(path);
      else {
        const headFile = headTree === undefined ? undefined : this.flattenTree(repo, headTree).get(path);
        files.set(path, { oid: change.next, mode: headFile?.mode ?? '100644' });
      }
    }
    const tree = this.buildTreeFromMap(repo, files);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const sha = this.commitTree(repo, { tree, parents: [baseSha], message });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    const mergedAt = nextTimestamp();
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = mergedAt;
    pull.mergeCommitSha = sha;
    return { sha, message };
  }
}
