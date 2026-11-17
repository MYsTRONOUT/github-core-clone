// graphql.ts — the GraphQL surface at POST /api/graphql.
//
// A small recursive-descent parser for the documents the suite sends
// (operations, variables, aliases, inline fragments, input objects, enums,
// batched arrays) and an executor over the same forge the REST and git
// surfaces use. Unknown fields are a validation error at HTTP 200 with an
// errors array; an unknown repository is data.repository null with no errors;
// unauthenticated is exactly 401 (handled by app.ts before this runs).

import { decodeGlobalId, encodeGlobalId } from './forge.ts';
import type { Forge, Issue, IssueComment, PullRequest, Repo } from './forge.ts';
import { isoOf, nextTimestamp, SCENARIO_EPOCH_SEC, VIEWER } from './scenario.ts';
import { isRecord, sendError, sendJson } from './http.ts';
import type { Ctx } from './http.ts';

// ---------------------------------------------------------------- the parser

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'eof'; value: '' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u' && j + 5 < source.length) {
            out += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
          continue;
        }
        out += source[j];
        j += 1;
      }
      if (j >= source.length) throw new Error('unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; name: string; alias?: string; arguments: ArgumentNode[]; selectionSet?: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition?: string; selectionSet: SelectionNode[] };

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Record<string, FragmentNode>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name in GraphQL document, got ${JSON.stringify(token.value)}`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'operation', operation: 'query', selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        const fragment = this.parseFragment();
        fragments[fragment.name] = fragment;
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value;
        this.parseVariableDefinitions();
        this.parseDirectives();
        operations.push({ kind: 'operation', operation, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token.value)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
        this.next(); // $name, :, Type, optional default — names only, values come from variables
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          this.parseValue();
        }
      }
      this.expectPunct(')');
    }
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseFragment(): FragmentNode {
    this.next(); // fragment
    const name = this.expectName();
    const on = this.expectName();
    if (on !== 'on') throw new Error('fragment must have an "on" type condition');
    const typeCondition = this.expectName();
    this.parseDirectives();
    return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (nextToken.kind === 'name') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'fragmentSpread', name };
      }
      throw new Error('fragment spread needs a name or an "on" type condition');
    }
    const name = this.expectName();
    let alias: string | undefined;
    let fieldName = name;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args = this.parseArguments();
    this.parseDirectives();
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', name: fieldName, alias, arguments: args, selectionSet };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
        const name = this.expectName();
        this.expectPunct(':');
        args.push({ name, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated list value');
        values.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new Error('unterminated object value');
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------- the schema table

/** The fields each type exposes, for __type introspection and validation. */
const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Node: ['id'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt'],
  Ref: ['name', 'prefix', 'target'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'comments', 'labels', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'title', 'body', 'files', 'createdAt', 'updatedAt', 'mergeCommit', 'author'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  Commit: ['oid', 'message'],
  Label: ['id', 'name', 'color'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
};

/** The return type of each field (item type for lists), for nested validation. */
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Node: { id: 'ID' },
  User: { login: 'String', id: 'ID', name: 'String', email: 'String', avatarUrl: 'String' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', description: 'String', createdAt: 'String', updatedAt: 'String' },
  Ref: { name: 'String', prefix: 'String', target: 'Commit' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String', comments: 'IssueCommentConnection', labels: 'LabelConnection', url: 'String' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequest: { id: 'ID', number: 'Int', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', title: 'String', body: 'String', files: 'PullRequestChangedFileConnection', createdAt: 'String', updatedAt: 'String', mergeCommit: 'Commit', author: 'User' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'PullRequestChangedFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  __Type: { name: 'String', kind: 'String', description: 'String', fields: '__Field', enumValues: '__EnumValue', inputFields: '__InputValue', interfaces: '__Type', possibleTypes: '__Type' },
  __Field: { name: 'String', description: 'String', args: '__InputValue', type: '__Type' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Schema: { types: '__Type', queryType: '__Type', mutationType: '__Type', description: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'CommentEdge', clientMutationId: 'String' },
  CommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String', author: 'User', createdAt: 'String', updatedAt: 'String' },
  Commit: { oid: 'String', message: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String' },
  LabelConnection: { nodes: 'Label', edges: 'LabelEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  LabelEdge: { node: 'Label', cursor: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'CommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
};

const SCHEMA_KINDS: Readonly<Record<string, string>> = {
  Node: 'INTERFACE',
  SearchType: 'ENUM',
  IssueState: 'ENUM',
  PullRequestState: 'ENUM',
  MergeableState: 'ENUM',
  PullRequestMergeMethod: 'ENUM',
  RepositoryPermission: 'ENUM',
  IssueOrderField: 'ENUM',
  OrderDirection: 'ENUM',
  String: 'SCALAR',
  Int: 'SCALAR',
  ID: 'SCALAR',
  Boolean: 'SCALAR',
};

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- the executor

type Entity = { __typename: string; [key: string]: unknown };

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Record<string, FragmentNode>;
}

function isEntity(value: unknown): value is Entity {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).__typename === 'string';
}

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => valueFromAst(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromAst(field.value, variables);
      return out;
    }
  }
}

function validateSelections(selections: readonly SelectionNode[], typeName: string, fragments: Record<string, FragmentNode>, errors: string[]): void {
  const fields = SCHEMA_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') continue;
      if (fields === undefined || !fields.includes(selection.name)) {
        errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
        continue;
      }
      if (selection.selectionSet !== undefined) {
        const childType = FIELD_TYPES[typeName]?.[selection.name];
        if (childType !== undefined && childType !== 'String' && childType !== 'Int' && childType !== 'ID' && childType !== 'Boolean') {
          validateSelections(selection.selectionSet, childType, fragments, errors);
        }
      }
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      validateSelections(selection.selectionSet, selection.typeCondition ?? typeName, fragments, errors);
      continue;
    }
    const fragment = fragments[selection.name];
    if (fragment !== undefined) validateSelections(fragment.selectionSet, fragment.typeCondition, fragments, errors);
  }
}

function cursorForNumber(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
  hasPreviousPage: boolean;
  startCursor: string | null;
}

function pageOf<T extends { number: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
  direction: 1 | -1,
): { page: T[]; pageInfo: PageInfo } {
  const after = numberFromCursor(args.after);
  let filtered = [...items];
  if (after !== null) {
    filtered = filtered.filter((item) => (direction === 1 ? item.number > after : item.number < after));
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : filtered.length;
  const page = filtered.slice(0, first);
  const hasNextPage = filtered.length > page.length;
  const last = page[page.length - 1];
  const firstItem = page[0];
  return {
    page,
    pageInfo: {
      hasNextPage,
      endCursor: last === undefined ? null : cursorForNumber(last.number),
      hasPreviousPage: after !== null,
      startCursor: firstItem === undefined ? null : cursorForNumber(firstItem.number),
    },
  };
}

function issueConnectionEntity(forge: Forge, repo: Repo, args: Record<string, unknown>): Entity {
  let issues = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : undefined;
  const direction: 1 | -1 = orderBy?.direction === 'ASC' ? 1 : orderBy?.direction === 'DESC' ? -1 : 1;
  issues.sort((a, b) => {
    if (a.createdSeq !== b.createdSeq) return (a.createdSeq - b.createdSeq) * direction;
    return (a.number - b.number) * direction;
  });
  const totalCount = issues.length;
  const { page, pageInfo } = pageOf(issues, args, direction);
  const items: Entity[] = page.map((issue) => ({ __typename: 'Issue', repo, issue }));
  return {
    __typename: 'IssueConnection',
    items,
    pageInfo: { __typename: 'PageInfo', ...pageInfo },
    totalCount,
  };
}

function pullConnectionEntity(forge: Forge, repo: Repo, args: Record<string, unknown>): Entity {
  let pulls = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state === 'open' ? 'open' : pull.merged ? 'merged' : 'closed'));
  }
  const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : undefined;
  const direction: 1 | -1 = orderBy?.direction === 'ASC' ? 1 : orderBy?.direction === 'DESC' ? -1 : 1;
  pulls.sort((a, b) => {
    if (a.createdSeq !== b.createdSeq) return (a.createdSeq - b.createdSeq) * direction;
    return (a.number - b.number) * direction;
  });
  const totalCount = pulls.length;
  const { page, pageInfo } = pageOf(pulls, args, direction);
  const items: Entity[] = page.map((pull) => ({ __typename: 'PullRequest', repo, pull }));
  return {
    __typename: 'PullRequestConnection',
    items,
    pageInfo: { __typename: 'PageInfo', ...pageInfo },
    totalCount,
  };
}

function changedFileConnectionEntity(forge: Forge, repo: Repo, pull: PullRequest, args: Record<string, unknown>): Entity {
  const files = forge.pullFiles(repo, pull);
  const items: Entity[] = files.map((file) => ({
    __typename: 'PullRequestChangedFile',
    path: file.filename,
    additions: file.additions,
    deletions: file.deletions,
    changeType: file.status,
  }));
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(0, first);
  const pageInfo: PageInfo = { hasNextPage: items.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null };
  return { __typename: 'PullRequestChangedFileConnection', items: page, pageInfo: { __typename: 'PageInfo', ...pageInfo }, totalCount: items.length };
}

function commentConnectionEntity(forge: Forge, repo: Repo, issue: Issue, args: Record<string, unknown>): Entity {
  const items: Entity[] = issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment }));
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(0, first);
  const pageInfo: PageInfo = { hasNextPage: items.length > page.length, endCursor: null, hasPreviousPage: false, startCursor: null };
  return { __typename: 'IssueCommentConnection', items: page, pageInfo: { __typename: 'PageInfo', ...pageInfo }, totalCount: items.length };
}

function labelConnectionEntity(repo: Repo): Entity {
  const items: Entity[] = [...repo.labels.values()].map((label) => ({ __typename: 'Label', label }));
  const pageInfo: PageInfo = { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null };
  return { __typename: 'LabelConnection', items, pageInfo: { __typename: 'PageInfo', ...pageInfo }, totalCount: items.length };
}

function repositoryEntity(forge: Forge, owner: unknown, name: unknown): Entity | null {
  if (typeof owner !== 'string' || typeof name !== 'string') return null;
  if (owner !== VIEWER.login) return null;
  const repo = forge.getRepo(owner, name);
  return repo === undefined ? null : { __typename: 'Repository', repo };
}

function resolveNode(forge: Forge, id: unknown): Entity | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository' && decoded.parts.length === 2) {
    const [owner, name] = decoded.parts as [string, string];
    return repositoryEntity(forge, owner, name);
  }
  if (decoded.type === 'Issue' && decoded.parts.length === 3) {
    const [owner, name, number] = decoded.parts as [string, string, string];
    const repo = forge.getRepo(owner, name);
    if (repo === undefined || owner !== VIEWER.login) return null;
    const issue = forge.getIssue(repo, Number(number));
    return issue === undefined ? null : { __typename: 'Issue', repo, issue };
  }
  if (decoded.type === 'PullRequest' && decoded.parts.length === 3) {
    const [owner, name, number] = decoded.parts as [string, string, string];
    const repo = forge.getRepo(owner, name);
    if (repo === undefined || owner !== VIEWER.login) return null;
    const pull = forge.getPull(repo, Number(number));
    return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
  }
  if (decoded.type === 'IssueComment' && decoded.parts.length === 4) {
    const [owner, name, issueNumber, commentId] = decoded.parts as [string, string, string, string];
    const repo = forge.getRepo(owner, name);
    if (repo === undefined || owner !== VIEWER.login) return null;
    const issue = forge.getIssue(repo, Number(issueNumber));
    if (issue === undefined) return null;
    const comment = issue.comments.find((candidate) => candidate.id === Number(commentId));
    return comment === undefined ? null : { __typename: 'IssueComment', repo, issue, comment };
  }
  return null;
}

type Resolver = (parent: Entity, args: Record<string, unknown>, ctx: ExecCtx) => unknown;

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => ({ __typename: 'User', login: VIEWER.login }),
    repository: (_parent, args, ctx) => repositoryEntity(ctx.forge, args.owner, args.name),
    node: (_parent, args, ctx) => resolveNode(ctx.forge, args.id),
    __type: (_parent, args) => ({ __typename: '__Type', name: String(args.name ?? '') }),
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const repo = resolveNode(ctx.forge, input.repositoryId);
      if (repo === null || repo.__typename !== 'Repository') return { __typename: 'CreateIssuePayload', issue: null };
      const target = repo.repo as Repo;
      const issue = ctx.forge.createIssue(target, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __typename: 'CreateIssuePayload', issue: { __typename: 'Issue', repo: target, issue } };
    },
    closeIssue: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const node = resolveNode(ctx.forge, input.issueId);
      if (node === null || node.__typename !== 'Issue') return { __typename: 'CloseIssuePayload', issue: null };
      const issue = node.issue as Issue;
      issue.state = 'closed';
      issue.updatedAt = nextTimestamp();
      return { __typename: 'CloseIssuePayload', issue: node };
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const repoNode = resolveNode(ctx.forge, input.repositoryId);
      if (repoNode === null || repoNode.__typename !== 'Repository') return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      const target = repoNode.repo as Repo;
      const created = ctx.forge.createPull(target, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if ('error' in created) return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      return { __typename: 'CreatePullRequestPayload', pullRequest: { __typename: 'PullRequest', repo: target, pull: created } };
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const node = resolveNode(ctx.forge, input.pullRequestId);
      if (node === null || node.__typename !== 'PullRequest') return { __typename: 'MergePullRequestPayload', pullRequest: null };
      const repo = node.repo as Repo;
      const pull = node.pull as PullRequest;
      if (!pull.merged && pull.state === 'open') ctx.forge.mergePull(repo, pull, 'squash');
      return { __typename: 'MergePullRequestPayload', pullRequest: node };
    },
    addComment: (_parent, args, ctx) => {
      const input = isRecord(args.input) ? (args.input as Record<string, unknown>) : {};
      const node = resolveNode(ctx.forge, input.subjectId);
      if (node === null || node.__typename !== 'Issue') return { __typename: 'AddCommentPayload', commentEdge: null };
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const comment = ctx.forge.addComment(repo, issue, typeof input.body === 'string' ? input.body : '');
      const commentNode: Entity = { __typename: 'IssueComment', repo, issue, comment };
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'CommentEdge', node: commentNode, cursor: cursorForNumber(comment.id) },
      };
    },
  },
  User: {
    id: (parent) => encodeGlobalId('User', String(parent.login ?? '')),
    login: (parent) => parent.login ?? null,
    name: () => VIEWER.name,
    email: () => VIEWER.email,
    avatarUrl: () => '',
  },
  Repository: {
    id: (parent) => {
      const repo = parent.repo as Repo;
      return encodeGlobalId('Repository', repo.owner, repo.name);
    },
    databaseId: (parent) => (parent.repo as Repo).id,
    name: (parent) => (parent.repo as Repo).name,
    nameWithOwner: (parent) => {
      const repo = parent.repo as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (parent) => ({ __typename: 'User', login: (parent.repo as Repo).owner }),
    defaultBranchRef: (parent) => {
      const repo = parent.repo as Repo;
      return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? { __typename: 'Ref', name: repo.defaultBranch } : null;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    issue: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const issue = ctx.forge.getIssue(repo, Number(args.number));
      return issue === undefined ? null : { __typename: 'Issue', repo, issue };
    },
    issues: (parent, args, ctx) => issueConnectionEntity(ctx.forge, parent.repo as Repo, args),
    pullRequests: (parent, args, ctx) => pullConnectionEntity(ctx.forge, parent.repo as Repo, args),
    pullRequest: (parent, args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = ctx.forge.getPull(repo, Number(args.number));
      return pull === undefined ? null : { __typename: 'PullRequest', repo, pull };
    },
    description: (parent) => (parent.repo as Repo).description,
    createdAt: (parent) => isoOf(SCENARIO_EPOCH_SEC + (parent.repo as Repo).createdSeq),
    updatedAt: (parent) => isoOf(SCENARIO_EPOCH_SEC + (parent.repo as Repo).createdSeq),
  },
  Ref: {
    name: (parent) => parent.name ?? null,
    prefix: () => 'refs/heads/',
    target: () => null,
  },
  Issue: {
    id: (parent) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      return encodeGlobalId('Issue', repo.owner, repo.name, issue.number);
    },
    number: (parent) => (parent.issue as Issue).number,
    title: (parent) => (parent.issue as Issue).title,
    state: (parent) => ((parent.issue as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    body: (parent) => (parent.issue as Issue).body,
    author: () => ({ __typename: 'User', login: VIEWER.login }),
    createdAt: (parent) => isoOf((parent.issue as Issue).createdAt),
    updatedAt: (parent) => isoOf((parent.issue as Issue).updatedAt),
    comments: (parent, args, ctx) => commentConnectionEntity(ctx.forge, parent.repo as Repo, parent.issue as Issue, args),
    labels: (parent) => labelConnectionEntity(parent.repo as Repo),
    url: () => '',
  },
  IssueConnection: {
    nodes: (parent) => (parent.items as Entity[]) ?? [],
    edges: (parent) => {
      const items = (parent.items as Entity[]) ?? [];
      return items.map((item) => ({ __typename: 'IssueEdge', node: item, cursor: cursorForNumber((item.issue as Issue).number) }));
    },
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  IssueEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => parent.cursor ?? null,
  },
  PullRequest: {
    id: (parent) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      return encodeGlobalId('PullRequest', repo.owner, repo.name, pull.number);
    },
    number: (parent) => (parent.pull as PullRequest).number,
    state: (parent) => {
      const pull = parent.pull as PullRequest;
      return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
    },
    merged: (parent) => (parent.pull as PullRequest).merged,
    headRefName: (parent) => (parent.pull as PullRequest).head,
    baseRefName: (parent) => (parent.pull as PullRequest).base,
    mergeable: (parent, _args, ctx) => {
      const repo = parent.repo as Repo;
      const pull = parent.pull as PullRequest;
      if (pull.state !== 'open') return 'UNKNOWN';
      return ctx.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    title: (parent) => (parent.pull as PullRequest).title,
    body: (parent) => (parent.pull as PullRequest).body,
    files: (parent, args, ctx) => changedFileConnectionEntity(ctx.forge, parent.repo as Repo, parent.pull as PullRequest, args),
    createdAt: (parent) => isoOf((parent.pull as PullRequest).createdAt),
    updatedAt: (parent) => isoOf((parent.pull as PullRequest).createdAt),
    mergeCommit: (parent) => {
      const pull = parent.pull as PullRequest;
      return pull.mergeCommitSha === null ? null : { __typename: 'Commit', oid: pull.mergeCommitSha, message: '' };
    },
    author: () => ({ __typename: 'User', login: VIEWER.login }),
  },
  PullRequestConnection: {
    nodes: (parent) => (parent.items as Entity[]) ?? [],
    edges: (parent) => {
      const items = (parent.items as Entity[]) ?? [];
      return items.map((item) => ({ __typename: 'PullRequestEdge', node: item, cursor: cursorForNumber((item.pull as PullRequest).number) }));
    },
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  PullRequestEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => parent.cursor ?? null,
  },
  PullRequestChangedFile: {
    path: (parent) => parent.path ?? null,
    additions: (parent) => parent.additions ?? 0,
    deletions: (parent) => parent.deletions ?? 0,
    changeType: (parent) => parent.changeType ?? null,
  },
  PullRequestChangedFileConnection: {
    nodes: (parent) => (parent.items as Entity[]) ?? [],
    edges: (parent) => {
      const items = (parent.items as Entity[]) ?? [];
      return items.map((item, index) => ({ __typename: 'PullRequestChangedFileEdge', node: item, cursor: cursorForNumber(index + 1) }));
    },
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  PullRequestChangedFileEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => parent.cursor ?? null,
  },
  PageInfo: {
    hasNextPage: (parent) => Boolean(parent.hasNextPage),
    hasPreviousPage: (parent) => Boolean(parent.hasPreviousPage),
    startCursor: (parent) => (parent.startCursor as string | null) ?? null,
    endCursor: (parent) => (parent.endCursor as string | null) ?? null,
  },
  __Type: {
    name: (parent) => parent.name ?? null,
    kind: (parent) => SCHEMA_KINDS[String(parent.name ?? '')] ?? 'OBJECT',
    description: () => null,
    fields: (parent) => {
      const names = SCHEMA_FIELDS[String(parent.name ?? '')] ?? [];
      return names.map((name) => ({ __typename: '__Field', name }));
    },
    enumValues: (parent) => {
      const values = SCHEMA_ENUMS[String(parent.name ?? '')] ?? [];
      return values.map((name) => ({ __typename: '__EnumValue', name }));
    },
    inputFields: () => [],
    interfaces: () => [],
    possibleTypes: (parent) => {
      // The Node interface is implemented by every type that carries a global id.
      if (String(parent.name ?? '') !== 'Node') return [];
      return ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label'].map((name) => ({ __typename: '__Type', name }));
    },
  },
  __Field: {
    name: (parent) => parent.name ?? null,
    description: () => null,
    args: () => [],
    type: () => ({ __typename: '__Type', name: 'String' }),
  },
  __EnumValue: {
    name: (parent) => parent.name ?? null,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    types: () => Object.keys(SCHEMA_FIELDS).map((name) => ({ __typename: '__Type', name })),
    queryType: () => ({ __typename: '__Type', name: 'Query' }),
    mutationType: () => ({ __typename: '__Type', name: 'Mutation' }),
    description: () => null,
  },
  CreateIssuePayload: {
    issue: (parent) => parent.issue ?? null,
    clientMutationId: () => null,
  },
  CloseIssuePayload: {
    issue: (parent) => parent.issue ?? null,
    clientMutationId: () => null,
  },
  CreatePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
    clientMutationId: () => null,
  },
  MergePullRequestPayload: {
    pullRequest: (parent) => parent.pullRequest ?? null,
    clientMutationId: () => null,
  },
  AddCommentPayload: {
    commentEdge: (parent) => parent.commentEdge ?? null,
    clientMutationId: () => null,
  },
  CommentEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => parent.cursor ?? null,
  },
  IssueComment: {
    id: (parent) => {
      const repo = parent.repo as Repo;
      const issue = parent.issue as Issue;
      const comment = parent.comment as IssueComment;
      return encodeGlobalId('IssueComment', repo.owner, repo.name, issue.number, comment.id);
    },
    body: (parent) => (parent.comment as IssueComment).body,
    author: () => ({ __typename: 'User', login: VIEWER.login }),
    createdAt: (parent) => isoOf((parent.comment as IssueComment).createdAt),
    updatedAt: (parent) => isoOf((parent.comment as IssueComment).createdAt),
  },
  Commit: {
    oid: (parent) => parent.oid ?? null,
    message: (parent) => parent.message ?? '',
  },
  Label: {
    id: (parent) => encodeGlobalId('Label', String((parent.label as { name: string }).name)),
    name: (parent) => (parent.label as { name: string }).name,
    color: (parent) => (parent.label as { color: string }).color,
  },
  LabelConnection: {
    nodes: (parent) => (parent.items as Entity[]) ?? [],
    edges: (parent) => {
      const items = (parent.items as Entity[]) ?? [];
      return items.map((item, index) => ({ __typename: 'LabelEdge', node: item, cursor: cursorForNumber(index + 1) }));
    },
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
  LabelEdge: {
    node: (parent) => parent.node ?? null,
    cursor: (parent) => parent.cursor ?? null,
  },
  IssueCommentConnection: {
    nodes: (parent) => (parent.items as Entity[]) ?? [],
    edges: (parent) => {
      const items = (parent.items as Entity[]) ?? [];
      return items.map((item) => ({ __typename: 'CommentEdge', node: item, cursor: cursorForNumber((item.comment as IssueComment).id) }));
    },
    pageInfo: (parent) => parent.pageInfo ?? null,
    totalCount: (parent) => parent.totalCount ?? 0,
  },
};

function executeSelectionSet(selections: readonly SelectionNode[], parent: Entity, parentType: string, ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      if (selection.name === '__typename') {
        out[selection.alias ?? '__typename'] = parent.__typename;
        continue;
      }
      // A field resolves through the static type first; when the static type
      // is an interface (notably Node) the field is dispatched to the entity's
      // runtime type instead — `node(id:)` returns a Repository, an Issue, a
      // PullRequest, and so on, and `id` lives on those concrete types.
      const resolver = RESOLVERS[parentType]?.[selection.name] ?? RESOLVERS[parent.__typename]?.[selection.name];
      if (resolver === undefined) {
        out[selection.alias ?? selection.name] = null;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of selection.arguments) args[arg.name] = valueFromAst(arg.value, ctx.variables);
      const value = resolver(parent, args, ctx);
      if (selection.selectionSet === undefined) {
        out[selection.alias ?? selection.name] = value;
        continue;
      }
      if (value === null || value === undefined) {
        out[selection.alias ?? selection.name] = null;
        continue;
      }
      if (Array.isArray(value)) {
        const itemType = FIELD_TYPES[parentType]?.[selection.name] ?? 'String';
        out[selection.alias ?? selection.name] = value.map((item) =>
          isEntity(item) ? executeSelectionSet(selection.selectionSet as SelectionNode[], item, itemType, ctx) : item,
        );
        continue;
      }
      if (isEntity(value)) {
        const itemType = FIELD_TYPES[parentType]?.[selection.name] ?? 'String';
        out[selection.alias ?? selection.name] = executeSelectionSet(selection.selectionSet, value, itemType, ctx);
        continue;
      }
      out[selection.alias ?? selection.name] = value;
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      const condition = selection.typeCondition;
      if (condition === undefined || condition === parentType || parent.__typename === condition) {
        Object.assign(out, executeSelectionSet(selection.selectionSet, parent, condition ?? parentType, ctx));
      }
      continue;
    }
    const fragment = ctx.fragments[selection.name];
    if (fragment !== undefined) {
      Object.assign(out, executeSelectionSet(fragment.selectionSet, parent, fragment.typeCondition, ctx));
    }
  }
  return out;
}

interface GraphqlResult {
  data: Record<string, unknown> | null;
  errors?: { message: string }[];
}

/** Execute one parsed operation against the forge. */
function executeOperation(document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>, forge: Forge): GraphqlResult {
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(operation.selectionSet, rootType, document.fragments, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments };
  const root: Entity = { __typename: rootType };
  try {
    const data = executeSelectionSet(operation.selectionSet, root, rootType, ctx);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
}

/** Execute one request body ({query, variables, operationName}) and return its result. */
function runGraphqlRequest(body: unknown, forge: Forge): GraphqlResult | { message: string } {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { message: 'query is required' };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let document: DocumentNode;
  try {
    document = new Parser(body.query as string).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: `Syntax Error: ${(err as Error).message}` }] };
  }
  let operation = document.operations[0];
  if (typeof body.operationName === 'string') {
    operation = document.operations.find((candidate) => candidate.name === (body.operationName as string)) ?? operation;
  }
  if (operation === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  return executeOperation(document, operation, variables, forge);
}

/** POST /api/graphql. */
export function handleGraphql(ctx: Ctx): void {
  if (ctx.method !== 'POST') return sendError(ctx, 405, 'Method Not Allowed');
  if (ctx.jsonError) return sendJson(ctx, 400, { errors: [{ message: 'body is not valid JSON' }] });
  if (Array.isArray(ctx.json)) {
    const results = ctx.json.map((entry) => runGraphqlRequest(entry, ctx.forge));
    return sendJson(ctx, 200, results);
  }
  const result = runGraphqlRequest(ctx.json, ctx.forge);
  if ('message' in result && !('data' in result)) return sendError(ctx, 400, result.message);
  return sendJson(ctx, 200, result);
}
