// In-memory forge state and the operations shared by REST, GraphQL and MCP. The store is the
// single source of truth: git objects, refs, issues, pulls, labels. All timestamps come from a
// deterministic counter seeded by MAKEFUN_TRIAL_NOW (or the scenario epoch), never wall clock,
// so two runs that take the same calls produce byte-identical state.

import {
  buildCommit,
  buildTreeFromMap,
  flattenTree,
  hashObject,
  isObjectId,
  lineDiff,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
} from './gitobj.ts';
import { SCENARIO_EPOCH_SEC, type ScenarioIdentity } from './scenario.ts';

export interface IssueComment {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly seq: number;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  readonly seq: number;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeMethod: string | null;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  color: string;
  description: string;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  readonly seq: number;
  /** Bumped on every object/ref mutation; fetch responses are cached against it. */
  version: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  commitSeq: Map<string, number>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, Label>;
  nextNumber: number;
}

export type FileEntry = { oid: string; mode: string };

/** Opaque global id: base64url("<Kind>:<key>"). Never a bare database id or number. */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function parseGid(id: string): { kind: string; key: string } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const index = text.indexOf(':');
    if (index <= 0 || index === text.length - 1) return null;
    return { kind: text.slice(0, index), key: text.slice(index + 1) };
  } catch {
    return null;
  }
}

function envNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw) {
    const ms = Number(raw);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return SCENARIO_EPOCH_SEC;
}

export class Store {
  readonly identity: ScenarioIdentity;
  private reposByKey = new Map<string, Repo>();
  private clockCounter = 0;
  private readonly baseSec: number;
  private repoSeq = 0;
  private nextRepoId = 5000; // scenario's first repo id; ids then rise in creation order
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;
  private nextCommitCounter = 1;

  constructor(identity: ScenarioIdentity) {
    this.identity = identity;
    this.baseSec = envNowSec();
  }

  /** Deterministic clock: one second per call, from the fixed base. */
  tickSec(): number {
    const value = this.baseSec + this.clockCounter;
    this.clockCounter += 1;
    return value;
  }

  nowIso(): string {
    return new Date(this.tickSec() * 1000).toISOString();
  }

  authorLine(): string {
    const viewer = this.identity.viewer;
    return `${viewer.name} <${viewer.email}>`;
  }

  // ---------------------------------------------------------------- repos
  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(this.repoKey(owner, name));
  }

  listReposFor(owner: string): Repo[] {
    return [...this.reposByKey.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.seq - b.seq);
  }

  createRepo(
    owner: string,
    name: string,
    options: { description?: string; private?: boolean },
  ): { repo: Repo | null; error: string | null } {
    if (this.reposByKey.has(this.repoKey(owner, name))) {
      return { repo: null, error: `Repository ${owner}/${name} already exists` };
    }
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: this.nowIso(),
      seq: this.repoSeq,
      version: 0,
      objects: new Map(),
      refs: new Map(),
      commitSeq: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repoSeq += 1;
    this.reposByKey.set(this.repoKey(owner, name), repo);
    return { repo, error: null };
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.reposByKey.delete(this.repoKey(owner, name));
  }

  // ------------------------------------------------------------ git objects
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data: Buffer.from(data) });
      if (type === 'commit') repo.commitSeq.set(oid, this.nextCommitCounter);
      this.nextCommitCounter += 1;
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  createCommit(
    repo: Repo,
    fields: { tree: string; parents?: readonly string[]; message: string },
  ): string {
    const timestamp = this.tickSec();
    const author = this.authorLine();
    const data = buildCommit({ ...fields, author, committer: author, timestamp });
    return this.putObject(repo, 'commit', data);
  }

  buildTree(repo: Repo, flat: ReadonlyMap<string, FileEntry>): string {
    return buildTreeFromMap((type, data) => this.putObject(repo, type, data), flat);
  }

  flatten(repo: Repo, treeOid: string): Map<string, FileEntry> {
    return flattenTree((oid) => repo.objects.get(oid), treeOid);
  }

  getRef(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    if (repo.refs.get(ref) !== oid) {
      repo.refs.set(ref, oid);
      repo.version += 1;
    }
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const deleted = repo.refs.delete(ref);
    if (deleted) repo.version += 1;
    return deleted;
  }

  resolveRef(repo: Repo, ref: string): string | undefined {
    if (ref === 'HEAD') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (ref.startsWith('refs/')) return repo.refs.get(ref);
    return repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  }

  listBranches(repo: Repo): { name: string; sha: string }[] {
    const branches: { name: string; sha: string }[] = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return branches;
  }

  createBranch(repo: Repo, name: string, sha: string): { ok: boolean; error: string | null } {
    const ref = `refs/heads/${name}`;
    if (repo.refs.has(ref)) return { ok: false, error: `Reference ${ref} already exists` };
    if (!isObjectId(sha) || !repo.objects.has(sha)) return { ok: false, error: `Object ${sha} not found` };
    repo.refs.set(ref, sha);
    return { ok: true, error: null };
  }

  /** Commits reachable from `tip`, newest first (by creation order). */
  commitsFrom(repo: Repo, tip: string): { sha: string; commit: ReturnType<typeof parseCommit> }[] {
    const seen = new Set<string>();
    const stack: string[] = [tip];
    const found: string[] = [];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      found.push(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    found.sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
    return found.map((sha) => ({ sha, commit: parseCommit((repo.objects.get(sha) as GitObject).data) }));
  }

  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (!a || !b) return null;
    const ancestors = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    // Breadth-first from b, newest parents first: the first common ancestor is the best base.
    const seen = new Set<string>();
    const queue: string[] = [b];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (ancestors.has(oid)) return oid;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      parents.sort((x, y) => (repo.commitSeq.get(y) ?? 0) - (repo.commitSeq.get(x) ?? 0));
      for (const parent of parents) queue.push(parent);
    }
    return null;
  }

  /** 3-way merge of flattened trees. Returns null + conflicts when both sides changed a file. */
  threeWayMerge(
    base: ReadonlyMap<string, FileEntry>,
    ours: ReadonlyMap<string, FileEntry>,
    theirs: ReadonlyMap<string, FileEntry>,
  ): { merged: Map<string, FileEntry> | null; conflicts: string[] } {
    const merged = new Map<string, FileEntry>();
    const conflicts: string[] = [];
    const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const keyOf = (entry: FileEntry | undefined): string | null =>
      entry ? `${entry.mode}:${entry.oid}` : null;
    for (const key of keys) {
      const b = base.get(key);
      const o = ours.get(key);
      const t = theirs.get(key);
      if (keyOf(o) === keyOf(t)) {
        if (o) merged.set(key, o);
      } else if (keyOf(b) === keyOf(o)) {
        if (t) merged.set(key, t);
      } else if (keyOf(b) === keyOf(t)) {
        if (o) merged.set(key, o);
      } else {
        conflicts.push(key);
      }
    }
    return conflicts.length ? { merged: null, conflicts } : { merged, conflicts };
  }

  // -------------------------------------------------------------- contents
  /** The tree oid of the subtree at `path` ('' = the root tree itself). */
  subtreeOid(repo: Repo, rootTreeOid: string, path: string): string | null {
    if (path === '') return rootTreeOid;
    let current = rootTreeOid;
    for (const segment of path.split('/')) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  getFileAt(
    repo: Repo,
    ref: string,
    path: string,
  ): { kind: 'file'; entry: FileEntry } | { kind: 'dir'; entries: { name: string; path: string; entry: FileEntry; isDir: boolean }[] } | null {
    const tip = this.resolveRef(repo, ref);
    if (!tip) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const treeOid = parseCommit(object.data).tree;
    const flat = this.flatten(repo, treeOid);
    const file = flat.get(path);
    if (file) return { kind: 'file', entry: file };
    const prefix = path === '' ? '' : `${path}/`;
    const entries: { name: string; path: string; entry: FileEntry; isDir: boolean }[] = [];
    const seenDirs = new Set<string>();
    for (const [filePath, entry] of flat) {
      if (prefix !== '' && !filePath.startsWith(prefix)) continue;
      const rest = prefix === '' ? filePath : filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        entries.push({ name: rest, path: filePath, entry, isDir: false });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seenDirs.has(dirName)) {
          seenDirs.add(dirName);
          const dirPath = `${prefix}${dirName}`;
          const dirTreeOid = this.subtreeOid(repo, treeOid, dirPath) ?? ZERO_OID;
          entries.push({ name: dirName, path: dirPath, entry: { oid: dirTreeOid, mode: '40000' }, isDir: true });
        }
      }
    }
    if (entries.length === 0) return null;
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { kind: 'dir', entries };
  }

  /** Create or update a file on a branch; creates the branch from the default tip if unknown. */
  putFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const blobSha = this.putObject(repo, 'blob', content);
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let flat = new Map<string, FileEntry>();
    const parents: string[] = [];
    let created = false;
    if (tip) {
      const object = repo.objects.get(tip);
      if (object && object.type === 'commit') {
        flat = this.flatten(repo, parseCommit(object.data).tree);
        parents.push(tip);
      }
    } else if (branch !== repo.defaultBranch) {
      // Unknown branch: start from the default branch tip if one exists.
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip) {
        const object = repo.objects.get(defaultTip);
        if (object && object.type === 'commit') {
          flat = this.flatten(repo, parseCommit(object.data).tree);
          parents.push(defaultTip);
        }
      }
    }
    if (!flat.has(path)) created = true;
    flat.set(path, { oid: blobSha, mode: '100644' });
    const treeOid = this.buildTree(repo, flat);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha, created };
  }

  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (!tip) return null;
    const object = repo.objects.get(tip);
    if (!object || object.type !== 'commit') return null;
    const flat = this.flatten(repo, parseCommit(object.data).tree);
    if (!flat.has(path)) return null;
    flat.delete(path);
    const treeOid = this.buildTree(repo, flat);
    const commitSha = this.createCommit(repo, { tree: treeOid, parents: [tip], message });
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  // ---------------------------------------------------------------- labels
  createLabel(repo: Repo, name: string, color: string, description = ''): Label {
    const existing = repo.labels.get(name);
    if (existing) return existing;
    const label: Label = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    repo.labels.set(name, label);
    return label;
  }

  // ---------------------------------------------------------------- issues
  createIssue(
    repo: Repo,
    fields: { title: string; body?: string; labels?: string[] },
  ): { issue: Issue | null; error: string | null } {
    const labels = fields.labels ?? [];
    for (const name of labels) {
      if (!repo.labels.has(name)) return { issue: null, error: `Label "${name}" does not exist` };
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const createdAt = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: [...labels],
      createdAt,
      updatedAt: createdAt,
      seq: this.repoSeq,
      comments: [],
    };
    this.nextIssueId += 1;
    this.repoSeq += 1;
    repo.issues.set(number, issue);
    return { issue, error: null };
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string },
  ): Issue[] {
    const state = options.state ?? 'open';
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    const direction = options.direction ?? 'desc';
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
    return issues;
  }

  patchIssue(repo: Repo, number: number, fields: { state?: string; title?: string; body?: string }): Issue | null {
    const issue = repo.issues.get(number);
    if (!issue) return null;
    if (fields.state === 'open' || fields.state === 'closed') issue.state = fields.state;
    if (typeof fields.title === 'string') issue.title = fields.title;
    if (typeof fields.body === 'string') issue.body = fields.body;
    issue.updatedAt = this.nowIso();
    return issue;
  }

  addComment(repo: Repo, number: number, body: string): IssueComment | null {
    const issue = repo.issues.get(number);
    if (!issue) return null;
    const comment: IssueComment = { id: this.nextCommentId, body, createdAt: this.nowIso(), seq: this.repoSeq };
    this.nextCommentId += 1;
    this.repoSeq += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------- pulls
  createPull(
    repo: Repo,
    fields: { head: string; base: string; title: string; body?: string },
  ): { pull: PullRequest | null; error: string | null } {
    const headTip = repo.refs.get(`refs/heads/${fields.head}`);
    const baseTip = repo.refs.get(`refs/heads/${fields.base}`);
    if (!headTip) return { pull: null, error: `Head branch ${fields.head} not found` };
    if (!baseTip) return { pull: null, error: `Base branch ${fields.base} not found` };
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.head === fields.head && existing.base === fields.base) {
        return { pull: null, error: `A pull request already exists for ${fields.head} into ${fields.base}` };
      }
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const createdAt = this.nowIso();
    const pull: PullRequest = {
      id: this.nextIssueId,
      number,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      head: fields.head,
      base: fields.base,
      headSha: headTip,
      baseSha: baseTip,
      createdAt,
      updatedAt: createdAt,
      seq: this.repoSeq,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeMethod: null,
    };
    this.nextIssueId += 1;
    this.repoSeq += 1;
    repo.pulls.set(number, pull);
    return { pull, error: null };
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(repo: Repo, state?: string): PullRequest[] {
    const wanted = state ?? 'open';
    const pulls = [...repo.pulls.values()].filter((pull) => wanted === 'all' || pull.state === wanted);
    pulls.sort((a, b) => b.seq - a.seq);
    return pulls;
  }

  pullFiles(repo: Repo, pull: PullRequest): { filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }[] {
    const baseObject = pull.baseSha ? repo.objects.get(pull.baseSha) : undefined;
    const headObject = pull.headSha ? repo.objects.get(pull.headSha) : undefined;
    const baseFlat = baseObject && baseObject.type === 'commit' ? this.flatten(repo, parseCommit(baseObject.data).tree) : new Map<string, FileEntry>();
    const headFlat = headObject && headObject.type === 'commit' ? this.flatten(repo, parseCommit(headObject.data).tree) : new Map<string, FileEntry>();
    const files: { filename: string; status: 'added' | 'modified' | 'deleted'; additions: number; deletions: number; changes: number }[] = [];
    const keys = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const key of keys) {
      const b = baseFlat.get(key);
      const h = headFlat.get(key);
      if (b && h && b.oid === h.oid) continue;
      const oldText = b ? (repo.objects.get(b.oid)?.data.toString('utf8') ?? '') : '';
      const newText = h ? (repo.objects.get(h.oid)?.data.toString('utf8') ?? '') : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      files.push({
        filename: key,
        status: !b ? 'added' : !h ? 'deleted' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return files;
  }

  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.merged || pull.state !== 'open') return 'UNKNOWN';
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return 'UNKNOWN';
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseObject = base ? repo.objects.get(base) : undefined;
    const baseFlat = baseObject && baseObject.type === 'commit' ? this.flatten(repo, parseCommit(baseObject.data).tree) : new Map<string, FileEntry>();
    const oursObject = repo.objects.get(baseTip);
    const theirsObject = repo.objects.get(headTip);
    if (!oursObject || !theirsObject) return 'UNKNOWN';
    const oursFlat = this.flatten(repo, parseCommit(oursObject.data).tree);
    const theirsFlat = this.flatten(repo, parseCommit(theirsObject.data).tree);
    const { conflicts } = this.threeWayMerge(baseFlat, oursFlat, theirsFlat);
    return conflicts.length ? 'CONFLICTING' : 'MERGEABLE';
  }

  mergePull(
    repo: Repo,
    pull: PullRequest,
    method: 'squash' | 'merge' | 'rebase',
  ): { sha: string; message: string } | { error: string } {
    if (pull.merged || pull.state !== 'open') return { error: 'Pull request is already merged or closed' };
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    if (!baseTip || !headTip) return { error: 'Base or head branch not found' };
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseObject = base ? repo.objects.get(base) : undefined;
    const baseFlat = baseObject && baseObject.type === 'commit' ? this.flatten(repo, parseCommit(baseObject.data).tree) : new Map<string, FileEntry>();
    const oursObject = repo.objects.get(baseTip);
    const theirsObject = repo.objects.get(headTip);
    if (!oursObject || !theirsObject) return { error: 'Branch tip not found' };
    const oursFlat = this.flatten(repo, parseCommit(oursObject.data).tree);
    const theirsFlat = this.flatten(repo, parseCommit(theirsObject.data).tree);
    const { merged, conflicts } = this.threeWayMerge(baseFlat, oursFlat, theirsFlat);
    if (!merged) return { error: `Merge conflict in ${conflicts.join(', ')}` };
    const treeOid = this.buildTree(repo, merged);
    const message =
      method === 'squash'
        ? `${pull.title} (#${pull.number})`
        : `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const parents = method === 'merge' ? [baseTip, headTip] : [baseTip];
    const sha = this.createCommit(repo, { tree: treeOid, parents, message });
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.mergeMethod = method;
    pull.state = 'closed';
    pull.updatedAt = pull.mergedAt;
    return { sha, message };
  }
}

export { ZERO_OID };
