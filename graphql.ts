// GraphQL v4 (GitHub-compatible subset): a small lexer + recursive-descent parser + executor
// against a hand-written schema. No GraphQL library: the suite's 18 fixed documents (plus any
// document gh or github-mcp-server sends in the same shapes) are parsed generally — operations,
// variables with defaults, arguments as literals/variables/lists/objects, aliases, inline and
// named fragments, and __type introspection. Unknown fields answer HTTP 200 with an `errors`
// array naming the field; unknown repositories answer data.repository = null with no errors.

import { gid, parseGid, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// --------------------------------------------------------------------- lexer
interface Token {
  kind: 'Name' | 'Int' | 'Float' | 'String' | 'Punct' | 'EOF';
  value: string;
}

const PUNCT = new Set(['!', '$', '&', '(', ')', '...', ':', '=', '@', '[', ']', '{', '|', '}']);

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const push = (kind: Token['kind'], value: string): void => {
    tokens.push({ kind, value });
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or plain "..." (with escapes).
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const value = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        push('String', value);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const escaped = source[i + 1] as string;
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
          i += 2;
          continue;
        }
        value += source[i] as string;
        i += 1;
      }
      i += 1;
      push('String', value);
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let value = '';
      while (i < source.length && /[0-9.]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      if (/[eE]/.test(source[i] ?? '')) {
        value += source[i] as string;
        i += 1;
        if (source[i] === '+' || source[i] === '-') {
          value += source[i] as string;
          i += 1;
        }
        while (i < source.length && /[0-9]/.test(source[i] as string)) {
          value += source[i] as string;
          i += 1;
        }
      }
      push(value.includes('.') || /[eE]/.test(value) ? 'Float' : 'Int', value);
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let value = '';
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i] as string)) {
        value += source[i] as string;
        i += 1;
      }
      push('Name', value);
      continue;
    }
    if (source.startsWith('...', i)) {
      push('Punct', '...');
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      push('Punct', ch);
      i += 1;
      continue;
    }
    throw new Error(`Syntax Error: unexpected character ${JSON.stringify(ch)}`);
  }
  push('EOF', '');
  return tokens;
}

// -------------------------------------------------------------------- parser
type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'IntValue'; value: number }
  | { kind: 'FloatValue'; value: number }
  | { kind: 'StringValue'; value: string }
  | { kind: 'BooleanValue'; value: boolean }
  | { kind: 'NullValue' }
  | { kind: 'EnumValue'; value: string }
  | { kind: 'ListValue'; values: ValueNode[] }
  | { kind: 'ObjectValue'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'Field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'FragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'InlineFragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'Operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'Fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'Punct' || token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}", got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'Name') throw new Error(`Syntax Error: expected a name, got ${JSON.stringify(token.value)}`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`Syntax Error: expected "${value}", got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'EOF') {
      if (this.peek().kind === 'Punct' && this.peek().value === '{') {
        operations.push({ kind: 'Operation', operation: 'query', variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword === 'fragment') {
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        fragments.set(name, { kind: 'Fragment', name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation' && keyword !== 'subscription') {
        throw new Error(`Syntax Error: unexpected keyword ${JSON.stringify(keyword)}`);
      }
      let name: string | undefined;
      if (this.peek().kind === 'Name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.parseDirectives();
      operations.push({ kind: 'Operation', operation: keyword, name, variables, selections: this.parseSelectionSet() });
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().kind === 'Punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'Punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        this.parseDirectives();
        variables.push({ name, defaultValue });
      }
      this.expectPunct(')');
    }
    return variables;
  }

  private parseType(): void {
    if (this.peek().kind === 'Punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'Punct' && this.peek().value === '!') this.next();
  }

  private parseDirectives(): void {
    while (this.peek().kind === 'Punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'Punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseArguments(): { name: string; value: ValueNode }[] {
    const args: { name: string; value: ValueNode }[] = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'Punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'Punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'Punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'ListValue', values };
    }
    if (token.kind === 'Punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'ObjectValue', fields };
    }
    if (token.kind === 'Int') return { kind: 'IntValue', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'Float') return { kind: 'FloatValue', value: Number.parseFloat(token.value) };
    if (token.kind === 'String') return { kind: 'StringValue', value: token.value };
    if (token.kind === 'Name') {
      if (token.value === 'true') return { kind: 'BooleanValue', value: true };
      if (token.value === 'false') return { kind: 'BooleanValue', value: false };
      if (token.value === 'null') return { kind: 'NullValue' };
      return { kind: 'EnumValue', value: token.value };
    }
    throw new Error(`Syntax Error: unexpected value ${JSON.stringify(token.value)}`);
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'Punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'Punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value !== 'on') {
        const name = this.next().value;
        this.parseDirectives();
        return { kind: 'FragmentSpread', name };
      }
      let typeCondition: string | undefined;
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      this.parseDirectives();
      return { kind: 'InlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'Punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'Punct' && this.peek().value === '(' ? this.parseArguments() : [];
    this.parseDirectives();
    const selections = this.peek().kind === 'Punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'Field', alias, name, args, selections };
  }
}

// -------------------------------------------------------------- value shape
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function valueFromAst(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable':
      return variables[node.name];
    case 'IntValue':
    case 'FloatValue':
    case 'StringValue':
    case 'BooleanValue':
      return node.value;
    case 'NullValue':
      return null;
    case 'EnumValue':
      return node.value;
    case 'ListValue':
      return node.values.map((entry) => valueFromAst(entry, variables));
    case 'ObjectValue': {
      const object: Record<string, unknown> = {};
      for (const field of node.fields) object[field.name] = valueFromAst(field.value, variables);
      return object;
    }
  }
}

// ------------------------------------------------------------------- schema
// Field return types (named type; '[' ']' and '!' stripped for validation).
const FIELD_TYPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  User: { id: 'ID', databaseId: 'Int', login: 'String', name: 'String', email: 'String', avatarUrl: 'String', url: 'String', createdAt: 'String' },
  Repository: {
    id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref',
    viewerPermission: 'String', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection',
    pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection', description: 'String', private: 'Boolean',
    url: 'String', createdAt: 'String', updatedAt: 'String', fork: 'Boolean',
  },
  Issue: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'IssueState',
    createdAt: 'String', updatedAt: 'String', closedAt: 'String', author: 'User', labels: 'Label',
    comments: 'IssueCommentConnection', url: 'String', repository: 'Repository', locked: 'Boolean',
  },
  PullRequest: {
    id: 'ID', databaseId: 'Int', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState',
    merged: 'Boolean', mergeable: 'MergeableState', headRefName: 'String', baseRefName: 'String',
    headRef: 'Ref', baseRef: 'Ref', files: 'PullRequestFileConnection', createdAt: 'String', updatedAt: 'String',
    mergedAt: 'String', mergeCommit: 'Commit', author: 'User', url: 'String', repository: 'Repository',
    isDraft: 'Boolean', additions: 'Int', deletions: 'Int', changedFiles: 'Int',
  },
  IssueComment: { id: 'ID', databaseId: 'Int', body: 'String', createdAt: 'String', updatedAt: 'String', author: 'User' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestFileConnection: { nodes: 'PullRequestFile', edges: 'PullRequestFileEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueCommentConnection: { nodes: 'IssueComment', edges: 'IssueCommentEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestFileEdge: { node: 'PullRequestFile', cursor: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  PullRequestFile: { path: 'String', filename: 'String', status: 'String', additions: 'Int', deletions: 'Int', changes: 'Int' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  Ref: { name: 'String', prefix: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Label: { id: 'ID', name: 'String', color: 'String', description: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String' },
  __EnumValue: { name: 'String' },
  __Schema: { types: '__Type' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue', clientMutationId: 'String' },
  Node: { id: 'ID' },
};

// Fields __type(name:) reports, per type (the gh feature-detection probes read these lists).
const INTROSPECTION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'repository', 'locked', 'assignees', 'participants'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'author', 'labels', 'url', 'repository', 'isDraft', 'additions', 'deletions', 'changedFiles'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'fork', 'stargazers', 'watchers', 'license', 'topics', 'homepageUrl', 'pushedAt', 'diskUsage'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'avatarUrl', 'url', 'createdAt'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'author'],
  PullRequestFile: ['path', 'filename', 'status', 'additions', 'deletions', 'changes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'prefix', 'target'],
  Label: ['id', 'name', 'color', 'description'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const SEARCH_TYPE_VALUES: readonly string[] = ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'MILESTONE', 'PULL_REQUEST', 'REPOSITORY', 'TOPIC', 'USER'];

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

// ------------------------------------------------------------------ runtime
class GraphQLError extends Error {}

interface TypedObject {
  __typename: string;
  data: Record<string, unknown>;
}

type ResolvedValue = unknown;

interface ExecutorContext {
  store: Store;
}

function isTyped(value: unknown): value is TypedObject {
  return value !== null && typeof value === 'object' && '__typename' in (value as Record<string, unknown>);
}

function wrap(typename: string, data: Record<string, unknown>): TypedObject {
  return { __typename: typename, data };
}

function cursorFor(kind: string, seq: number): string {
  return Buffer.from(`${kind}:${seq}`, 'utf8').toString('base64url');
}

function seqFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const parts = text.split(':');
    const seq = Number.parseInt(parts[1] ?? '', 10);
    return Number.isFinite(seq) ? seq : null;
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Split a global-id key `owner/name[:number[:comment]]` into its parts. */
function splitGidKey(key: string): { owner: string; name: string; rest: string[] } | null {
  const slash = key.indexOf('/');
  if (slash <= 0) return null;
  const owner = key.slice(0, slash);
  const parts = key.slice(slash + 1).split(':');
  const name = parts[0] as string;
  if (!name) return null;
  return { owner, name, rest: parts.slice(1) };
}

function userObject(ctx: ExecutorContext, login: string): TypedObject {
  const viewer = ctx.store.identity.viewer;
  return wrap('User', { login, id: gid('User', login), databaseId: viewer.id, name: viewer.name, email: viewer.email, avatarUrl: '', url: `https://github.com/${login}`, createdAt: '2025-01-01T00:00:00Z' });
}

function repoObject(ctx: ExecutorContext, repo: Repo): TypedObject {
  return wrap('Repository', { repo });
}

function issueObject(ctx: ExecutorContext, repo: Repo, issue: Issue): TypedObject {
  return wrap('Issue', { repo, issue });
}

function pullObject(ctx: ExecutorContext, repo: Repo, pull: PullRequest): TypedObject {
  return wrap('PullRequest', { repo, pull });
}

function commentObject(ctx: ExecutorContext, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): TypedObject {
  return wrap('IssueComment', { repo, issue, comment });
}

interface ConnectionItem {
  node: TypedObject;
  seq: number;
}

function connectionObject(items: ConnectionItem[], first: number | undefined, after: unknown, connectionType: string, edgeType: string): TypedObject {
  const afterSeq = seqFromCursor(after);
  const filtered = afterSeq === null ? items : items.filter((item) => item.seq < afterSeq);
  // Items arrive newest-first (seq desc); cursors are per-item seqs.
  const take = first === undefined ? 30 : Math.max(0, first);
  const page = filtered.slice(0, take);
  const hasNextPage = filtered.length > page.length;
  const endCursor = page.length ? cursorFor('cursor', page[page.length - 1]?.seq ?? 0) : null;
  const startCursor = page.length ? cursorFor('cursor', page[0]?.seq ?? 0) : null;
  return wrap(connectionType, {
    nodes: page.map((item) => item.node),
    edges: page.map((item) => wrap(edgeType, { node: item.node, cursor: cursorFor('cursor', item.seq) })),
    pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: afterSeq !== null, startCursor, endCursor }),
    totalCount: items.length,
  });
}

function issueConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): TypedObject {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let issues = ctx.store.listIssues(repo, { state: 'all', direction });
  if (states) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const items: ConnectionItem[] = issues.map((issue) => ({ node: issueObject(ctx, repo, issue), seq: issue.seq }));
  return connectionObject(items, typeof args.first === 'number' ? args.first : undefined, args.after, 'IssueConnection', 'IssueEdge');
}

function pullConnection(ctx: ExecutorContext, repo: Repo, args: Record<string, unknown>): TypedObject {
  const pulls = ctx.store.listPulls(repo, typeof args.states === 'string' ? args.states : 'open');
  const items: ConnectionItem[] = pulls.map((pull) => ({ node: pullObject(ctx, repo, pull), seq: pull.seq }));
  return connectionObject(items, typeof args.first === 'number' ? args.first : undefined, args.after, 'PullRequestConnection', 'PullRequestEdge');
}

function filesConnection(ctx: ExecutorContext, repo: Repo, pull: PullRequest, args: Record<string, unknown>): TypedObject {
  const files = ctx.store.pullFiles(repo, pull);
  const take = typeof args.first === 'number' ? args.first : 30;
  const page = files.slice(0, take);
  const nodes = page.map((file) => wrap('PullRequestFile', { path: file.filename, filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes }));
  return wrap('PullRequestFileConnection', {
    nodes,
    edges: nodes.map((node, index) => wrap('PullRequestFileEdge', { node, cursor: cursorFor('file', index) })),
    pageInfo: wrap('PageInfo', { hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: nodes.length ? cursorFor('file', 0) : null, endCursor: nodes.length ? cursorFor('file', nodes.length - 1) : null }),
    totalCount: files.length,
  });
}

function resolveField(ctx: ExecutorContext, parentType: string, parent: TypedObject | null, field: string, args: Record<string, unknown>): ResolvedValue {
  const store = ctx.store;
  const viewer = store.identity.viewer;
  switch (parentType) {
    case 'Query': {
      if (field === 'viewer') return userObject(ctx, viewer.login);
      if (field === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        if (owner !== viewer.login) return null;
        const repo = store.getRepo(owner, name);
        return repo ? repoObject(ctx, repo) : null;
      }
      if (field === 'node') {
        const parsed = parseGid(typeof args.id === 'string' ? args.id : '');
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const [owner, name] = parsed.key.split('/');
          if (!owner || !name) return null;
          const repo = store.getRepo(owner, name);
          return repo ? repoObject(ctx, repo) : null;
        }
        if (parsed.kind === 'Issue') {
          const key = splitGidKey(parsed.key);
          const repo = key ? store.getRepo(key.owner, key.name) : undefined;
          const issue = repo && key ? store.getIssue(repo, Number.parseInt(key.rest[0] ?? '', 10)) : undefined;
          return repo && issue ? issueObject(ctx, repo, issue) : null;
        }
        if (parsed.kind === 'PullRequest') {
          const key = splitGidKey(parsed.key);
          const repo = key ? store.getRepo(key.owner, key.name) : undefined;
          const pull = repo && key ? store.getPull(repo, Number.parseInt(key.rest[0] ?? '', 10)) : undefined;
          return repo && pull ? pullObject(ctx, repo, pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        if (name === 'SearchType') {
          return wrap('__Type', { name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES.map((value) => wrap('__EnumValue', { name: value })) });
        }
        const fields = INTROSPECTION_FIELDS[name];
        if (!fields) return null;
        return wrap('__Type', { name, kind: 'OBJECT', fields: fields.map((entry) => wrap('__Field', { name: entry })), enumValues: [] });
      }
      if (field === '__schema') return wrap('__Schema', { types: [] });
      return null;
    }
    case 'Mutation': {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (field === 'createIssue') {
        const parsed = parseGid(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (!parsed || parsed.kind !== 'Repository') throw new GraphQLError('createIssue: repositoryId does not identify a repository');
        const [owner, name] = parsed.key.split('/');
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) throw new GraphQLError('createIssue: repository not found');
        const title = typeof input.title === 'string' ? input.title : '';
        if (!title) throw new GraphQLError('createIssue: title is required');
        const { issue, error } = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
        if (!issue) throw new GraphQLError(error ?? 'createIssue failed');
        return wrap('CreateIssuePayload', { issue: issueObject(ctx, repo, issue), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
      }
      if (field === 'closeIssue') {
        const parsed = parseGid(typeof input.issueId === 'string' ? input.issueId : '');
        if (!parsed || parsed.kind !== 'Issue') throw new GraphQLError('closeIssue: issueId does not identify an issue');
        const key = splitGidKey(parsed.key);
        const repo = key ? store.getRepo(key.owner, key.name) : undefined;
        const issue = repo && key ? store.getIssue(repo, Number.parseInt(key.rest[0] ?? '', 10)) : undefined;
        if (!repo || !issue) throw new GraphQLError('closeIssue: issue not found');
        const closed = store.patchIssue(repo, issue.number, { state: 'closed' });
        if (!closed) throw new GraphQLError('closeIssue: issue not found');
        return wrap('CloseIssuePayload', { issue: issueObject(ctx, repo, closed), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
      }
      if (field === 'createPullRequest') {
        const parsed = parseGid(typeof input.repositoryId === 'string' ? input.repositoryId : '');
        if (!parsed || parsed.kind !== 'Repository') throw new GraphQLError('createPullRequest: repositoryId does not identify a repository');
        const [owner, name] = parsed.key.split('/');
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        if (!repo) throw new GraphQLError('createPullRequest: repository not found');
        const head = typeof input.headRefName === 'string' ? input.headRefName : '';
        const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
        const title = typeof input.title === 'string' ? input.title : '';
        if (!head || !base || !title) throw new GraphQLError('createPullRequest: headRefName, baseRefName and title are required');
        const { pull, error } = store.createPull(repo, { head, base, title, body: typeof input.body === 'string' ? input.body : '' });
        if (!pull) throw new GraphQLError(error ?? 'createPullRequest failed');
        return wrap('CreatePullRequestPayload', { pullRequest: pullObject(ctx, repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
      }
      if (field === 'mergePullRequest') {
        const parsed = parseGid(typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
        if (!parsed || parsed.kind !== 'PullRequest') throw new GraphQLError('mergePullRequest: pullRequestId does not identify a pull request');
        const key = splitGidKey(parsed.key);
        const repo = key ? store.getRepo(key.owner, key.name) : undefined;
        const pull = repo && key ? store.getPull(repo, Number.parseInt(key.rest[0] ?? '', 10)) : undefined;
        if (!repo || !pull) throw new GraphQLError('mergePullRequest: pull request not found');
        if (pull.merged || pull.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is already merged or closed');
        const method = input.mergeMethod === 'MERGE' ? 'merge' : input.mergeMethod === 'REBASE' ? 'rebase' : 'squash';
        const result = store.mergePull(repo, pull, method);
        if ('error' in result) throw new GraphQLError(result.error);
        return wrap('MergePullRequestPayload', { pullRequest: pullObject(ctx, repo, pull), clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null });
      }
      if (field === 'addComment') {
        const parsed = parseGid(typeof input.subjectId === 'string' ? input.subjectId : '');
        if (!parsed || parsed.kind !== 'Issue') throw new GraphQLError('addComment: subjectId does not identify an issue');
        const key = splitGidKey(parsed.key);
        const repo = key ? store.getRepo(key.owner, key.name) : undefined;
        const issue = repo && key ? store.getIssue(repo, Number.parseInt(key.rest[0] ?? '', 10)) : undefined;
        if (!repo || !issue) throw new GraphQLError('addComment: issue not found');
        const body = typeof input.body === 'string' ? input.body : '';
        if (!body) throw new GraphQLError('addComment: body is required');
        const comment = store.addComment(repo, issue.number, body);
        if (!comment) throw new GraphQLError('addComment: issue not found');
        const node = commentObject(ctx, repo, issue, comment);
        return wrap('AddCommentPayload', {
          commentEdge: wrap('IssueCommentEdge', { node, cursor: cursorFor('comment', comment.id) }),
          subject: issueObject(ctx, repo, issue),
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        });
      }
      return null;
    }
    default:
      break;
  }
  if (!parent) return null;
  const data = parent.data;
  switch (parentType) {
    case 'User': {
      if (field === 'login') return data.login;
      if (field === 'id') return data.id;
      if (field === 'databaseId') return data.databaseId;
      if (field === 'name') return data.name;
      if (field === 'email') return data.email;
      if (field === 'avatarUrl') return data.avatarUrl;
      if (field === 'url') return data.url;
      if (field === 'createdAt') return data.createdAt;
      return null;
    }
    case 'Repository': {
      const repo = data.repo as Repo;
      if (field === 'id') return gid('Repository', `${repo.owner}/${repo.name}`);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userObject(ctx, repo.owner);
      if (field === 'defaultBranchRef') {
        const tip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
        return tip ? wrap('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', target: tip }) : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'private') return repo.private;
      if (field === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field === 'createdAt' || field === 'updatedAt') return repo.createdAt;
      if (field === 'fork') return false;
      if (field === 'issue') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = store.getIssue(repo, number);
        return issue ? issueObject(ctx, repo, issue) : null;
      }
      if (field === 'issues') return issueConnection(ctx, repo, args);
      if (field === 'pullRequest') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = store.getPull(repo, number);
        return pull ? pullObject(ctx, repo, pull) : null;
      }
      if (field === 'pullRequests') return pullConnection(ctx, repo, args);
      return null;
    }
    case 'Issue': {
      const repo = data.repo as Repo;
      const issue = data.issue as Issue;
      if (field === 'id') return gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
      if (field === 'databaseId') return issue.id;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'body') return issue.body;
      if (field === 'state') return issueState(issue);
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'closedAt') return issue.state === 'closed' ? issue.updatedAt : null;
      if (field === 'author') return userObject(ctx, viewer.login);
      if (field === 'labels') return issue.labels.map((name) => wrap('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed', description: '' }));
      if (field === 'comments') {
        const items: ConnectionItem[] = issue.comments.map((comment) => ({ node: commentObject(ctx, repo, issue, comment), seq: comment.seq }));
        return connectionObject(items, typeof args.first === 'number' ? args.first : undefined, args.after, 'IssueCommentConnection', 'IssueCommentEdge');
      }
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'repository') return repoObject(ctx, repo);
      if (field === 'locked') return false;
      return null;
    }
    case 'PullRequest': {
      const repo = data.repo as Repo;
      const pull = data.pull as PullRequest;
      if (field === 'id') return gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
      if (field === 'databaseId') return pull.id;
      if (field === 'number') return pull.number;
      if (field === 'title') return pull.title;
      if (field === 'body') return pull.body;
      if (field === 'state') return pullState(pull);
      if (field === 'merged') return pull.merged;
      if (field === 'mergeable') return store.mergeable(repo, pull);
      if (field === 'headRefName') return pull.head;
      if (field === 'baseRefName') return pull.base;
      if (field === 'headRef') return wrap('Ref', { name: pull.head, prefix: 'refs/heads/', target: pull.headSha });
      if (field === 'baseRef') return wrap('Ref', { name: pull.base, prefix: 'refs/heads/', target: pull.baseSha });
      if (field === 'files') return filesConnection(ctx, repo, pull, args);
      if (field === 'createdAt') return pull.createdAt;
      if (field === 'updatedAt') return pull.updatedAt;
      if (field === 'mergedAt') return pull.mergedAt;
      if (field === 'mergeCommit') return pull.mergeCommitSha ? wrap('Commit', { oid: pull.mergeCommitSha, message: '' }) : null;
      if (field === 'author') return userObject(ctx, viewer.login);
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field === 'repository') return repoObject(ctx, repo);
      if (field === 'isDraft') return false;
      if (field === 'additions' || field === 'deletions' || field === 'changedFiles') {
        const files = store.pullFiles(repo, pull);
        if (field === 'additions') return files.reduce((sum, file) => sum + file.additions, 0);
        if (field === 'deletions') return files.reduce((sum, file) => sum + file.deletions, 0);
        return files.length;
      }
      return null;
    }
    case 'IssueComment': {
      const repo = data.repo as Repo;
      const issue = data.issue as Issue;
      const comment = data.comment as { id: number; body: string; createdAt: string };
      if (field === 'id') return gid('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`);
      if (field === 'databaseId') return comment.id;
      if (field === 'body') return comment.body;
      if (field === 'createdAt' || field === 'updatedAt') return comment.createdAt;
      if (field === 'author') return userObject(ctx, viewer.login);
      return null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'IssueCommentConnection': {
      if (field === 'nodes') return data.nodes;
      if (field === 'edges') return data.edges;
      if (field === 'pageInfo') return data.pageInfo;
      if (field === 'totalCount') return data.totalCount;
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'PullRequestFileEdge':
    case 'IssueCommentEdge': {
      if (field === 'node') return data.node;
      if (field === 'cursor') return data.cursor;
      return null;
    }
    case 'PullRequestFile': {
      if (field === 'path' || field === 'filename') return data.path;
      if (field === 'status') return data.status;
      if (field === 'additions') return data.additions;
      if (field === 'deletions') return data.deletions;
      if (field === 'changes') return data.changes;
      return null;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return data.hasNextPage;
      if (field === 'hasPreviousPage') return data.hasPreviousPage;
      if (field === 'startCursor') return data.startCursor;
      if (field === 'endCursor') return data.endCursor;
      return null;
    }
    case 'Ref': {
      if (field === 'name') return data.name;
      if (field === 'prefix') return data.prefix;
      if (field === 'target') return wrap('Commit', { oid: data.target, message: '' });
      return null;
    }
    case 'Commit': {
      if (field === 'oid') return data.oid;
      if (field === 'message') return data.message;
      return null;
    }
    case 'Label': {
      if (field === 'id') return data.id ?? gid('Label', String(data.name));
      if (field === 'name') return data.name;
      if (field === 'color') return data.color;
      if (field === 'description') return data.description;
      return null;
    }
    case '__Type': {
      if (field === 'name') return data.name;
      if (field === 'kind') return data.kind;
      if (field === 'fields') return data.fields;
      if (field === 'enumValues') return data.enumValues;
      return null;
    }
    case '__Field':
    case '__EnumValue': {
      if (field === 'name') return data.name;
      return null;
    }
    case '__Schema': {
      if (field === 'types') return data.types;
      return null;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return data.issue;
      if (field === 'clientMutationId') return data.clientMutationId;
      return null;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return data.pullRequest;
      if (field === 'clientMutationId') return data.clientMutationId;
      return null;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return data.commentEdge;
      if (field === 'subject') return data.subject;
      if (field === 'clientMutationId') return data.clientMutationId;
      return null;
    }
    default:
      return null;
  }
}

// --------------------------------------------------------------- validation
interface GqlError {
  message: string;
  path?: (string | number)[];
}

function validateSelections(
  selections: readonly SelectionNode[],
  parentType: string,
  fragments: Map<string, FragmentNode>,
  errors: GqlError[],
  path: (string | number)[],
): void {
  const fields = FIELD_TYPES[parentType];
  for (const selection of selections) {
    if (selection.kind === 'Field') {
      const responseKey = selection.alias ?? selection.name;
      if (selection.name === '__typename') {
        if (selection.selections) validateSelections(selection.selections, 'String', fragments, errors, [...path, responseKey]);
        continue;
      }
      if (!fields || !(selection.name in fields)) {
        errors.push({ message: `Cannot query field "${selection.name}" on type "${parentType}".`, path: [...path, responseKey] });
        continue;
      }
      if (selection.selections) {
        const returnType = (fields[selection.name] as string).replace(/[\[\]!]/g, '');
        if (!SCALARS.has(returnType)) {
          validateSelections(selection.selections, returnType, fragments, errors, [...path, responseKey]);
        }
      }
    } else if (selection.kind === 'InlineFragment') {
      const type = selection.typeCondition ?? parentType;
      if (selection.typeCondition && !(selection.typeCondition in FIELD_TYPES) && selection.typeCondition !== 'Node') {
        errors.push({ message: `Unknown type "${selection.typeCondition}".`, path });
        continue;
      }
      validateSelections(selection.selections, type, fragments, errors, path);
    } else {
      const fragment = fragments.get(selection.name);
      if (!fragment) {
        errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      validateSelections(fragment.selections, fragment.typeCondition, fragments, errors, path);
    }
  }
}

// --------------------------------------------------------------- execution
function executeSelections(
  ctx: ExecutorContext,
  selections: readonly SelectionNode[],
  parentType: string,
  parent: TypedObject | null,
  fragments: Map<string, FragmentNode>,
  variables: Record<string, unknown>,
  errors: GqlError[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = fragments.get(selection.name);
      if (!fragment) continue;
      Object.assign(out, executeSelections(ctx, fragment.selections, fragment.typeCondition, parent, fragments, variables, errors, path));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition && parent && parent.__typename !== selection.typeCondition) continue;
      const type = selection.typeCondition ?? parentType;
      Object.assign(out, executeSelections(ctx, selection.selections, type, parent, fragments, variables, errors, path));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    const fieldPath = [...path, responseKey];
    if (selection.name === '__typename') {
      out[responseKey] = parent ? parent.__typename : parentType;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = valueFromAst(arg.value, variables);
    let value: ResolvedValue;
    try {
      value = resolveField(ctx, parentType, parent, selection.name, args);
    } catch (error) {
      if (error instanceof GraphQLError) {
        errors.push({ message: error.message, path: fieldPath });
        out[responseKey] = null;
        continue;
      }
      throw error;
    }
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (!selection.selections) {
      out[responseKey] = isTyped(value) ? (value.data as Record<string, unknown>)[selection.name] ?? null : value;
      continue;
    }
    const returnType = (FIELD_TYPES[parentType]?.[selection.name] ?? 'String').replace(/[\[\]!]/g, '');
    if (Array.isArray(value)) {
      out[responseKey] = value.map((entry, index) => {
        if (entry === null || entry === undefined) return null;
        if (!isTyped(entry)) return entry;
        return executeSelections(ctx, selection.selections as SelectionNode[], entry.__typename, entry, fragments, variables, errors, [...fieldPath, index]);
      });
      continue;
    }
    if (isTyped(value)) {
      out[responseKey] = executeSelections(ctx, selection.selections, value.__typename, value, fragments, variables, errors, fieldPath);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeDocument(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors?: GqlError[] } {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation =
    document.operations.find((entry) => operationName !== undefined && entry.name === operationName) ??
    document.operations[0];
  if (!operation) return { data: null, errors: [{ message: 'No operation found in document' }] };
  const resolvedVariables: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variable.name in variables && variables[variable.name] !== undefined) {
      resolvedVariables[variable.name] = variables[variable.name];
    } else if (variable.defaultValue) {
      resolvedVariables[variable.name] = valueFromAst(variable.defaultValue, variables);
    }
  }
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const errors: GqlError[] = [];
  validateSelections(operation.selections, rootType, document.fragments, errors, []);
  if (errors.length) return { data: null, errors };
  const ctx: ExecutorContext = { store };
  const data = executeSelections(ctx, operation.selections, rootType, null, document.fragments, resolvedVariables, errors, []);
  if (errors.length) return { data, errors };
  return { data };
}

/** Execute one GraphQL HTTP body (a single operation or a batch array). */
export function executeGraphQL(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    const responses = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') {
        return { data: null, errors: [{ message: 'Batch entry must be an object with a query string' }] };
      }
      const operation = entry as Record<string, unknown>;
      if (typeof operation.query !== 'string') {
        return { data: null, errors: [{ message: 'Batch entry is missing a query string' }] };
      }
      return executeDocument(store, operation.query, (operation.variables ?? {}) as Record<string, unknown>, typeof operation.operationName === 'string' ? operation.operationName : undefined);
    });
    return { status: 200, body: responses };
  }
  if (body === null || typeof body !== 'object') {
    return { status: 200, body: { data: null, errors: [{ message: 'Request body must be a JSON object with a query string' }] } };
  }
  const operation = body as Record<string, unknown>;
  if (typeof operation.query !== 'string') {
    return { status: 200, body: { data: null, errors: [{ message: 'Request body is missing a query string' }] } };
  }
  return {
    status: 200,
    body: executeDocument(store, operation.query, (operation.variables ?? {}) as Record<string, unknown>, typeof operation.operationName === 'string' ? operation.operationName : undefined),
  };
}
