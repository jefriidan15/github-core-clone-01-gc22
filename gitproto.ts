// git smart HTTP: info/refs advertisements (v0 + v2), upload-pack (ls-refs,
// fetch v2 + v0), receive-pack (v0). Speaks exactly what the kit's git client
// negotiates: v2 when the request carries `Git-Protocol: version=2`, else v0.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULT_BRANCH, PKT_DELIM, PKT_FLUSH, ZERO_OID, parsePktLines, pktLine, sendText } from './util.ts';
import type { Repo } from './store.ts';
import { depthLimited, heldObjects, isAncestor, peelToCommit, readPack, writePack } from './gitcore.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
const RECEIVE_CAPS = `report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs except HEAD, sorted. */
function listRefs(repo: Repo): RefLine[] {
  const out: RefLine[] = [];
  for (const [name, oid] of repo.refs) {
    const entry: RefLine = { oid, name };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) entry.peeled = m[1];
    }
    out.push(entry);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function defaultTip(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter ofs-delta\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const tip = defaultTip(repo);
  const refs = listRefs(repo);
  if (tip === null && refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    if (tip !== null) parts.push(pktLine(`${tip} HEAD\0${caps}\n`));
    else parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    sendText(res, 400, 'unknown service', 'text/plain');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  res.writeHead(200, { 'content-type': `application/x-${service}-advertisement` });
  res.end(body);
}

// ---- sideband framing ----------------------------------------------------

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const data = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), data])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function sidebandReport(lines: string[]): Buffer {
  // The report-status stream inside band 1 is itself pkt-lined and must end
  // with its own flush inside the band-1 packet; the outer stream then ends
  // with a second flush. Without the inner flush real git reports the
  // remote end hung up.
  const inner = Buffer.concat([...lines.map((l) => pktLine(l)), PKT_FLUSH]);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
}

// ---- upload-pack: ls-refs (v2) -------------------------------------------

function handleLsRefs(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const parsed = parsePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let seenDelim = false;
  for (const line of parsed.lines) {
    const text = line.toString('utf8');
    if (line.length === 0) {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue;
    const t = text.replace(/\n$/, '');
    if (t === 'peel') peel = true;
    else if (t === 'symrefs') symrefs = true;
    else if (t === 'unborn') unborn = true;
    else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
  }
  const tip = defaultTip(repo);
  const refs = listRefs(repo);
  const out: Buffer[] = [];
  const keepHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
  if (tip === null && refs.length === 0) {
    // Unborn HEAD: the protocol-v2 form is `unborn HEAD symref-target:...`,
    // sent only when the client asked for unborn refs (real git does once
    // the server advertises ls-refs=unborn). A bare `<ZERO> HEAD` line makes
    // real git refuse to set up the clone.
    if (keepHead && unborn) {
      out.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  } else {
    if (tip !== null && keepHead) {
      out.push(pktLine(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
    for (const r of refs) {
      if (prefixes.length > 0 && !prefixes.some((p) => r.name.startsWith(p))) continue;
      let line = `${r.oid} ${r.name}`;
      if (peel && r.peeled) line += ` peeled:${r.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
  }
  out.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(out));
}

// ---- upload-pack: fetch --------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  depth: number | null;
}

function parseV2FetchArgs(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], depth: null };
  const parsed = parsePktLines(body);
  let seenDelim = false;
  for (const line of parsed.lines) {
    if (line.length === 0) {
      seenDelim = true;
      continue;
    }
    if (!seenDelim) continue;
    const t = line.toString('utf8').replace(/\n$/, '');
    if (t.startsWith('want ')) args.wants.push(t.slice(5).trim());
    else if (t.startsWith('have ')) args.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) args.shallows.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) args.depth = parseInt(t.slice(7), 10);
  }
  return args;
}

function parseV0FetchArgs(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], depth: null };
  // v0 is two sections: wants (+ shallow/deepen), flush, haves + done, flush.
  let pos = 0;
  let sec = 0;
  while (pos + 4 <= body.length) {
    const len = parseInt(body.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) {
      sec += 1;
      pos += 4;
      continue;
    }
    if (len === 1 || len === 2) {
      pos += 4;
      continue;
    }
    if (pos + len > body.length) break;
    const text = body.subarray(pos + 4, pos + len).toString('utf8').replace(/\n$/, '');
    if (sec === 0) {
      if (text.startsWith('want ')) {
        args.wants.push(text.slice(5).split(' ')[0]);
      } else if (text.startsWith('shallow ')) args.shallows.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) args.depth = parseInt(text.slice(7), 10);
    } else {
      if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    }
    pos += len;
  }
  return args;
}

/** Compute the fetch answer: acks, shallow boundaries, and the objects to send. */
function computeFetch(repo: Repo, args: FetchArgs): { acks: string[]; shallow: string[]; unshallow: string[]; pack: Buffer | null } {
  const depth = args.depth ?? Infinity;
  const { objects, boundaries } = depthLimited(repo, args.wants, depth);
  const held = heldObjects(repo, args.haves, args.shallows);
  const acks: string[] = [];
  for (const h of args.haves) {
    const hc = peelToCommit(repo, h);
    if (!hc) continue;
    const ok = args.wants.some((w) => {
      const wc = peelToCommit(repo, w);
      return wc !== null && (wc === hc || isAncestor(repo, hc, wc));
    });
    if (ok) acks.push(h);
  }
  const includedCommits = new Set([...objects].filter((o) => repo.objects.get(o)?.type === 'commit'));
  const unshallow: string[] = [];
  for (const s of args.shallows) {
    const sc = peelToCommit(repo, s);
    if (sc && includedCommits.has(sc) && !boundaries.includes(sc)) unshallow.push(sc);
  }
  const deliver = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  for (const oid of objects) {
    if (held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj) deliver.set(oid, obj);
  }
  // A fetch whose wants name nothing the store holds (real git wants the
  // ZERO oid for an unborn HEAD) is an empty-repo fetch: answer with a
  // packfile section carrying an empty pack. A fetch of real wants that are
  // already held answers with no packfile section at all.
  const wantsDead = args.wants.length > 0 && args.wants.every((w) => !repo.objects.has(w));
  const pack = deliver.size > 0 ? writePack(deliver) : wantsDead ? writePack(new Map()) : null;
  return { acks, shallow: boundaries, unshallow, pack };
}

function handleFetchV2(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const args = parseV2FetchArgs(body);
  const { acks, shallow, unshallow, pack } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  // Protocol v2: the acknowledgments section is only sent when the client
  // sent have lines. A fresh clone sends none, and real git then expects the
  // response to start at shallow-info or packfile.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (acks.length === 0) parts.push(pktLine('NAK\n'));
    else {
      for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_FLUSH);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_FLUSH);
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

function handleFetchV0(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const args = parseV0FetchArgs(body);
  const { acks, shallow, unshallow, pack } = computeFetch(repo, args);
  const parts: Buffer[] = [];
  if (acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const a of acks) parts.push(pktLine(`ACK ${a}\n`));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  if (pack !== null) parts.push(sidebandPack(pack));
  else parts.push(PKT_FLUSH);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(parts));
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): void {
  try {
    const parsed = parsePktLines(body);
    const first = parsed.lines.length > 0 ? parsed.lines[0].toString('utf8') : '';
    if (first.startsWith('command=ls-refs')) {
      handleLsRefs(req, res, repo, body);
      return;
    }
    if (first.startsWith('command=fetch')) {
      handleFetchV2(req, res, repo, body);
      return;
    }
    handleFetchV0(req, res, repo, body);
  } catch (err) {
    sendText(res, 400, `upload-pack error: ${err instanceof Error ? err.message : String(err)}`, 'text/plain');
  }
}

// ---- receive-pack (v0) ---------------------------------------------------

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): void {
  const sendReport = (lines: string[]): void => {
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
    res.end(sidebandReport(lines));
  };
  try {
    const parsed = parsePktLines(body);
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    for (const line of parsed.lines) {
      const text = line.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      const clean = nul >= 0 ? text.slice(0, nul) : text;
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    if (parsed.rest.length > 0) {
      const objects = readPack(parsed.rest);
      for (const [oid, entry] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, { type: entry.type, data: entry.data });
      }
    }
    const report: string[] = ['unpack ok\n'];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (!current) report.push(`ng ${cmd.ref} no such ref\n`);
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) report.push(`ng ${cmd.ref} old oid mismatch\n`);
        else {
          repo.refs.delete(cmd.ref);
          report.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) {
        report.push(`ng ${cmd.ref} missing object\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current) report.push(`ng ${cmd.ref} already exists\n`);
        else {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      // Update: must be a fast-forward.
      if (!current) report.push(`ng ${cmd.ref} no such ref\n`);
      else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} old oid mismatch\n`);
      else if (cmd.newOid !== cmd.oldOid && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
        report.push(`ng ${cmd.ref} non-fast-forward\n`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      }
    }
    sendReport(report);
  } catch (err) {
    sendReport([`unpack ${err instanceof Error ? err.message : String(err)}\n`]);
  }
}
