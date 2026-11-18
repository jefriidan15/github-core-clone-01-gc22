// Shared helpers: hashing, pkt-lines, deterministic clock, JSON replies.
// No wall clock or randomness anywhere in this file: every timestamp comes from
// a counter seeded by MAKEFUN_TRIAL_NOW (or a fixed base), so two runs on the
// same instance produce byte-identical state.
import { createHash } from 'node:crypto';
import type { ServerResponse } from 'node:http';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `<type> <size>\0<data>`. */
export function gitObjectId(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

export function b64encode(data: Buffer): string {
  return data.toString('base64');
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/\s+/g, ''), 'base64');
}

/** Deterministic clock: seconds since the trial's fixed base, one tick per call. */
let clockBase = 0;
let clockTick = 0;
export function initClock(): void {
  const trial = process.env.MAKEFUN_TRIAL_NOW;
  const base = trial ? Date.parse(trial) : Date.parse('2026-11-14T06:30:00Z');
  clockBase = Number.isFinite(base) ? Math.floor(base / 1000) : 1780000000;
}
initClock();

/** Next deterministic epoch second (monotonic, +1s per call). */
export function nextEpoch(): number {
  clockTick += 1;
  return clockBase + clockTick;
}

/** Next deterministic ISO timestamp. */
export function nextIso(): string {
  return new Date(nextEpoch() * 1000).toISOString();
}

/** Deterministic git commit timestamp (epoch seconds, counter-based). */
let commitTick = 0;
export function nextCommitEpoch(): number {
  commitTick += 1;
  return 1700000000 + commitTick;
}

let reqSeq = 0;
export function nextReqId(): string {
  reqSeq += 1;
  return `req-${reqSeq}`;
}

// ---- pkt-lines -----------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktParse {
  lines: Buffer[];
  rest: Buffer;
  /** True when the buffer ended cleanly (flush or end of input). */
  ok: boolean;
}

/** Parse pkt-lines until a flush (0000), a delim (0001) or end of input.
 * Delim and response-end (0002) are returned as zero-length marker lines
 * (delim) / skipped (response-end is never expected in a request). */
export function parsePktLines(buf: Buffer): PktParse {
  const lines: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) return { lines, rest: buf.subarray(off), ok: false };
    if (len === 0) return { lines, rest: buf.subarray(off + 4), ok: true };
    if (len === 1) {
      lines.push(Buffer.alloc(0));
      off += 4;
      continue;
    }
    if (len === 2) {
      off += 4;
      continue;
    }
    if (off + len > buf.length) return { lines, rest: buf.subarray(off), ok: false };
    lines.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return { lines, rest: buf.subarray(off), ok: off === buf.length };
}

// ---- HTTP replies --------------------------------------------------------

export function sendJson(
  res: ServerResponse,
  status: number,
  obj: unknown,
  extra?: Record<string, string>,
): void {
  const body = obj === null ? '' : JSON.stringify(obj);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': nextReqId(),
    ...extra,
  };
  res.writeHead(status, headers);
  res.end(body);
}

export function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendText(res: ServerResponse, status: number, text: string, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
