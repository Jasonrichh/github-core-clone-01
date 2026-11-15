// REST v3 (GitHub-compatible subset): repos, branches, commits, contents, labels, issues,
// pull requests. Every reply is JSON with a deterministic X-GitHub-Request-Id; unknown routes
// are JSON 404s; malformed JSON bodies are 400s; 4xx bodies carry a string message.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isObjectId } from './gitobj.ts';
import { gid, type Issue, type PullRequest, type Repo, type Store } from './store.ts';

export interface RestContext {
  store: Store;
  token: string;
  nextRequestId: () => string;
}

type JsonObject = Record<string, unknown>;

function sendJson(res: ServerResponse, ctx: RestContext, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': ctx.nextRequestId(),
    'X-Oauth-Scopes': 'repo, read:org',
    ...extra,
  });
  res.end(data);
}

function sendError(res: ServerResponse, ctx: RestContext, status: number, message: string): void {
  sendJson(res, ctx, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function paginate<T>(items: readonly T[], url: URL, origin: string): { page: T[]; link: string | null } {
  const params = url.searchParams;
  const perPageRaw = Number.parseInt(params.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const pageRaw = Number.parseInt(params.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const build = (p: number): string => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('page', String(p));
    nextParams.set('per_page', String(perPage));
    return `${origin}${url.pathname}?${nextParams.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${build(page - 1)}>; rel="prev"`);
  links.push(`<${build(1)}>; rel="first"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  return { page: slice, link: links.join(', ') };
}

function userJson(ctx: RestContext): JsonObject {
  const viewer = ctx.store.identity.viewer;
  return {
    login: viewer.login,
    id: viewer.id,
    node_id: gid('User', viewer.login),
    avatar_url: '',
    gravatar_id: '',
    url: `/api/v3/users/${viewer.login}`,
    html_url: `https://github.com/${viewer.login}`,
    type: 'User',
    site_admin: false,
    name: viewer.name,
    email: viewer.email,
    company: null,
    blog: '',
    location: null,
    bio: null,
    public_repos: ctx.store.listReposFor(viewer.login).length,
    followers: 0,
    following: 0,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function repoJson(ctx: RestContext, repo: Repo): JsonObject {
  const owner = ctx.store.identity.viewer;
  return {
    id: repo.id,
    node_id: gid('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: owner.id, node_id: gid('User', repo.owner), type: 'User', avatar_url: '' },
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
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
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, name: string): JsonObject {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: label ? gid('Label', `${repo.owner}/${repo.name}:${name}`) : '',
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? '',
    default: false,
  };
}

function issueJson(ctx: RestContext, repo: Repo, issue: Issue): JsonObject {
  const viewer = ctx.store.identity.viewer;
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: { login: viewer.login, id: viewer.id, node_id: gid('User', viewer.login), type: 'User' },
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
    state_reason: null,
  };
}

function commentJson(ctx: RestContext, repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): JsonObject {
  const viewer = ctx.store.identity.viewer;
  return {
    id: comment.id,
    node_id: gid('IssueComment', `${repo.owner}/${repo.name}:${issue.number}:${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: { login: viewer.login, id: viewer.id, node_id: gid('User', viewer.login), type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
  };
}

function pullJson(ctx: RestContext, repo: Repo, pull: PullRequest): JsonObject {
  const viewer = ctx.store.identity.viewer;
  const mergeable = pull.state === 'open' ? ctx.store.mergeable(repo, pull) === 'MERGEABLE' : null;
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: viewer.login, id: viewer.id, node_id: gid('User', viewer.login), type: 'User' },
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: pull.state === 'open' ? (mergeable ? 'clean' : 'dirty') : 'unknown',
    merged_by: pull.merged ? { login: viewer.login, id: viewer.id, type: 'User' } : null,
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      user: { login: viewer.login, id: viewer.id, type: 'User' },
      repo: repoJson(ctx, repo),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: { login: viewer.login, id: viewer.id, type: 'User' },
      repo: repoJson(ctx, repo),
    },
    draft: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function getRepoOr404(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== ctx.store.identity.viewer.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function parseBody(body: Buffer | null): { value: JsonObject; error: string | null } {
  if (!body || body.length === 0) return { value: {}, error: null };
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, error: 'Request body must be a JSON object' };
    }
    return { value: parsed as JsonObject, error: null };
  } catch {
    return { value: {}, error: 'Problems parsing JSON' };
  }
}

/** Route one REST request. Returns true when handled (all /api/v3/* paths are handled). */
export async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RestContext,
  url: URL,
  body: Buffer | null,
): Promise<boolean> {
  const store = ctx.store;
  const method = req.method ?? 'GET';
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const origin = originOf(req);

  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${ctx.token}`) {
    sendError(res, ctx, 401, 'Requires authentication');
    return true;
  }

  // GET /api/v3/
  if (rest.length === 0) {
    if (method !== 'GET') return sendError(res, ctx, 404, 'Not Found'), true;
    return sendJson(res, ctx, 200, {
      current_user_url: `${origin}/api/v3/user`,
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: `${origin}/api/v3/authorizations`,
      code_search_url: `${origin}/api/v3/search/code?q={query}`,
      commit_search_url: `${origin}/api/v3/search/commits?q={query}`,
      emails_url: `${origin}/api/v3/user/emails`,
      emojis_url: `${origin}/api/v3/emojis`,
      events_url: `${origin}/api/v3/events`,
      feeds_url: `${origin}/api/v3/feeds`,
      followers_url: `${origin}/api/v3/user/followers`,
      following_url: `${origin}/api/v3/user/following{/other_user}`,
      gists_url: `${origin}/api/v3/gists{/gist_id}`,
      hub_url: `${origin}/api/v3/hub`,
      issue_search_url: `${origin}/api/v3/search/issues?q={query}`,
      issues_url: `${origin}/api/v3/issues`,
      keys_url: `${origin}/api/v3/user/keys`,
      label_search_url: `${origin}/api/v3/search/labels?q={query}`,
      notifications_url: `${origin}/api/v3/notifications`,
      organization_url: `${origin}/api/v3/orgs/{org}`,
      organization_repositories_url: `${origin}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${origin}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${origin}/api/v3/gists/public`,
      rate_limit_url: `${origin}/api/v3/rate_limit`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${origin}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${origin}/api/v3/user/repos`,
      starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${origin}/api/v3/gists/starred`,
      user_url: `${origin}/api/v3/users/{user}`,
      user_organizations_url: `${origin}/api/v3/user/orgs`,
      user_repositories_url: `${origin}/api/v3/user/repos`,
      user_search_url: `${origin}/api/v3/search/users?q={query}`,
    }), true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return sendError(res, ctx, 404, 'Not Found'), true;
    return sendJson(res, ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_enterprise_version: 'github-core-clone 1.0.0' }), true;
  }

  // /api/v3/user...
  if (rest[0] === 'user') {
    if (rest.length === 1 && method === 'GET') return sendJson(res, ctx, 200, userJson(ctx)), true;
    if (rest.length === 2 && rest[1] === 'repos') {
      if (method === 'GET') {
        const repos = store.listReposFor(store.identity.viewer.login);
        const { page, link } = paginate(repos, url, origin);
        return sendJson(res, ctx, 200, page.map((repo) => repoJson(ctx, repo)), link ? { Link: link } : {}), true;
      }
      if (method === 'POST') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        const name = typeof value.name === 'string' ? value.name : '';
        if (!name || name.includes('/') || /[^A-Za-z0-9._-]/.test(name)) {
          return sendError(res, ctx, 422, 'Validation Failed: name is invalid'), true;
        }
        const { repo, error: createError } = store.createRepo(store.identity.viewer.login, name, {
          description: typeof value.description === 'string' ? value.description : '',
          private: value.private === true,
        });
        if (!repo) return sendError(res, ctx, 422, createError ?? 'Repository already exists'), true;
        return sendJson(res, ctx, 201, repoJson(ctx, repo)), true;
      }
    }
    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  // /api/v3/repos/:owner/:name...
  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1] as string);
    const name = decodeURIComponent(rest[2] as string);
    const repo = getRepoOr404(ctx, owner, name);
    if (!repo) return sendError(res, ctx, 404, 'Not Found'), true;
    const tail = rest.slice(3);

    // /repos/:o/:r
    if (tail.length === 0) {
      if (method === 'GET') return sendJson(res, ctx, 200, repoJson(ctx, repo)), true;
      if (method === 'PATCH') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        if (typeof value.description === 'string') repo.description = value.description;
        if (typeof value.private === 'boolean') repo.private = value.private;
        return sendJson(res, ctx, 200, repoJson(ctx, repo)), true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204, { 'X-GitHub-Request-Id': ctx.nextRequestId(), 'X-Oauth-Scopes': 'repo, read:org' });
        res.end();
        return true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    // /repos/:o/:r/branches[/:branch]
    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = store.listBranches(repo);
        const { page, link } = paginate(branches, url, origin);
        return sendJson(res, ctx, 200, page.map((branch) => ({ name: branch.name, commit: { sha: branch.sha, url: `/api/v3/repos/${owner}/${name}/commits/${branch.sha}` }, protected: false })), link ? { Link: link } : {}), true;
      }
      if (tail.length >= 2 && method === 'GET') {
        const branchName = tail.slice(1).map(decodeURIComponent).join('/');
        const tip = store.getRef(repo, `refs/heads/${branchName}`);
        if (!tip) return sendError(res, ctx, 404, 'Not Found'), true;
        return sendJson(res, ctx, 200, { name: branchName, commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` }, protected: false }), true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    // /repos/:o/:r/commits
    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      let tip = store.resolveRef(repo, ref);
      if (!tip && isObjectId(ref)) {
        const object = store.getObject(repo, ref);
        if (object && object.type === 'commit') tip = ref;
      }
      if (!tip) return sendError(res, ctx, 404, 'Not Found'), true;
      const commits = store.commitsFrom(repo, tip).map(({ sha, commit }) => ({
        sha,
        node_id: gid('Commit', `${owner}/${name}:${sha}`),
        commit: {
          message: commit.message,
          author: { name: commit.author, date: '' },
          committer: { name: commit.committer, date: '' },
        },
        author: { login: store.identity.viewer.login },
        committer: { login: store.identity.viewer.login },
        parents: commit.parents.map((parent) => ({ sha: parent })),
        url: `/api/v3/repos/${owner}/${name}/commits/${sha}`,
      }));
      const { page, link } = paginate(commits, url, origin);
      return sendJson(res, ctx, 200, page, link ? { Link: link } : {}), true;
    }

    // /repos/:o/:r/git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (tail.length === 2 && method === 'POST') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        const ref = typeof value.ref === 'string' ? value.ref : '';
        const sha = typeof value.sha === 'string' ? value.sha : '';
        if (!ref.startsWith('refs/') || !isObjectId(sha)) {
          return sendError(res, ctx, 422, 'Validation Failed: ref and sha are required'), true;
        }
        if (!store.getObject(repo, sha)) return sendError(res, ctx, 422, `Object ${sha} does not exist`), true;
        if (store.getRef(repo, ref)) return sendError(res, ctx, 422, `Reference ${ref} already exists`), true;
        store.setRef(repo, ref, sha);
        return sendJson(res, ctx, 201, { ref, node_id: gid('Ref', `${owner}/${name}:${ref}`), url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: store.getObject(repo, sha)?.type ?? 'commit', url: `/api/v3/repos/${owner}/${name}/git/${store.getObject(repo, sha)?.type ?? 'commit'}s/${sha}` } }), true;
      }
      if (tail.length >= 4 && tail[2] === 'heads' && method === 'GET') {
        const branchName = tail.slice(3).map(decodeURIComponent).join('/');
        const tip = store.getRef(repo, `refs/heads/${branchName}`);
        if (!tip) return sendError(res, ctx, 404, 'Not Found'), true;
        return sendJson(res, ctx, 200, { ref: `refs/heads/${branchName}`, node_id: gid('Ref', `${owner}/${name}:refs/heads/${branchName}`), url: `/api/v3/repos/${owner}/${name}/git/refs/heads/${branchName}`, object: { sha: tip, type: 'commit', url: `/api/v3/repos/${owner}/${name}/git/commits/${tip}` } }), true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    // /repos/:o/:r/contents/:path...
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map(decodeURIComponent).join('/');
      if (method === 'GET') {
        const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
        const found = store.getFileAt(repo, ref, path);
        if (!found) return sendError(res, ctx, 404, 'Not Found'), true;
        if (found.kind === 'file') {
          const blob = store.getObject(repo, found.entry.oid);
          const bytes = blob?.data ?? Buffer.alloc(0);
          return sendJson(res, ctx, 200, {
            type: 'file',
            encoding: 'base64',
            size: bytes.length,
            name: path.split('/').pop() ?? path,
            path,
            sha: found.entry.oid,
            content: bytes.toString('base64'),
            url: `/api/v3/repos/${owner}/${name}/contents/${path}`,
            html_url: `https://github.com/${owner}/${name}/blob/${ref}/${path}`,
            download_url: null,
            _links: { self: `/api/v3/repos/${owner}/${name}/contents/${path}`, git: `/api/v3/repos/${owner}/${name}/git/blobs/${found.entry.oid}`, html: `https://github.com/${owner}/${name}/blob/${ref}/${path}` },
          }), true;
        }
        return sendJson(res, ctx, 200, found.entries.map((entry) => ({
          type: entry.isDir ? 'dir' : 'file',
          size: entry.isDir ? 0 : (store.getObject(repo, entry.entry.oid)?.data.length ?? 0),
          name: entry.name,
          path: entry.path,
          sha: entry.entry.oid,
          url: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`,
          html_url: `https://github.com/${owner}/${name}/tree/${ref}/${entry.path}`,
          download_url: entry.isDir ? null : `/api/v3/repos/${owner}/${name}/contents/${entry.path}`,
          _links: { self: `/api/v3/repos/${owner}/${name}/contents/${entry.path}`, git: `/api/v3/repos/${owner}/${name}/git/${entry.isDir ? 'trees' : 'blobs'}/${entry.entry.oid}`, html: `https://github.com/${owner}/${name}/tree/${ref}/${entry.path}` },
        }))), true;
      }
      if (method === 'PUT') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        const message = typeof value.message === 'string' ? value.message : 'Update file';
        const contentB64 = typeof value.content === 'string' ? value.content : '';
        if (!contentB64) return sendError(res, ctx, 422, 'Validation Failed: content is required'), true;
        const branch = typeof value.branch === 'string' && value.branch ? value.branch : repo.defaultBranch;
        const content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
        if (typeof value.sha === 'string' && value.sha) {
          const current = store.getFileAt(repo, branch, path);
          if (!current || current.kind !== 'file' || current.entry.oid.toLowerCase() !== value.sha.toLowerCase()) {
            return sendError(res, ctx, 409, 'Conflict: sha does not match the current file'), true;
          }
        }
        const { commitSha, blobSha, created } = store.putFile(repo, branch, path, content, message);
        return sendJson(res, ctx, created ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, type: 'file', encoding: 'base64', url: `/api/v3/repos/${owner}/${name}/contents/${path}` },
          commit: { sha: commitSha, message, author: { name: store.identity.viewer.name, email: store.identity.viewer.email }, committer: { name: store.identity.viewer.name, email: store.identity.viewer.email } },
        }), true;
      }
      if (method === 'DELETE') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        const message = typeof value.message === 'string' ? value.message : 'Delete file';
        const branch = typeof value.branch === 'string' && value.branch ? value.branch : repo.defaultBranch;
        const deleted = store.deleteFile(repo, branch, path, message);
        if (!deleted) return sendError(res, ctx, 404, 'Not Found'), true;
        return sendJson(res, ctx, 200, { commit: { sha: deleted.commitSha, message } }), true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    // /repos/:o/:r/labels
    if (tail[0] === 'labels' && tail.length === 1 && method === 'POST') {
      const { value, error } = parseBody(body);
      if (error) return sendError(res, ctx, 400, error), true;
      const name = typeof value.name === 'string' ? value.name : '';
      const color = typeof value.color === 'string' ? value.color : 'ededed';
      if (!name) return sendError(res, ctx, 422, 'Validation Failed: name is required'), true;
      store.createLabel(repo, name, color, typeof value.description === 'string' ? value.description : '');
      return sendJson(res, ctx, 201, labelJson(repo, name)), true;
    }

    // /repos/:o/:r/issues[/:n[/comments]]
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const issues = store.listIssues(repo, {
            state: url.searchParams.get('state') ?? undefined,
            sort: url.searchParams.get('sort') ?? undefined,
            direction: url.searchParams.get('direction') ?? undefined,
          });
          const { page, link } = paginate(issues, url, origin);
          return sendJson(res, ctx, 200, page.map((issue) => issueJson(ctx, repo, issue)), link ? { Link: link } : {}), true;
        }
        if (method === 'POST') {
          const { value, error } = parseBody(body);
          if (error) return sendError(res, ctx, 400, error), true;
          const title = typeof value.title === 'string' ? value.title : '';
          if (!title) return sendError(res, ctx, 422, 'Validation Failed: title is required'), true;
          const labels = Array.isArray(value.labels) ? value.labels.filter((entry): entry is string => typeof entry === 'string') : [];
          const { issue, error: createError } = store.createIssue(repo, { title, body: typeof value.body === 'string' ? value.body : '', labels });
          if (!issue) return sendError(res, ctx, 422, createError ?? 'Validation Failed'), true;
          return sendJson(res, ctx, 201, issueJson(ctx, repo, issue)), true;
        }
        return sendError(res, ctx, 404, 'Not Found'), true;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(number)) return sendError(res, ctx, 404, 'Not Found'), true;
      const issue = store.getIssue(repo, number);
      if (!issue) return sendError(res, ctx, 404, 'Not Found'), true;
      if (tail.length === 2) {
        if (method === 'GET') return sendJson(res, ctx, 200, issueJson(ctx, repo, issue)), true;
        if (method === 'PATCH') {
          const { value, error } = parseBody(body);
          if (error) return sendError(res, ctx, 400, error), true;
          const patched = store.patchIssue(repo, number, {
            state: typeof value.state === 'string' ? value.state : undefined,
            title: typeof value.title === 'string' ? value.title : undefined,
            body: typeof value.body === 'string' ? value.body : undefined,
          });
          return sendJson(res, ctx, 200, issueJson(ctx, repo, patched as Issue)), true;
        }
        return sendError(res, ctx, 404, 'Not Found'), true;
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (method === 'GET') {
          const { page, link } = paginate(issue.comments, url, origin);
          return sendJson(res, ctx, 200, page.map((comment) => commentJson(ctx, repo, issue, comment)), link ? { Link: link } : {}), true;
        }
        if (method === 'POST') {
          const { value, error } = parseBody(body);
          if (error) return sendError(res, ctx, 400, error), true;
          const commentBody = typeof value.body === 'string' ? value.body : '';
          if (!commentBody) return sendError(res, ctx, 422, 'Validation Failed: body is required'), true;
          const comment = store.addComment(repo, number, commentBody);
          if (!comment) return sendError(res, ctx, 404, 'Not Found'), true;
          return sendJson(res, ctx, 201, commentJson(ctx, repo, issue, comment)), true;
        }
        return sendError(res, ctx, 404, 'Not Found'), true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    // /repos/:o/:r/pulls[/:n[/files|/merge]]
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'GET') {
          const pulls = store.listPulls(repo, url.searchParams.get('state') ?? undefined);
          const { page, link } = paginate(pulls, url, origin);
          return sendJson(res, ctx, 200, page.map((pull) => pullJson(ctx, repo, pull)), link ? { Link: link } : {}), true;
        }
        if (method === 'POST') {
          const { value, error } = parseBody(body);
          if (error) return sendError(res, ctx, 400, error), true;
          const head = typeof value.head === 'string' ? value.head : '';
          const base = typeof value.base === 'string' ? value.base : '';
          const title = typeof value.title === 'string' ? value.title : '';
          if (!head || !base || !title) return sendError(res, ctx, 422, 'Validation Failed: head, base and title are required'), true;
          const { pull, error: createError } = store.createPull(repo, { head, base, title, body: typeof value.body === 'string' ? value.body : '' });
          if (!pull) return sendError(res, ctx, 422, createError ?? 'Validation Failed'), true;
          return sendJson(res, ctx, 201, pullJson(ctx, repo, pull)), true;
        }
        return sendError(res, ctx, 404, 'Not Found'), true;
      }
      const number = Number.parseInt(tail[1] as string, 10);
      if (!Number.isInteger(number)) return sendError(res, ctx, 404, 'Not Found'), true;
      const pull = store.getPull(repo, number);
      if (!pull) return sendError(res, ctx, 404, 'Not Found'), true;
      if (tail.length === 2 && method === 'GET') return sendJson(res, ctx, 200, pullJson(ctx, repo, pull)), true;
      if (tail.length === 3 && tail[2] === 'files' && method === 'GET') {
        const files = store.pullFiles(repo, pull);
        const { page, link } = paginate(files, url, origin);
        return sendJson(res, ctx, 200, page, link ? { Link: link } : {}), true;
      }
      if (tail.length === 3 && tail[2] === 'merge' && method === 'PUT') {
        const { value, error } = parseBody(body);
        if (error) return sendError(res, ctx, 400, error), true;
        if (pull.merged || pull.state !== 'open') {
          return sendError(res, ctx, 405, 'Pull request has already been merged or closed'), true;
        }
        const methodName = value.merge_method === 'merge' ? 'merge' : value.merge_method === 'rebase' ? 'rebase' : 'squash';
        const result = store.mergePull(repo, pull, methodName);
        if ('error' in result) return sendError(res, ctx, 405, result.error), true;
        return sendJson(res, ctx, 200, { merged: true, sha: result.sha, message: result.message }), true;
      }
      return sendError(res, ctx, 404, 'Not Found'), true;
    }

    return sendError(res, ctx, 404, 'Not Found'), true;
  }

  return sendError(res, ctx, 404, 'Not Found'), true;
}
