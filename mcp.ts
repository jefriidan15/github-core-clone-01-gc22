// Model Context Protocol over Streamable HTTP (JSON-RPC 2.0), modern era
// 2026-07-28: `server/discover` carries the connection info (the client never
// calls legacy `initialize` when discover works, but it is supported too).
// Six tools, a fixed constant list, acting on the same store as REST.
import type { ServerResponse } from 'node:http';
import { isRecord, nextIso, sendJson } from './util.ts';
import type { Store } from './store.ts';
import { VIEWER_LOGIN } from './util.ts';
import { createIssueInRepo, createPullInRepo, issueJson, pullJson, repoJson } from './rest.ts';
import { mergePullRequest } from './rest-helpers.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

export const TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function required(args: Record<string, unknown>, names: string[]): string | null {
  for (const n of names) {
    if (args[n] === undefined || args[n] === null || args[n] === '') return n;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case 'create_repo': {
      const missing = required(args, ['name']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repoName = String(args.name);
      if (store.getRepo(VIEWER_LOGIN, repoName)) return errResult(`Repository already exists: ${repoName}`);
      const repo = store.createRepo(VIEWER_LOGIN, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      const now = nextIso();
      repo.created_at = now;
      repo.updated_at = now;
      return okResult(repoJson(repo));
    }
    case 'get_repo': {
      const missing = required(args, ['owner', 'repo']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errResult(`Repository not found: ${args.owner}/${args.repo}`);
      return okResult(repoJson(repo));
    }
    case 'create_issue': {
      const missing = required(args, ['owner', 'repo', 'title']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errResult(`Repository not found: ${args.owner}/${args.repo}`);
      const issue = createIssueInRepo(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return okResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const missing = required(args, ['owner', 'repo']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errResult(`Repository not found: ${args.owner}/${args.repo}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = repo.issues.filter((i) => (state === 'all' ? true : i.state === state));
      return okResult({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'create_pull_request': {
      const missing = required(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errResult(`Repository not found: ${args.owner}/${args.repo}`);
      const head = String(args.head);
      const base = String(args.base);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return errResult('Head or base branch does not exist');
      }
      const pull = createPullInRepo(store, repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return okResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const missing = required(args, ['owner', 'repo', 'pull_number']);
      if (missing) return errResult(`Missing required argument: ${missing}`);
      const repo = store.getRepo(String(args.owner), String(args.repo));
      if (!repo) return errResult(`Repository not found: ${args.owner}/${args.repo}`);
      const pull = repo.pulls.find((p) => p.number === Number(args.pull_number));
      if (!pull) return errResult(`Pull request not found: ${args.pull_number}`);
      const result = mergePullRequest(repo, pull);
      if (!result.ok) return errResult(result.reason ?? 'Merge failed');
      return okResult({ merged: true, sha: result.sha, number: pull.number, state: 'closed' });
    }
    default:
      return errResult(`Unknown tool: ${name}`);
  }
}

export function handleMcp(res: ServerResponse, store: Store, rawBody: Buffer): void {
  let body: unknown;
  try {
    body = rawBody.length === 0 ? null : JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body) || typeof body.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = body.id ?? null;
  const method = body.method as string;
  const params = isRecord(body.params) ? (body.params as Record<string, unknown>) : {};
  const reply = (result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result });
  const replyError = (code: number, message: string): void =>
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    res.writeHead(202);
    res.end();
    return;
  }
  if (method === 'server/discover') {
    reply({
      supportedVersions: [PROTOCOL_VERSION, '2025-11-25'],
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }
  if (method === 'initialize') {
    reply({
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'ping') {
    reply({});
    return;
  }
  if (method === 'tools/list') {
    reply({ tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    if (!TOOLS.some((t) => t.name === toolName)) {
      replyError(-32602, `Unknown tool: ${toolName}`);
      return;
    }
    const result = callTool(store, toolName, args);
    reply(result);
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}
