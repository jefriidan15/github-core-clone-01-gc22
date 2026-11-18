// GitHub GraphQL v4, hand-rolled: a tokenizer + recursive-descent parser for
// the documents the suite sends, and an executor over the same in-memory store
// the REST surface uses. No schema validation beyond what the checks need:
// unknown fields answer HTTP 200 with an `errors` array, unknown repositories
// answer `data.repository = null` with no errors.
import { b64decode, b64encode, isRecord, nextIso } from './util.ts';
import type { Issue, Pull, Repo } from './store.ts';
import { Store } from './store.ts';
import { diffFilesForPR, mergePullRequest, pullMergeable } from './rest-helpers.ts';

// ---- tokenizer -----------------------------------------------------------

type TokKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'var' | 'spread';
interface Tok {
  kind: TokKind;
  value: string;
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if (ch === '$') {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'var', value: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    if ('{}():![]=@'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === '"') out += '"';
          else if (esc === '\\') out += '\\';
          else if (esc === '/') out += '/';
          else if (esc === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      toks.push({ kind: raw.includes('.') || raw.includes('e') || raw.includes('E') ? 'float' : 'int', value: raw });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return toks;
}

// ---- AST -----------------------------------------------------------------

export interface FieldNode {
  alias?: string;
  name: string;
  args: Record<string, unknown>;
  children: FieldNode[];
  fragment?: string;
  typeCondition?: string;
}

export interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  varDefs: Record<string, unknown>;
  fields: FieldNode[];
}

export interface Document {
  operations: Operation[];
  fragments: Map<string, FieldNode[]>;
}

class Parser {
  private pos = 0;
  private toks: Tok[];
  constructor(toks: Tok[]) {
    this.toks = toks;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    this.pos += 1;
    return t;
  }

  private expect(value: string): Tok {
    const t = this.next();
    if (!t || t.value !== value) throw new Error(`expected ${value}, got ${t?.value ?? 'eof'}`);
    return t;
  }

  private expectName(): string {
    const t = this.next();
    if (!t || t.kind !== 'name') throw new Error(`expected name, got ${t?.value ?? 'eof'}`);
    return t.value;
  }

  parseDocument(): Document {
    const doc: Document = { operations: [], fragments: new Map() };
    while (this.peek()) {
      const t = this.peek() as Tok;
      if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        doc.operations.push(this.parseOperation());
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expect('on');
        const typeCond = this.expectName();
        void typeCond;
        doc.fragments.set(name, this.parseSelectionSet());
      } else if (t.kind === 'punct' && t.value === '{') {
        doc.operations.push({ kind: 'query', varDefs: {}, fields: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${t.value} at document level`);
      }
    }
    return doc;
  }

  private parseOperation(): Operation {
    const kind = this.next().value as 'query' | 'mutation';
    const op: Operation = { kind, varDefs: {}, fields: [] };
    const t = this.peek();
    if (t && t.kind === 'name') op.name = this.next().value;
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()?.value !== ')') {
        const varTok = this.next();
        if (!varTok || varTok.kind !== 'var') throw new Error(`expected variable, got ${varTok?.value ?? 'eof'}`);
        const varName = varTok.value;
        this.expect(':');
        // Type: a name, possibly wrapped in [] / ! — capture raw text loosely.
        let typeText = '';
        while (this.peek() && this.peek()?.value !== '=' && this.peek()?.value !== ',' && this.peek()?.value !== ')') {
          typeText += this.next().value;
        }
        void typeText;
        if (this.peek()?.value === '=') {
          this.next();
          op.varDefs[varName] = this.parseValue({});
        } else {
          op.varDefs[varName] = undefined;
        }
        if (this.peek()?.value === ',') this.next();
      }
      this.expect(')');
    }
    op.fields = this.parseSelectionSet();
    return op;
  }

  private parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek() && this.peek()?.value !== '}') {
      fields.push(this.parseField());
    }
    this.expect('}');
    return fields;
  }

  private parseField(): FieldNode {
    const t = this.peek() as Tok;
    if (t.kind === 'spread') {
      this.next();
      if (this.peek()?.kind === 'name' && this.peek()?.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { name: '', args: {}, children: this.parseSelectionSet(), fragment: '', typeCondition };
      }
      const name = this.expectName();
      return { name: '', args: {}, children: [], fragment: name };
    }
    let alias: string | undefined;
    let name = this.expectName();
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek()?.value === '(') {
      this.next();
      while (this.peek() && this.peek()?.value !== ')') {
        const argName = this.expectName();
        this.expect(':');
        args[argName] = this.parseValue({});
        if (this.peek()?.value === ',') this.next();
      }
      this.expect(')');
    }
    // Directives (@include/@skip): skip them.
    while (this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.value === '(') {
        this.next();
        let depth = 1;
        while (this.peek() && depth > 0) {
          const v = this.next().value;
          if (v === '(') depth += 1;
          else if (v === ')') depth -= 1;
        }
      }
    }
    const children = this.peek()?.value === '{' ? this.parseSelectionSet() : [];
    return { alias, name, args, children };
  }

  parseValue(vars: Record<string, unknown>): unknown {
    const t = this.next();
    if (!t) throw new Error('unexpected end of value');
    if (t.kind === 'var') return { __var: t.value };
    if (t.kind === 'string') return t.value;
    if (t.kind === 'int') return parseInt(t.value, 10);
    if (t.kind === 'float') return parseFloat(t.value);
    if (t.kind === 'name') {
      if (t.value === 'true') return true;
      if (t.value === 'false') return false;
      if (t.value === 'null') return null;
      return { __enum: t.value };
    }
    if (t.value === '[') {
      const list: unknown[] = [];
      while (this.peek() && this.peek()?.value !== ']') {
        list.push(this.parseValue(vars));
        if (this.peek()?.value === ',') this.next();
      }
      this.expect(']');
      return list;
    }
    if (t.value === '{') {
      const obj: Record<string, unknown> = {};
      while (this.peek() && this.peek()?.value !== '}') {
        const key = this.expectName();
        this.expect(':');
        obj[key] = this.parseValue(vars);
        if (this.peek()?.value === ',') this.next();
      }
      this.expect('}');
      return obj;
    }
    throw new Error(`unexpected value token ${t.value}`);
  }
}

export function parseDocument(src: string): Document {
  return new Parser(tokenize(src)).parseDocument();
}

// ---- value resolution ----------------------------------------------------

export function resolveValue(v: unknown, vars: Record<string, unknown>): unknown {
  if (isRecord(v)) {
    if ('__var' in v) {
      const name = (v as { __var: string }).__var;
      return vars[name];
    }
    if ('__enum' in v) return (v as { __enum: string }).__enum;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveValue(val, vars);
    return out;
  }
  if (Array.isArray(v)) return v.map((x) => resolveValue(x, vars));
  return v;
}

export function resolveArgs(args: Record<string, unknown>, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[k] = resolveValue(v, vars);
  return out;
}

// ---- global ids ----------------------------------------------------------

export function encodeGlobalId(kind: string, payload: string): string {
  return b64encode(Buffer.from(`${kind}:${payload}`, 'utf8'));
}

export function decodeGlobalId(id: string): { kind: string; payload: string } | null {
  try {
    const text = b64decode(id).toString('utf8');
    const idx = text.indexOf(':');
    if (idx < 0) return null;
    return { kind: text.slice(0, idx), payload: text.slice(idx + 1) };
  } catch {
    return null;
  }
}

// ---- executor ------------------------------------------------------------

interface Ctx {
  store: Store;
  errors: Array<{ message: string }>;
  fragments: Map<string, FieldNode[]>;
  vars: Record<string, unknown>;
}

interface Obj {
  __typename: string;
  __value: unknown;
}

function wrap(typename: string, value: unknown): Obj {
  return { __typename: typename, __value: value };
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments', 'labels'];
const PR_FIELDS = ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'comments'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'url'];
const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
}

function prId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
}

function repoId(repo: Repo): string {
  return encodeGlobalId('Repository', `${repo.owner}/${repo.name}`);
}

function cursorFor(n: number): string {
  return b64encode(Buffer.from(`cursor:${n}`, 'utf8'));
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = b64decode(cursor).toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function pageInfoFor(nodes: Array<{ number: number }>, hasNext: boolean): Record<string, unknown> {
  return {
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: nodes.length > 0 ? cursorFor(nodes[0].number) : null,
    endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number) : null,
  };
}

function issueConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s)));
    list = list.filter((i) => want.has(issueState(i)));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'DESC' ? 'DESC' : 'ASC';
  list.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  if (typeof args.after === 'string') {
    const n = cursorNumber(args.after);
    if (n !== null) {
      list = list.filter((i) => (direction === 'DESC' ? i.number < n : i.number > n));
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const nodes = list.slice(0, first);
  const hasNext = list.length > nodes.length;
  return { nodes: nodes.map((i) => wrap('Issue', { repo, issue: i })), pageInfo: pageInfoFor(nodes, hasNext), totalCount: list.length };
}

function prConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s)));
    list = list.filter((p) => want.has(prState(p)));
  }
  list.sort((a, b) => b.number - a.number);
  if (typeof args.after === 'string') {
    const n = cursorNumber(args.after);
    if (n !== null) list = list.filter((p) => p.number < n);
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const nodes = list.slice(0, first);
  const hasNext = list.length > nodes.length;
  return { nodes: nodes.map((p) => wrap('PullRequest', { repo, pull: p })), pageInfo: pageInfoFor(nodes, hasNext), totalCount: list.length };
}

function expandFields(fields: FieldNode[], typename: string, ctx: Ctx): FieldNode[] {
  const out: FieldNode[] = [];
  for (const f of fields) {
    if (f.fragment) {
      const frag = ctx.fragments.get(f.fragment);
      if (frag) out.push(...expandFields(frag, typename, ctx));
      continue;
    }
    if (f.typeCondition) {
      if (f.typeCondition === typename) out.push(...expandFields(f.children, typename, ctx));
      continue;
    }
    out.push(f);
  }
  return out;
}

function resolveFields(typename: string, value: unknown, fields: FieldNode[], ctx: Ctx): Record<string, unknown> | null {
  const expanded = expandFields(fields, typename, ctx);
  const out: Record<string, unknown> = {};
  for (const field of expanded) {
    const key = field.alias ?? field.name;
    const args = resolveArgs(field.args, ctx.vars);
    const v = resolveField(typename, value, field.name, args, ctx);
    if (v === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typename}".` });
      out[key] = null;
      continue;
    }
    if (field.children.length > 0) {
      out[key] = resolveChildren(v, field.children, ctx);
    } else {
      out[key] = scalarValue(v);
    }
  }
  return out;
}

function scalarValue(v: unknown): unknown {
  if (v && typeof v === 'object' && '__typename' in (v as Record<string, unknown>)) {
    return null;
  }
  return v;
}

function resolveChildren(v: unknown, children: FieldNode[], ctx: Ctx): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    return v.map((item) => resolveChildren(item, children, ctx));
  }
  if (isRecord(v) && '__typename' in v) {
    const obj = v as unknown as Obj;
    return resolveFields(obj.__typename, obj.__value, children, ctx);
  }
  if (isRecord(v)) {
    // Plain object (a connection): each selected field resolves against its
    // own key, with that field's children as the sub-selection.
    const out: Record<string, unknown> = {};
    for (const f of expandFields(children, 'Connection', ctx)) {
      const key = f.alias ?? f.name;
      const val = (v as Record<string, unknown>)[f.name];
      if (val === undefined) {
        out[key] = null;
        continue;
      }
      if (Array.isArray(val)) {
        out[key] = val.map((item) => resolveChildren(item, f.children, ctx));
      } else if (isRecord(val) && '__typename' in val) {
        out[key] = resolveChildren(val, f.children, ctx);
      } else if (isRecord(val)) {
        const sub: Record<string, unknown> = {};
        for (const sf of expandFields(f.children, 'PageInfo', ctx)) {
          sub[sf.alias ?? sf.name] = (val as Record<string, unknown>)[sf.name] ?? null;
        }
        out[key] = sub;
      } else {
        out[key] = val;
      }
    }
    return out;
  }
  return v;
}

function resolveField(
  typename: string,
  value: unknown,
  name: string,
  args: Record<string, unknown>,
  ctx: Ctx,
): unknown {
  const store = ctx.store;
  switch (typename) {
    case 'Query': {
      if (name === 'viewer') return wrap('User', { login: 'adaiversen', id: 1000 });
      if (name === 'repository') {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        const repo = store.getRepo(owner, repoName);
        if (!repo || owner !== 'adaiversen') return null;
        return wrap('Repository', repo);
      }
      if (name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeGlobalId(args.id) : null;
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const [owner, repoName] = decoded.payload.split('/');
          const repo = store.getRepo(owner, repoName);
          return repo ? wrap('Repository', repo) : null;
        }
        if (decoded.kind === 'Issue' || decoded.kind === 'PullRequest') {
          const [ownerRepo, num] = decoded.payload.split(':');
          const [owner, repoName] = ownerRepo.split('/');
          const repo = store.getRepo(owner, repoName);
          if (!repo) return null;
          const n = parseInt(num, 10);
          if (decoded.kind === 'Issue') {
            const issue = repo.issues.find((i) => i.number === n);
            return issue ? wrap('Issue', { repo, issue }) : null;
          }
          const pull = repo.pulls.find((p) => p.number === n);
          return pull ? wrap('PullRequest', { repo, pull }) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        return wrap('__Type', typeName);
      }
      if (name === '__schema') return wrap('__Schema', {});
      return undefined;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        if (!decoded || decoded.kind !== 'Repository') return wrap('CreateIssuePayload', { issue: null });
        const [owner, repoName] = decoded.payload.split('/');
        const repo = store.getRepo(owner, repoName);
        if (!repo) return wrap('CreateIssuePayload', { issue: null });
        const title = typeof input.title === 'string' ? input.title : '';
        const now = nextIso();
        const issue: Issue = {
          id: store.nextIssueId(),
          number: repo.numSeq,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels: [],
          comments: [],
          seq: store.nextIssueId(),
          created_at: now,
          updated_at: now,
        };
        repo.numSeq += 1;
        repo.issues.push(issue);
        return wrap('CreateIssuePayload', { issue: wrap('Issue', { repo, issue }) });
      }
      if (name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        let found: { repo: Repo; issue: Issue } | null = null;
        if (decoded && decoded.kind === 'Issue') {
          const [ownerRepo, num] = decoded.payload.split(':');
          const [owner, repoName] = ownerRepo.split('/');
          const repo = store.getRepo(owner, repoName);
          const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
          if (repo && issue) found = { repo, issue };
        }
        if (found) {
          found.issue.state = 'closed';
          return wrap('CloseIssuePayload', { issue: wrap('Issue', found) });
        }
        return wrap('CloseIssuePayload', { issue: null });
      }
      if (name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
        if (!decoded || decoded.kind !== 'Repository') return wrap('CreatePullRequestPayload', { pullRequest: null });
        const [owner, repoName] = decoded.payload.split('/');
        const repo = store.getRepo(owner, repoName);
        if (!repo) return wrap('CreatePullRequestPayload', { pullRequest: null });
        const headRef = String(input.headRefName ?? '');
        const baseRef = String(input.baseRefName ?? '');
        if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
          return wrap('CreatePullRequestPayload', { pullRequest: null });
        }
        const now = nextIso();
        const pull: Pull = {
          id: store.nextIssueId(),
          number: repo.numSeq,
          title: typeof input.title === 'string' ? input.title : '',
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          merged_at: null,
          merge_commit_sha: null,
          head: headRef,
          base: baseRef,
          seq: store.nextIssueId(),
          created_at: now,
          updated_at: now,
        };
        repo.numSeq += 1;
        repo.pulls.push(pull);
        return wrap('CreatePullRequestPayload', { pullRequest: wrap('PullRequest', { repo, pull }) });
      }
      if (name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        let found: { repo: Repo; pull: Pull } | null = null;
        if (decoded && decoded.kind === 'PullRequest') {
          const [ownerRepo, num] = decoded.payload.split(':');
          const [owner, repoName] = ownerRepo.split('/');
          const repo = store.getRepo(owner, repoName);
          const pull = repo?.pulls.find((p) => p.number === parseInt(num, 10));
          if (repo && pull) found = { repo, pull };
        }
        if (found) {
          mergePullRequest(found.repo, found.pull);
          return wrap('MergePullRequestPayload', { pullRequest: wrap('PullRequest', found) });
        }
        return wrap('MergePullRequestPayload', { pullRequest: null });
      }
      if (name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        let found: { repo: Repo; issue: Issue } | null = null;
        if (decoded && decoded.kind === 'Issue') {
          const [ownerRepo, num] = decoded.payload.split(':');
          const [owner, repoName] = ownerRepo.split('/');
          const repo = store.getRepo(owner, repoName);
          const issue = repo?.issues.find((i) => i.number === parseInt(num, 10));
          if (repo && issue) found = { repo, issue };
        }
        if (found) {
          const now = nextIso();
          const comment = { id: store.nextCommentId(), body: typeof input.body === 'string' ? input.body : '', created_at: now, updated_at: now };
          found.issue.comments.push(comment);
          return wrap('AddCommentPayload', { commentEdge: { node: wrap('Comment', { repo: found.repo, issue: found.issue, comment }) } });
        }
        return wrap('AddCommentPayload', { commentEdge: null });
      }
      return undefined;
    }
    case 'User': {
      const user = value as { login: string; id: number };
      if (name === 'login') return user.login;
      if (name === 'id') return user.id;
      if (name === 'name') return user.login;
      return undefined;
    }
    case 'Repository': {
      const repo = value as Repo;
      switch (name) {
        case 'id': return repoId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'description': return repo.description;
        case 'owner': return wrap('User', { login: repo.owner, id: 1000 });
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip ? wrap('Ref', { name: repo.defaultBranch, target: tip }) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.created_at;
        case 'url': return `/${repo.owner}/${repo.name}`;
        case 'issue': {
          const n = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.find((i) => i.number === n);
          return issue ? wrap('Issue', { repo, issue }) : null;
        }
        case 'issues': return issueConnection(repo, args);
        case 'pullRequest': {
          const n = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.find((p) => p.number === n);
          return pull ? wrap('PullRequest', { repo, pull }) : null;
        }
        case 'pullRequests': return prConnection(repo, args);
        default: return undefined;
      }
    }
    case 'Issue': {
      const v = value as { repo: Repo; issue: Issue };
      switch (name) {
        case 'id': return issueId(v.repo, v.issue);
        case 'number': return v.issue.number;
        case 'title': return v.issue.title;
        case 'state': return issueState(v.issue);
        case 'body': return v.issue.body;
        case 'createdAt': return v.issue.created_at;
        case 'updatedAt': return v.issue.updated_at;
        case 'url': return `/${v.repo.owner}/${v.repo.name}/issues/${v.issue.number}`;
        case 'author': return wrap('User', { login: 'adaiversen', id: 1000 });
        case 'comments': return { nodes: v.issue.comments.map((c) => wrap('Comment', { repo: v.repo, issue: v.issue, comment: c })), pageInfo: pageInfoFor([], false), totalCount: v.issue.comments.length };
        case 'labels': return { nodes: v.issue.labels.map((l) => wrap('Label', { name: l })) };
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const v = value as { repo: Repo; pull: Pull };
      switch (name) {
        case 'id': return prId(v.repo, v.pull);
        case 'number': return v.pull.number;
        case 'title': return v.pull.title;
        case 'state': return prState(v.pull);
        case 'body': return v.pull.body;
        case 'headRefName': return v.pull.head;
        case 'baseRefName': return v.pull.base;
        case 'merged': return v.pull.merged;
        case 'mergeable': return pullMergeable(v.repo, v.pull);
        case 'createdAt': return v.pull.created_at;
        case 'updatedAt': return v.pull.updated_at;
        case 'url': return `/${v.repo.owner}/${v.repo.name}/pull/${v.pull.number}`;
        case 'author': return wrap('User', { login: 'adaiversen', id: 1000 });
        case 'files': {
          const files = diffFilesForPR(v.repo, v.pull);
          const first = typeof args.first === 'number' ? args.first : 30;
          const nodes = files.slice(0, first).map((f) => wrap('PullRequestFile', { path: f.filename }));
          return { nodes, pageInfo: pageInfoFor([], false), totalCount: files.length };
        }
        default: return undefined;
      }
    }
    case 'Ref': {
      const v = value as { name: string; target: string };
      if (name === 'name') return v.name;
      if (name === 'target') return wrap('Commit', { oid: v.target });
      return undefined;
    }
    case 'Commit': {
      const v = value as { oid: string };
      if (name === 'oid') return v.oid;
      return undefined;
    }
    case 'Comment': {
      const v = value as { comment: { id: number; body: string } };
      if (name === 'id') return encodeGlobalId('Comment', `comment:${v.comment.id}`);
      if (name === 'body') return v.comment.body;
      return undefined;
    }
    case 'Label': {
      const v = value as { name: string };
      if (name === 'name') return v.name;
      return undefined;
    }
    case 'PullRequestFile': {
      const v = value as { path: string };
      if (name === 'path') return v.path;
      return undefined;
    }
    case '__Type': {
      const typeName = value as string;
      if (name === 'name') return typeName;
      if (name === 'kind') return typeName === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const list = typeName === 'Issue' ? ISSUE_FIELDS : typeName === 'PullRequest' ? PR_FIELDS : typeName === 'Repository' ? REPO_FIELDS : [];
        return list.map((f) => wrap('__Field', { name: f }));
      }
      if (name === 'enumValues') {
        if (typeName !== 'SearchType') return [];
        return SEARCH_ENUM.map((e) => wrap('__EnumValue', { name: e }));
      }
      return undefined;
    }
    case '__Field': {
      const v = value as { name: string };
      if (name === 'name') return v.name;
      return undefined;
    }
    case '__EnumValue': {
      const v = value as { name: string };
      if (name === 'name') return v.name;
      return undefined;
    }
    case '__Schema': {
      return undefined;
    }
    case 'CreateIssuePayload': {
      const v = value as { issue: Obj | null };
      if (name === 'issue') return v.issue;
      return undefined;
    }
    case 'CloseIssuePayload': {
      const v = value as { issue: Obj | null };
      if (name === 'issue') return v.issue;
      return undefined;
    }
    case 'CreatePullRequestPayload': {
      const v = value as { pullRequest: Obj | null };
      if (name === 'pullRequest') return v.pullRequest;
      return undefined;
    }
    case 'MergePullRequestPayload': {
      const v = value as { pullRequest: Obj | null };
      if (name === 'pullRequest') return v.pullRequest;
      return undefined;
    }
    case 'AddCommentPayload': {
      const v = value as { commentEdge: { node: Obj } | null };
      if (name === 'commentEdge') return v.commentEdge;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Execute one GraphQL request body ({query, variables}) or a batch array. */
export function executeGraphQL(
  store: Store,
  body: unknown,
): Record<string, unknown> | Array<Record<string, unknown>> {
  const runOne = (req: unknown): Record<string, unknown> => {
    const errors: Array<{ message: string }> = [];
    if (!isRecord(req) || typeof req.query !== 'string') {
      return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
    }
    const vars = isRecord(req.variables) ? (req.variables as Record<string, unknown>) : {};
    let doc: Document;
    try {
      doc = parseDocument(req.query);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (doc.operations.length === 0) {
      return { data: null, errors: [{ message: 'No operation in GraphQL document' }] };
    }
    const op = doc.operations[0];
    const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
    const ctx: Ctx = { store, errors, fragments: doc.fragments, vars };
    const data = resolveFields(rootType, null, op.fields, ctx);
    const out: Record<string, unknown> = { data };
    if (errors.length > 0) out.errors = errors;
    return out;
  };
  if (Array.isArray(body)) return body.map(runOne);
  return runOne(body);
}
