# github-core-clone-01-gc22

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/bounty/github-core-clone-01/jefriidan15/github-core-clone-01-gc22/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/bounty/github-core-clone-01/jefriidan15/github-core-clone-01-gc22/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge for the [make.fun bounty `github-core-clone-01`](https://make.fun/bounty/github-core-clone-01)
("Build a GitHub-compatible git forge", $500). One Node process, standard library only, no dependencies,
no git binary, no package manager, no outside service.

## What it implements

| Surface | Details |
| --- | --- |
| `GET /healthz` | `{"ok":true}` boot probe |
| `/{owner}/{repo}.git/...` | git smart HTTP: protocol v2 (`ls-refs`, `fetch`) and v0 (advertisement, fetch, `receive-pack`); SHA-1 packs with OFS/REF delta ingest, shallow + deepen fetch, fast-forward enforcement, sideband framing |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents (create/update/delete), issues, comments, labels, pull requests, files, squash merges with three-way merge + conflict detection, git refs |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, issues, pull requests, mutations (create/close issue, create/merge pull request, add comment), node ids, cursor pagination, introspection |
| `POST /mcp` | Model Context Protocol over streamable HTTP, era `2026-07-28` (`server/discover`, `initialize`, `tools/list`, `tools/call`): `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |

Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` on every surface except `/healthz`.
The viewer the token names is the fixed scenario viewer `adaiversen`. All timestamps and ids are
deterministic (counter-based, seeded from `MAKEFUN_TRIAL_NOW` when set), so two runs on the same
instance produce byte-identical state.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. `main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL`, polls `/done`, and
exits 0. There is nothing to install: the program imports `node:http`, `node:crypto`, `node:zlib`
and its own modules only.

## Layout

- `main.ts` — the entry/env lifecycle (kept from the kit starter).
- `app.ts` — the HTTP server, auth, routing.
- `gitproto.ts` — git smart-HTTP handlers (advertisements, ls-refs, fetch v2/v0, receive-pack).
- `gitcore.ts` — git object model, pack reader/writer, deltas, reachability, shallow sets, merge.
- `rest.ts` — REST v3 handlers; `rest-helpers.ts` — shared pull-request merge/diff.
- `graphql.ts` — GraphQL tokenizer, parser and executor.
- `mcp.ts` — MCP JSON-RPC handlers and the six tools.
- `store.ts` — the in-memory store; `util.ts` — hashing, pkt-lines, deterministic clock.

## End-to-end test evidence

Graded locally against the kit's own conformance suite (`sdk/run.ts`) on the build machine:

```
120/120 conformance checks passed
  git 30/30, repos 15/15, issues 15/15, pulls 20/20, protocol 5/5,
  graphql 20/20, mcp 15/15
score 843/1000 (feature 600 + agent 200 + perf 43)
```

Perf on the (heavily loaded) build VPS, `p50`: push 2527 ms / 200 ops, clone 775 ms / 50,
read 6431 ms / 2000, write 804 ms / 200. The trial runs on a quiet 2-CPU container, so the
same code is expected to run well inside the calibration references there.

Real `git` CLI end-to-end (git 2.43.0) against the running forge:

```
$ git clone http://127.0.0.1:18181/adaiversen/manual-e2e.git
warning: You appear to have cloned an empty repository.
$ echo "hello forge" > hello.txt && git add hello.txt && git commit -m "first commit"
$ git push origin main
 * [new branch]      main -> main
$ git clone http://127.0.0.1:18181/adaiversen/manual-e2e.git e2e2
$ cat e2e2/hello.txt
hello forge
```

The file is also readable back over the REST contents API (`GET /api/v3/repos/adaiversen/manual-e2e/contents/hello.txt`).

## License

MIT — see `LICENSE` (`SPDX-License-Identifier: MIT`).
