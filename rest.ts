// GitHub REST v3: repositories, branches, commits, contents, issues,
// comments, labels, pull requests, merges, git refs. All JSON, all
// authenticated by the caller (app.ts checks the token first).
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_LOGIN,
  VIEWER_NAME,
  b64decode,
  b64encode,
  isRecord,
  nextCommitEpoch,
  nextIso,
  sendErr,
  sendJson,
} from './util.ts';
import type { Issue, Label, Pull, Repo } from './store.ts';
import { Store } from './store.ts';
import { buildCommit, mapToTree, mergeBase, parseCommit, parseTree, storeObject, treeToMap } from './gitcore.ts';
import { diffFiles, mergePullRequest } from './rest-helpers.ts';

// ---- JSON shapes --------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `/${repo.owner}/${repo.name}`,
    url: base,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    git_url: `/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.local:${repo.owner}/${repo.name}.git`,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    size: repo.objects.size,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length + repo.pulls.filter((p) => p.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    license: null,
    visibility: repo.private ? 'private' : 'public',
    topics: [],
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels
    .map((n) => repo.labels.get(n))
    .filter((l): l is Label => l !== undefined)
    .map(labelJson);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? '';
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    draft: false,
    locked: false,
    head: { ref: pull.head, sha: headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${repo.owner}:${pull.base}` },
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    assignee: null,
    assignees: [],
    milestone: null,
    comments: 0,
    created_at: pull.created_at,
    updated_at: pull.updated_at,
    closed_at: pull.state === 'closed' ? pull.updated_at : null,
    html_url: `/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; created_at: string; updated_at: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: 1000, type: 'User' },
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
  };
}

export function createIssueInRepo(store: Store, repo: Repo, title: string, body: string, labels: string[]): Issue {
  const now = nextIso();
  const issue: Issue = {
    id: store.nextIssueId(),
    number: repo.numSeq,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: store.nextIssueId(),
    created_at: now,
    updated_at: now,
  };
  repo.numSeq += 1;
  repo.issues.push(issue);
  return issue;
}

export function createPullInRepo(store: Store, repo: Repo, title: string, body: string, head: string, base: string): Pull {
  const now = nextIso();
  const pull: Pull = {
    id: store.nextIssueId(),
    number: repo.numSeq,
    title,
    body,
    state: 'open',
    merged: false,
    merged_at: null,
    merge_commit_sha: null,
    head,
    base,
    seq: store.nextIssueId(),
    created_at: now,
    updated_at: now,
  };
  repo.numSeq += 1;
  repo.pulls.push(pull);
  return pull;
}

// ---- pagination ----------------------------------------------------------

interface Page {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): Page {
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], query: URLSearchParams): { items: T[]; hasNext: boolean; page: Page } {
  const page = pageParams(query);
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  return { items: slice, hasNext: start + page.perPage < items.length, page };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, hasNext: boolean, page: Page): Record<string, string> {
  if (!hasNext) return {};
  const host = req.headers.host ?? '127.0.0.1';
  const q = new URLSearchParams(query);
  q.set('page', String(page.page + 1));
  q.set('per_page', String(page.perPage));
  return { link: `<http://${host}${path}?${q.toString()}>; rel="next"` };
}

// ---- git helpers for contents / pulls ------------------------------------

function commitIdentity(): { author: string; committer: string } {
  const epoch = nextCommitEpoch();
  const line = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  return { author: line, committer: line };
}

function commitDate(data: Buffer): string {
  const info = parseCommit(data);
  const m = info.author.match(/(\d+) [+-]\d{4}$/);
  const epoch = m ? parseInt(m[1], 10) : 1700000000;
  return new Date(epoch * 1000).toISOString();
}

function resolveBranchTip(repo: Repo, ref: string | null): string | null {
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`) as string;
  if (repo.objects.has(ref)) return ref;
  return null;
}

/** Commit the given file map onto a branch (or start the repo). */
function commitFileMap(
  repo: Repo,
  branch: string,
  map: Map<string, { oid: string; mode: string }>,
  message: string,
): string {
  const treeOid = mapToTree(repo, map);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip ? [tip] : [];
  const { author, committer } = commitIdentity();
  const data = buildCommit(treeOid, parents, author, committer, message);
  const oid = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updated_at = nextIso();
  return oid;
}

// ---- the router ----------------------------------------------------------

export function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  path: string,
  query: URLSearchParams,
  body: unknown,
): boolean {
  const send = (status: number, obj: unknown, extra?: Record<string, string>): void => sendJson(res, status, obj, extra);
  const err = (status: number, message: string): void => sendErr(res, status, message);
  const segs = path.split('/').filter((s) => s !== '');

  // GET /api/v3/
  if (segs.length === 2 && req.method === 'GET') {
    send(200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segs.length === 3 && segs[2] === 'meta' && req.method === 'GET') {
    send(200, { installed_version: '1.0.0' });
    return true;
  }
  if (segs.length === 3 && segs[2] === 'user') {
    if (req.method === 'GET') {
      send(200, { login: VIEWER_LOGIN, id: 1000, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
      return true;
    }
    if (req.method === 'POST' && segs[3] === undefined) {
      // POST /api/v3/user/repos is handled below via segs[3] === 'repos'.
    }
  }
  // POST /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos' && req.method === 'POST') {
    const b = isRecord(body) ? body : {};
    const name = typeof b.name === 'string' ? b.name : '';
    if (!name) return err(422, 'name is required'), true;
    if (store.getRepo(VIEWER_LOGIN, name)) return err(422, 'Repository already exists'), true;
    const repo = store.createRepo(VIEWER_LOGIN, name, typeof b.description === 'string' ? b.description : '', b.private === true);
    const now = nextIso();
    repo.created_at = now;
    repo.updated_at = now;
    if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
    send(201, repoJson(repo));
    return true;
  }
  // GET /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos' && req.method === 'GET') {
    const all = store.listRepos(VIEWER_LOGIN);
    const { items, hasNext, page } = paginate(all, query);
    send(200, items.map(repoJson), linkHeader(req, path, query, hasNext, page));
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segs.length >= 4 && segs[2] === 'repos') {
    const owner = segs[3];
    const name = segs[4];
    const repo = store.getRepo(owner, name);
    if (!repo || owner !== VIEWER_LOGIN) {
      err(404, 'Not Found');
      return true;
    }
    const rest = segs.slice(5);
    // GET /repos/{o}/{r}
    if (rest.length === 0) {
      if (req.method === 'GET') {
        send(200, repoJson(repo));
        return true;
      }
      if (req.method === 'PATCH') {
        const b = isRecord(body) ? body : {};
        if (typeof b.description === 'string') repo.description = b.description;
        repo.updated_at = nextIso();
        send(200, repoJson(repo));
        return true;
      }
      if (req.method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204);
        res.end();
        return true;
      }
      return false;
    }
    const head = rest[0];
    // Branches
    if (head === 'branches') {
      if (rest.length === 1 && req.method === 'GET') {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, oid] of [...repo.refs.entries()].sort()) {
          if (!ref.startsWith('refs/heads/')) continue;
          branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
        }
        send(200, branches);
        return true;
      }
      if (rest.length === 2 && req.method === 'GET') {
        const oid = repo.refs.get(`refs/heads/${rest[1]}`);
        if (!oid) return err(404, 'Branch not found'), true;
        send(200, { name: rest[1], commit: { sha: oid }, protected: false });
        return true;
      }
      return false;
    }
    // Commits
    if (head === 'commits' && rest.length === 1 && req.method === 'GET') {
      const shaParam = query.get('sha');
      const tip = resolveBranchTip(repo, shaParam);
      if (!tip) return err(404, 'No commit found for SHA'), true;
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue: string[] = [tip];
      while (queue.length > 0 && out.length < 200) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        const info = parseCommit(obj.data);
        const authorLine = info.author;
        const am = authorLine.match(/^(.*) <([^>]*)> (\d+) [+-]\d{4}$/);
        const author = am ? { name: am[1], email: am[2], date: new Date(parseInt(am[3], 10) * 1000).toISOString() } : { name: VIEWER_NAME, email: VIEWER_EMAIL, date: commitDate(obj.data) };
        out.push({
          sha: oid,
          commit: { message: info.message, author, committer: author },
          parents: info.parents.map((p) => ({ sha: p })),
          url: `/api/v3/repos/${owner}/${name}/commits/${oid}`,
        });
        for (const p of info.parents) queue.push(p);
      }
      send(200, out);
      return true;
    }
    // Contents
    if (head === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const refParam = query.get('ref');
      if (req.method === 'GET') {
        const tip = resolveBranchTip(repo, refParam);
        if (!tip) return err(404, 'Not Found'), true;
        const treeOid = parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
        const map = treeToMap(repo, treeOid);
        if (contentPath === '') {
          const entries: Record<string, unknown>[] = [];
          const seenDirs = new Set<string>();
          for (const [p, v] of [...map.entries()].sort()) {
            const first = p.split('/')[0];
            if (p.includes('/')) {
              if (!seenDirs.has(first)) {
                seenDirs.add(first);
                const dirTree = dirTreeOid(repo, treeOid, first);
                entries.push({ type: 'dir', name: first, path: first, sha: dirTree ?? '' });
              }
            } else {
              entries.push({ type: 'file', name: p, path: p, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0 });
            }
          }
          send(200, entries);
          return true;
        }
        const file = map.get(contentPath);
        if (file) {
          const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
          send(200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
            content: b64encode(data),
            sha: file.oid,
          });
          return true;
        }
        const prefix = `${contentPath}/`;
        const entries: Record<string, unknown>[] = [];
        const seenDirs = new Set<string>();
        for (const [p, v] of [...map.entries()].sort()) {
          if (!p.startsWith(prefix)) continue;
          const restPath = p.slice(prefix.length);
          const first = restPath.split('/')[0];
          if (restPath.includes('/')) {
            if (!seenDirs.has(first)) {
              seenDirs.add(first);
              entries.push({ type: 'dir', name: first, path: `${contentPath}/${first}`, sha: '' });
            }
          } else {
            entries.push({ type: 'file', name: restPath, path: p, sha: v.oid, size: repo.objects.get(v.oid)?.data.length ?? 0 });
          }
        }
        if (entries.length === 0) return err(404, 'Not Found'), true;
        send(200, entries);
        return true;
      }
      if (req.method === 'PUT') {
        const b = isRecord(body) ? body : {};
        const message = typeof b.message === 'string' ? b.message : 'Update file';
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const content = typeof b.content === 'string' ? b64decode(b.content) : Buffer.alloc(0);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        const map = tip ? treeToMap(repo, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree) : new Map<string, { oid: string; mode: string }>();
        if (tip === undefined && repo.refs.size > 0) return err(404, 'Branch not found'), true;
        const existing = map.get(contentPath);
        const isUpdate = existing !== undefined;
        if (isUpdate && typeof b.sha === 'string' && b.sha !== existing.oid) {
          return err(409, 'sha does not match'), true;
        }
        const blobOid = storeObject(repo, 'blob', content);
        map.set(contentPath, { oid: blobOid, mode: '100644' });
        const commitOid = commitFileMap(repo, branch, map, message);
        send(isUpdate ? 200 : 201, {
          content: { name: contentPath.split('/').pop(), path: contentPath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: b64encode(content) },
          commit: { sha: commitOid, message },
        });
        return true;
      }
      if (req.method === 'DELETE') {
        const b = isRecord(body) ? body : {};
        const message = typeof b.message === 'string' ? b.message : 'Delete file';
        const branch = typeof b.branch === 'string' && b.branch ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) return err(404, 'Not Found'), true;
        const map = treeToMap(repo, parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree);
        const existing = map.get(contentPath);
        if (!existing) return err(404, 'Not Found'), true;
        if (typeof b.sha === 'string' && b.sha !== existing.oid) return err(409, 'sha does not match'), true;
        map.delete(contentPath);
        const commitOid = commitFileMap(repo, branch, map, message);
        send(200, { commit: { sha: commitOid, message } });
        return true;
      }
      return false;
    }
    // Labels
    if (head === 'labels') {
      if (req.method === 'GET' && rest.length === 1) {
        send(200, [...repo.labels.values()].map(labelJson));
        return true;
      }
      if (req.method === 'POST' && rest.length === 1) {
        const b = isRecord(body) ? body : {};
        const name = typeof b.name === 'string' ? b.name : '';
        if (!name) return err(422, 'name is required'), true;
        if (repo.labels.has(name)) return err(422, 'Label already exists'), true;
        const label: Label = {
          name,
          color: typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed',
          description: typeof b.description === 'string' ? b.description : '',
        };
        repo.labels.set(name, label);
        send(201, labelJson(label));
        return true;
      }
      return false;
    }
    // Issues
    if (head === 'issues') {
      if (rest.length === 1) {
        if (req.method === 'POST') {
          const b = isRecord(body) ? body : {};
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) return err(422, 'title is required'), true;
          const labelNames: string[] = Array.isArray(b.labels) ? b.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const ln of labelNames) {
            if (!repo.labels.has(ln)) return err(422, `Label '${ln}' does not exist`), true;
          }
          const issue = createIssueInRepo(store, repo, title, typeof b.body === 'string' ? b.body : '', labelNames);
          send(201, issueJson(repo, issue));
          return true;
        }
        if (req.method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
          const direction = query.get('direction') ?? 'desc';
          list = [...list].sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          const { items, hasNext, page } = paginate(list, query);
          send(200, items.map((i) => issueJson(repo, i)), linkHeader(req, path, query, hasNext, page));
          return true;
        }
        return false;
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return err(404, 'Not Found'), true;
      if (rest.length === 2) {
        if (req.method === 'GET') {
          send(200, issueJson(repo, issue));
          return true;
        }
        if (req.method === 'PATCH') {
          const b = isRecord(body) ? body : {};
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const names = b.labels.filter((x): x is string => typeof x === 'string');
            for (const ln of names) if (!repo.labels.has(ln)) return err(422, `Label '${ln}' does not exist`), true;
            issue.labels = names;
          }
          issue.updated_at = nextIso();
          send(200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (req.method === 'GET') {
          send(200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return true;
        }
        if (req.method === 'POST') {
          const b = isRecord(body) ? body : {};
          const bodyText = typeof b.body === 'string' ? b.body : '';
          if (!bodyText) return err(422, 'body is required'), true;
          const now = nextIso();
          const comment = { id: store.nextCommentId(), body: bodyText, created_at: now, updated_at: now };
          issue.comments.push(comment);
          issue.updated_at = nextIso();
          send(201, commentJson(repo, issue, comment));
          return true;
        }
        return false;
      }
      return false;
    }
    // Pull requests
    if (head === 'pulls') {
      if (rest.length === 1) {
        if (req.method === 'POST') {
          const b = isRecord(body) ? body : {};
          const title = typeof b.title === 'string' ? b.title : '';
          const headRef = typeof b.head === 'string' ? b.head : '';
          const baseRef = typeof b.base === 'string' ? b.base : '';
          if (!title || !headRef || !baseRef) return err(422, 'title, head and base are required'), true;
          if (!repo.refs.has(`refs/heads/${headRef}`) || !repo.refs.has(`refs/heads/${baseRef}`)) {
            return err(422, 'Head or base branch does not exist'), true;
          }
          const pull = createPullInRepo(store, repo, title, typeof b.body === 'string' ? b.body : '', headRef, baseRef);
          send(201, pullJson(repo, pull));
          return true;
        }
        if (req.method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = repo.pulls.filter((p) => (state === 'all' ? true : p.state === state));
          const direction = query.get('direction') ?? 'desc';
          list = [...list].sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          const { items, hasNext, page } = paginate(list, query);
          send(200, items.map((p) => pullJson(repo, p)), linkHeader(req, path, query, hasNext, page));
          return true;
        }
        return false;
      }
      const num = parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return err(404, 'Not Found'), true;
      if (rest.length === 2) {
        if (req.method === 'GET') {
          send(200, pullJson(repo, pull));
          return true;
        }
        if (req.method === 'PATCH') {
          const b = isRecord(body) ? body : {};
          if (typeof b.title === 'string') pull.title = b.title;
          if (typeof b.body === 'string') pull.body = b.body;
          if (b.state === 'open' || b.state === 'closed') pull.state = b.state;
          pull.updated_at = nextIso();
          send(200, pullJson(repo, pull));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'files' && req.method === 'GET') {
        const headTip = repo.refs.get(`refs/heads/${pull.head}`);
        const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
        if (!headTip || !baseTip) return err(404, 'Not Found'), true;
        const base = mergeBase(repo, headTip, baseTip);
        if (base === null) {
          send(200, []);
          return true;
        }
        const baseTree = parseCommit((repo.objects.get(base) as { data: Buffer }).data).tree;
        const headTree = parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree;
        const files = diffFiles(repo, baseTree, headTree).map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        }));
        send(200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && req.method === 'PUT') {
        const result = mergePullRequest(repo, pull);
        if (!result.ok) {
          const status = result.reason === 'Not Found' ? 404 : 405;
          return err(status, result.reason ?? 'Merge failed'), true;
        }
        send(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    // Git refs API
    if (head === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && req.method === 'POST') {
        const b = isRecord(body) ? body : {};
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !sha) return err(422, 'ref and sha are required'), true;
        if (repo.refs.has(ref)) return err(422, 'Reference already exists'), true;
        const obj = repo.objects.get(sha);
        if (!obj || obj.type !== 'commit') return err(422, 'Object does not exist'), true;
        repo.refs.set(ref, sha);
        send(201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (rest.length >= 4 && rest[2] === 'heads' && req.method === 'GET') {
        const branch = rest.slice(3).join('/');
        const oid = repo.refs.get(`refs/heads/${branch}`);
        if (!oid) return err(404, 'Not Found'), true;
        send(200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: 'commit' } });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

function dirTreeOid(repo: Repo, treeOid: string, dirName: string): string | null {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return null;
  for (const e of parseTree(obj.data)) {
    if (e.name === dirName && e.mode === '40000') return e.oid;
  }
  return null;
}
