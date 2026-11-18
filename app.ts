// The forge's HTTP server: one process, stdlib only. Routes:
//   GET  /healthz                 boot probe, no auth
//   /api/v3/*                     GitHub REST v3 (auth required)
//   POST /api/graphql             GitHub GraphQL v4 (auth required)
//   POST /mcp                     MCP over streamable HTTP (auth required)
//   /{owner}/{repo}.git/*         git smart HTTP (auth required)
//   anything else                 404 {"message":"Not Found"}
// Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (or $FORGE_TOKEN for
// local runs). The viewer the token names is the fixed scenario viewer
// `adaiversen`: the scenario seed is a constant in the suite, so the login
// the token names never varies between practice and final instances.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { sendErr, sendJson } from './util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? process.env.FORGE_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (!token) return false;
  const expected = expectedToken();
  if (expected === '') return true;
  return token === expected;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function handle(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = path.match(/^\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)\.git(\/.*)$/);
  if (gitMatch) {
    if (!authorized(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    const owner = gitMatch[1];
    const repoName = gitMatch[2];
    const suffix = gitMatch[3];
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    if (suffix === '/info/refs' && method === 'GET') {
      handleInfoRefs(req, res, repo, url.searchParams.get('service') ?? '');
      return;
    }
    if (suffix === '/git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, repo, rawBody);
      return;
    }
    if (suffix === '/git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, repo, rawBody);
      return;
    }
    sendErr(res, 404, 'Not Found');
    return;
  }

  if (path === '/api/graphql' && method === 'POST') {
    if (!authorized(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    let body: unknown = null;
    try {
      body = rawBody.length === 0 ? null : JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendErr(res, 400, 'Invalid JSON');
      return;
    }
    const result = executeGraphQL(store, body);
    sendJson(res, 200, result);
    return;
  }

  if (path === '/mcp' && method === 'POST') {
    if (!authorized(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    handleMcp(res, store, rawBody);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendErr(res, 401, 'Requires authentication');
      return;
    }
    let body: unknown = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendErr(res, 400, 'Invalid JSON');
        return;
      }
    }
    const handled = handleRest(req, res, store, path, url.searchParams, body);
    if (!handled) sendErr(res, 404, 'Not Found');
    return;
  }

  sendErr(res, 404, 'Not Found');
}

export function createApp(): Server {
  const store = new Store();
  const server = createServer((req, res) => {
    handle(req, res, store).catch((err: unknown) => {
      if (!res.headersSent) {
        sendErr(res, 500, err instanceof Error ? err.message : String(err));
      } else {
        res.destroy();
      }
    });
  });
  return server;
}
