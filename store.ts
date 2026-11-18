// In-memory store: repositories, git objects, refs, issues, pull requests.
// Everything is deterministic: ids and numbers come from counters, never from
// randomness or the wall clock.
import { DEFAULT_BRANCH, VIEWER_LOGIN } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: string;
  base: string;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  created_at: string;
  updated_at: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  /** Shared issue + pull-request numbering, per repo, starting at 1. */
  numSeq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  repoSeq = 1;
  objSeq = 1;
  issueIdSeq = 1;
  commentSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, priv: boolean): Repo {
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description,
      private: priv,
      defaultBranch: DEFAULT_BRANCH,
      seq: this.repoSeq,
      created_at: '',
      updated_at: '',
      objects: new Map(),
      refs: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      numSeq: 1,
    };
    this.repoSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  nextIssueId(): number {
    const id = this.issueIdSeq;
    this.issueIdSeq += 1;
    return id;
  }

  nextCommentId(): number {
    const id = this.commentSeq;
    this.commentSeq += 1;
    return id;
  }
}

export const VIEWER = { login: VIEWER_LOGIN, id: 1000 };
