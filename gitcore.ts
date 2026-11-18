// Git object model: commits, trees, tags, packs (v2), deltas, reachability,
// shallow/deepen fetch sets and three-way merge. Stdlib only.
import { inflateSync, deflateSync } from 'node:zlib';
import { gitObjectId, sha1Hex, ZERO_OID } from './util.ts';
import type { GitObj, ObjType, Repo } from './store.ts';

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const head = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(
  tree: string,
  parents: string[],
  author: string,
  committer: string,
  message: string,
): Buffer {
  let head = `tree ${tree}\n`;
  for (const p of parents) head += `parent ${p}\n`;
  head += `author ${author}\ncommitter ${committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(message, 'utf8')]);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp === -1 || nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(off, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = gitObjectId(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (!m) return null;
      cur = m[1];
      continue;
    }
    return null;
  }
  return null;
}

/** Flatten a tree into path -> {oid, mode} for files only. */
export function treeToMap(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build nested trees from a flat file map, storing every tree; returns root oid. */
export function mapToTree(repo: Repo, map: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, v] of map) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let child = node.dirs.get(parts[i]);
      if (!child) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1], v);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node.files) entries.push({ mode: v.mode, name, oid: v.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** All objects reachable from the given tips (commits/tags). */
export function reachableObjects(repo: Repo, tips: string[]): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...tips];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m);
      if (m) queue.push(m[1]);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) queue.push(e.oid);
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>([desc]);
  const queue: string[] = [desc];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === anc) return true;
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const depthA = new Map<string, number>();
  const qa: string[] = [a];
  depthA.set(a, 0);
  while (qa.length > 0) {
    const oid = qa.shift() as string;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!depthA.has(p)) {
        depthA.set(p, (depthA.get(oid) as number) + 1);
        qa.push(p);
      }
    }
  }
  const seenB = new Set<string>();
  const qb: string[] = [b];
  let best: string | null = null;
  let bestScore = Infinity;
  let depthB = 0;
  while (qb.length > 0) {
    const level: string[] = qb.splice(0);
    for (const oid of level) {
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (depthA.has(oid)) {
        const score = (depthA.get(oid) as number) + depthB;
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) qb.push(p);
      }
    }
    depthB += 1;
  }
  return best;
}

// ---- deltas and packs ----------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off];
      off += 1;
      out |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return out;
  };
  readVarint();
  const dstSize = readVarint();
  const parts: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off];
    off += 1;
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          cpOff |= delta[off] << (i * 8);
          off += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          cpSize |= delta[off] << (i * 8);
          off += 1;
        }
      }
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      parts.push(delta.subarray(off, off + op));
      total += op;
      off += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== dstSize || total !== dstSize) throw new Error('delta size mismatch');
  return out;
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

export function readPack(buf: Buffer): Map<string, PackEntry> {
  const out = new Map<string, PackEntry>();
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1Hex(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack trailer mismatch');
  let off = 12;
  interface Raw {
    typeNum: number;
    baseOid?: string;
    baseOff?: number;
    delta?: Buffer;
    data?: Buffer;
    oid?: string;
  }
  const raws: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const first = buf[off];
    off += 1;
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while (first & 0x80 || (buf[off - 1] & 0x80)) {
      const b = buf[off];
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const raw: Raw = { typeNum };
    if (typeNum === 6) {
      const b0 = buf[off];
      off += 1;
      let baseOff = b0 & 0x7f;
      let b = b0;
      while (b & 0x80) {
        b = buf[off];
        off += 1;
        baseOff = ((baseOff + 1) << 7) | (b & 0x7f);
      }
      raw.baseOff = start - baseOff;
    } else if (typeNum === 7) {
      raw.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    raw.data = Buffer.from(inflated.buffer.subarray(0, size));
    off += inflated.engine.bytesWritten;
    if (typeNum === 6 || typeNum === 7) {
      raw.delta = raw.data;
      raw.data = undefined;
    } else {
      const type = (['', 'commit', 'tree', 'blob', 'tag'][typeNum] ?? '') as ObjType;
      raw.oid = gitObjectId(type, raw.data as Buffer);
    }
    raws.push(raw);
    byOffset.set(start, raw);
  }
  // Resolve deltas (bases may be plain entries in this pack or already known).
  const resolve = (raw: Raw, seen: Set<Raw>): PackEntry => {
    if (raw.oid && raw.data && raw.typeNum !== 6 && raw.typeNum !== 7) {
      const type = (['', 'commit', 'tree', 'blob', 'tag'][raw.typeNum] ?? '') as ObjType;
      return { type, data: raw.data, oid: raw.oid };
    }
    if (seen.has(raw)) throw new Error('delta cycle');
    seen.add(raw);
    let base: PackEntry | null = null;
    if (raw.baseOff !== undefined) {
      const b = byOffset.get(raw.baseOff);
      if (!b) throw new Error('ofs-delta base missing');
      base = resolve(b, seen);
    } else if (raw.baseOid) {
      const b = raws.find((r) => r.oid === raw.baseOid);
      if (b) base = resolve(b, seen);
      else throw new Error('ref-delta base missing from pack');
    }
    if (!base) throw new Error('delta without base');
    const data = applyDelta(base.data, raw.delta as Buffer);
    const oid = gitObjectId(base.type, data);
    raw.oid = oid;
    raw.data = data;
    return { type: base.type, data, oid };
  };
  for (const raw of raws) {
    const entry = resolve(raw, new Set());
    out.set(entry.oid, entry);
  }
  return out;
}

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function writePack(objects: Map<string, GitObj>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid) as GitObj;
    const data = obj.data;
    const typeNum = TYPE_CODE[obj.type];
    let size = data.length;
    const headBytes: number[] = [];
    let first = (typeNum << 4) | (size & 0x0f);
    size >>= 4;
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---- fetch sets ----------------------------------------------------------

/** Depth-limited reachability from want commits.
 * depth = Infinity means the whole history. Returns the object set and the
 * shallow boundary commits (included commits whose parents were cut off). */
export function depthLimited(
  repo: Repo,
  wants: string[],
  depth: number,
): { objects: Set<string>; boundaries: string[] } {
  const objects = new Set<string>();
  const boundaries: string[] = [];
  const levelOf = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') objects.add(w);
    const commit = peelToCommit(repo, w);
    if (!commit) continue;
    if (!levelOf.has(commit)) {
      levelOf.set(commit, 0);
      queue.push(commit);
    }
  }
  const included: string[] = [];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const level = levelOf.get(oid) as number;
    if (level >= depth) continue;
    included.push(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!levelOf.has(p)) {
        levelOf.set(p, level + 1);
        queue.push(p);
      }
    }
  }
  for (const oid of included) {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    objects.add(oid);
    for (const o of reachableObjects(repo, [c.tree])) objects.add(o);
    if (Number.isFinite(depth)) {
      const cut = c.parents.some((p) => !included.includes(p));
      if (cut) boundaries.push(oid);
    }
  }
  return { objects, boundaries };
}

/** Objects the client already holds, given its have commits and its shallow
 * boundaries: traversal from a have stops at a shallow boundary (the client
 * holds the boundary commit and its tree, but not its parents). */
export function heldObjects(repo: Repo, haves: string[], shallow: string[]): Set<string> {
  const shallowSet = new Set(shallow.map((s) => peelToCommit(repo, s)).filter((x): x is string => x !== null));
  const held = new Set<string>();
  const queue: string[] = [];
  for (const h of haves) {
    const commit = peelToCommit(repo, h);
    if (commit) queue.push(commit);
  }
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    held.add(oid);
    for (const o of reachableObjects(repo, [parseCommit(obj.data).tree])) held.add(o);
    if (shallowSet.has(oid)) continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return held;
}

export { ZERO_OID };
