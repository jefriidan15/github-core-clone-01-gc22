// Shared pull-request helpers used by both the REST surface and GraphQL:
// file diffs, three-way merge, mergeability, and the squash merge itself.
import { VIEWER_EMAIL, VIEWER_NAME, nextCommitEpoch, nextIso } from './util.ts';
import type { Pull, Repo } from './store.ts';
import { buildCommit, mapToTree, mergeBase, parseCommit, storeObject, treeToMap } from './gitcore.ts';

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  const newCount = new Map<string, number>();
  for (const l of newLines) newCount.set(l, (newCount.get(l) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [l, n] of newCount) additions += Math.max(0, n - (oldCount.get(l) ?? 0));
  for (const [l, n] of oldCount) deletions += Math.max(0, n - (newCount.get(l) ?? 0));
  if (additions === 0 && deletions === 0 && oldText !== newText) {
    additions = 1;
    deletions = 1;
  }
  return { additions, deletions };
}

export function diffFiles(repo: Repo, baseTree: string, headTree: string): FileChange[] {
  const baseMap = treeToMap(repo, baseTree);
  const headMap = treeToMap(repo, headTree);
  const out: FileChange[] = [];
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    if (b && !h) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(oldText, '');
      out.push({ filename: path, status: 'removed', additions: 0, deletions: Math.max(1, d.deletions), changes: Math.max(1, d.deletions) });
    } else if (!b && h) {
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff('', newText);
      const additions = Math.max(newText === '' ? 0 : 1, d.additions);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && h && b.oid !== h.oid) {
      const oldText = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const d = lineDiff(oldText, newText);
      out.push({ filename: path, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions });
    }
  }
  return out;
}

export function diffFilesForPR(repo: Repo, pull: Pull): FileChange[] {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return [];
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return [];
  const baseTree = parseCommit((repo.objects.get(base) as { data: Buffer }).data).tree;
  const headTree = parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree;
  return diffFiles(repo, baseTree, headTree);
}

/** Three-way merge of baseTip with headTip over merge-base. Returns the merged
 * file map, or null when both sides changed the same path differently. */
export function threeWayMerge(
  repo: Repo,
  baseTip: string,
  headTip: string,
  mergeBaseOid: string,
): Map<string, { oid: string; mode: string }> | null {
  const baseMap = treeToMap(repo, parseCommit((repo.objects.get(mergeBaseOid) as { data: Buffer }).data).tree);
  const headMap = treeToMap(repo, parseCommit((repo.objects.get(headTip) as { data: Buffer }).data).tree);
  const targetMap = treeToMap(repo, parseCommit((repo.objects.get(baseTip) as { data: Buffer }).data).tree);
  const out = new Map(targetMap);
  const paths = new Set([...baseMap.keys(), ...headMap.keys(), ...targetMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path);
    const h = headMap.get(path);
    const t = targetMap.get(path);
    const same = (a?: { oid: string }, c?: { oid: string }): boolean => (a?.oid ?? null) === (c?.oid ?? null);
    if (same(h, b)) continue;
    if (same(t, b)) {
      if (h) out.set(path, h);
      else out.delete(path);
      continue;
    }
    if (same(h, t)) continue;
    return null;
  }
  return out;
}

export function pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return 'CONFLICTING';
  return threeWayMerge(repo, baseTip, headTip, base) === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** Squash-merge an open pull request onto its base branch. */
export function mergePullRequest(
  repo: Repo,
  pull: Pull,
): { ok: boolean; sha?: string; reason?: string } {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'Pull request is already merged or closed' };
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return { ok: false, reason: 'Not Found' };
  const base = mergeBase(repo, headTip, baseTip);
  if (base === null) return { ok: false, reason: 'Merge conflict' };
  const merged = threeWayMerge(repo, baseTip, headTip, base);
  if (merged === null) return { ok: false, reason: 'Merge conflict' };
  const treeOid = mapToTree(repo, merged);
  const epoch = nextCommitEpoch();
  const author = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  const commitData = buildCommit(treeOid, [baseTip], author, author, `${pull.title} (#${pull.number})`);
  const mergeOid = storeObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.base}`, mergeOid);
  repo.updated_at = nextIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.merged_at = nextIso();
  pull.merge_commit_sha = mergeOid;
  pull.updated_at = nextIso();
  return { ok: true, sha: mergeOid };
}
