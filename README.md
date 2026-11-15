# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Jasonrichh/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Jasonrichh/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge, built for the
[make.fun bounty](https://make.fun/bounty/github-core-clone-01).
No UI, one process, no dependencies: it serves git smart HTTP, the REST v3
API, GraphQL v4 and MCP from its own in-memory store, using only the Node 22
standard library.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. There is nothing
to install: the program imports `node:http` and its own modules only.

The lifecycle (`main.ts`, unchanged from the starter):

1. **Bind an ephemeral port** with `server.listen(0)`. Never bind 8080.
2. **Register** it: `POST $MAKEFUN_ENV_URL/register` with `{"port": <port>}`.
3. **Poll** `GET $MAKEFUN_ENV_URL/done` until `{"done": true}`, then exit 0.
   `MAKEFUN_ENV_URL` unset means exit 1.

Every API call is presented with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`
(the same token is in the entry's environment); `/healthz` takes none.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}` boot probe |
| `GET /api/v3/` | API root, `X-Oauth-Scopes: repo, read:org` |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection and batching |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `initialize`, `server/discover`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack`, `git-receive-pack` (protocol v0 and v2, shallow fetch, thin packs) |
| anything else | 404 `{"message":"Not Found"}` |

## How it works

- **Store** (`store.ts`): repositories, refs, git objects, issues, pull
  requests, labels and comments live in memory, keyed deterministically.
  Dates come from `MAKEFUN_TRIAL_NOW` (or a fixed epoch plus a monotonic
  counter), so two runs on the same instance export byte-identical state.
- **Git objects** (`gitobj.ts`, `git.ts`): SHA-1 object model, pkt-line codec,
  pack read/write. Packs are plain objects (no deltas required); the reader
  resolves OFS/REF deltas sent by clients. Pack reading uses a small
  DEFLATE block-boundary scanner, so each object costs exactly one
  `inflateSync` instead of a binary search over the pack. Identical fetches
  against an unchanged repository are served from a small cache keyed by a
  per-repository version counter that bumps on every object/ref mutation.
- **GraphQL** (`graphql.ts`): a small general parser + executor against a
  hand-written schema, with opaque base64 global ids stable across reads.
- **MCP** (`mcp.ts`): the six `github-mcp-server` tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) plus `get_issue` and `list_pull_requests`.

## Local results

Against the kit's local runner (seed `6a09e667f3bcc909`):

- Conformance: **120/120** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15.
- Benchmarks (p50, local shared-CPU VM): push 515 ms, clone 122 ms,
  read 1531 ms, write 246 ms — perf column 152, total score **952/1000**.

## Layout

- `main.ts`: the lifecycle above. Keep it as it is.
- `app.ts`: the HTTP server and routing.
- `store.ts`: in-memory state and shared operations (repos, issues, pulls,
  merges, contents).
- `git.ts`: git smart HTTP, pkt-lines, packs, fetch planning, push handling.
- `gitobj.ts`: git object hashing, parsing and construction, line diffs.
- `rest.ts`: REST v3 handlers and JSON shapes.
- `graphql.ts`: GraphQL lexer, parser, validator and executor.
- `mcp.ts`: MCP JSON-RPC handlers and tool implementations.
- `scenario.ts`: the deterministic scenario generator (seeded names/users).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## License

MIT — see `LICENSE`.
