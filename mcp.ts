// MCP (Model Context Protocol) over streamable HTTP at POST /mcp: JSON-RPC 2.0, plain JSON
// responses. Modern era (2026-07-28) via `server/discover`, legacy era via `initialize` +
// `notifications/initialized`. Stateless: no session ids are issued. Tools are the canonical
// github-mcp-server names; every tool result carries both a text block (JSON) and
// structuredContent so the suite can read either.

import { gid, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export const MCP_SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

export const MCP_SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

function tool(name: string, description: string, properties: Record<string, { type: string; description: string }>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

// One fixed array, built once: two tools/list calls answer byte-identical JSON.
export const MCP_TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a repository for the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request from a head branch into a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
    body: { type: 'string', description: 'The pull request body.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request with a squash commit.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('get_issue', 'Get one issue by number.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    issue_number: { type: 'number', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('list_pull_requests', 'List pull requests in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Pull request state filter: open, closed or all.' },
  }, ['owner', 'repo']),
]);

// ------------------------------------------------------------ result shapes
function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: store.identity.viewer.login, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ----------------------------------------------------------------- dispatch
type ToolResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function ownerRepo(store: Store, args: Record<string, unknown>): { repo: Repo | null; error: string | null } {
  let owner = asString(args.owner ?? args.owner_login);
  let name = asString(args.repo ?? args.repository);
  if ((!owner || !name) && typeof args.full_name === 'string') {
    const [fullOwner, fullName] = (args.full_name as string).split('/');
    owner = owner ?? fullOwner ?? null;
    name = name ?? fullName ?? null;
  }
  if (!owner || !name) return { repo: null, error: 'owner and repo are required' };
  if (owner !== store.identity.viewer.login) return { repo: null, error: `Repository ${owner}/${name} not found` };
  const repo = store.getRepo(owner, name) ?? null;
  return repo ? { repo, error: null } : { repo: null, error: `Repository ${owner}/${name} not found` };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const viewer = store.identity.viewer;
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name ?? args.repo ?? args.repository);
      if (!repoName) return { ok: false, message: 'Missing required argument: name' };
      const { repo, error } = store.createRepo(viewer.login, repoName, {
        description: asString(args.description) ?? '',
        private: args.private === true,
      });
      if (!repo) return { ok: false, message: error ?? 'Repository already exists' };
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'get_repo': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      return { ok: true, value: repoJson(store, repo) };
    }
    case 'create_issue': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const title = asString(args.title);
      if (!title) return { ok: false, message: 'Missing required argument: title' };
      const { issue, error: issueError } = store.createIssue(repo, {
        title,
        body: asString(args.body) ?? '',
      });
      if (!issue) return { ok: false, message: issueError ?? 'Could not create issue' };
      return { ok: true, value: issueJson(store, repo, issue) };
    }
    case 'list_issues': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const state = asString(args.state) ?? 'open';
      const issues = store.listIssues(repo, { state });
      return { ok: true, value: issues.map((issue) => issueJson(store, repo, issue)) };
    }
    case 'create_pull_request': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const title = asString(args.title);
      const head = asString(args.head ?? args.head_ref ?? args.head_branch);
      const base = asString(args.base ?? args.base_ref ?? args.base_branch);
      if (!title) return { ok: false, message: 'Missing required argument: title' };
      if (!head) return { ok: false, message: 'Missing required argument: head' };
      if (!base) return { ok: false, message: 'Missing required argument: base' };
      const { pull, error: pullError } = store.createPull(repo, { head, base, title, body: asString(args.body) ?? '' });
      if (!pull) return { ok: false, message: pullError ?? 'Could not create pull request' };
      return { ok: true, value: pullJson(store, repo, pull) };
    }
    case 'merge_pull_request': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const number = asNumber(args.pull_number ?? args.pull_request_number ?? args.number);
      if (number === null) return { ok: false, message: 'Missing required argument: pull_number' };
      const pull = store.getPull(repo, number);
      if (!pull) return { ok: false, message: `Pull request #${number} not found` };
      if (pull.merged || pull.state !== 'open') return { ok: false, message: 'Pull request is already merged or closed' };
      const result = store.mergePull(repo, pull, 'squash');
      if ('error' in result) return { ok: false, message: result.error };
      return { ok: true, value: { ...pullJson(store, repo, pull), merged: true, sha: result.sha, message: result.message } };
    }
    case 'get_issue': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const number = asNumber(args.issue_number ?? args.number);
      if (number === null) return { ok: false, message: 'Missing required argument: issue_number' };
      const issue = store.getIssue(repo, number);
      if (!issue) return { ok: false, message: `Issue #${number} not found` };
      return { ok: true, value: issueJson(store, repo, issue) };
    }
    case 'list_pull_requests': {
      const { repo, error } = ownerRepo(store, args);
      if (!repo) return { ok: false, message: error ?? 'Repository not found' };
      const state = asString(args.state) ?? 'open';
      const pulls = store.listPulls(repo, state);
      return { ok: true, value: pulls.map((pull) => pullJson(store, repo, pull)) };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// -------------------------------------------------------------- JSON-RPC
export interface McpOutcome {
  /** HTTP status for the response. */
  status: number;
  /** JSON body to send, or null for an empty (notification) response. */
  body: unknown;
}

function rpcResult(id: string | number | null, result: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): McpOutcome {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { status: 200, body: { jsonrpc: '2.0', id, error } };
}

/**
 * Execute one parsed JSON-RPC request body. The caller handles auth (401) and JSON
 * parsing (HTTP 400, -32700) before calling this; a notification (no id) answers 202 empty.
 */
export function executeMcp(store: Store, request: unknown): McpOutcome {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const req = request as Record<string, unknown>;
  const method = typeof req.method === 'string' ? req.method : '';
  const id = typeof req.id === 'string' || typeof req.id === 'number' ? req.id : null;
  const hasId = req.id !== undefined && req.id !== null;
  if (method.startsWith('notifications/')) return { status: 202, body: null };
  if (!hasId) return { status: 202, body: null };
  const params = (req.params ?? {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        supportedVersions: [...MCP_SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...MCP_SERVER_INFO } },
      });
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (offered && !MCP_SUPPORTED_VERSIONS.includes(offered)) {
        return rpcError(id, -32022, `Unsupported protocol version: ${offered}`, { supported: [...MCP_SUPPORTED_VERSIONS] });
      }
      return rpcResult(id, {
        protocolVersion: offered || MCP_SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { ...MCP_SERVER_INFO },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (!toolName) return rpcError(id, -32602, 'Invalid params: tools/call requires a tool name');
      const known = MCP_TOOLS.some((entry) => entry.name === toolName);
      if (!known) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
      const outcome = callTool(store, toolName, args);
      if (!outcome.ok) {
        return rpcResult(id, {
          content: [{ type: 'text', text: outcome.message }],
          isError: true,
        });
      }
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        structuredContent: outcome.value,
      });
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
