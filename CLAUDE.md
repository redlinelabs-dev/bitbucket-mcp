# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (Model Context Protocol) server for **Bitbucket Cloud**, published to npm as
`@redlinelabs/bitbucket-mcp`. It exposes ~31 tools covering the full PR lifecycle (browse, create,
edit, merge, decline, approve), comments (CRUD + resolve), PR tasks, build statuses, commits, and
branches. Tools are grouped into **toolsets** (`pulls`, `comments`, `tasks`, `branches`, `repos`)
that operators enable/disable via env to keep the model's context lean. It talks to the Bitbucket
REST API (`https://api.bitbucket.org/2.0`) over stdio via `@modelcontextprotocol/sdk`.

## Commands

```bash
npm run dev        # tsgo --watch (incremental compile)
npm run build      # rm -rf dist && tsgo  → dist/index.js (the published bin)
npm start          # node dist/index.js
npm run check      # tsgo --noEmit && oxlint && oxfmt --check  ← the full gate
npm run fix        # oxlint --fix && oxfmt   (auto-fix lint + format)
npm run lint       # oxlint           (lint:fix to auto-fix)
npm run fmt        # oxfmt            (fmt:check to verify only)
```

`npm run check` is the source of truth for "is this correct" — it is what the pre-commit hook and
CI both run. **There is no test runner / test suite** in this project; do not invent `npm test`.

## Toolchain (non-standard — read this before reaching for familiar tools)

This repo uses the **oxc** toolchain, not the usual ones. Don't run `tsc`, `eslint`, or `prettier`:

- **`tsgo`** (`@typescript/native-preview`) is the compiler — used for both build and typecheck.
- **`oxlint`** is the linter (config: `.oxlintrc.json`).
- **`oxfmt`** is the formatter (config: `.oxfmtrc.json`, sorts imports into typed groups).

Lint rules are strict and shape the code style:

- `typescript/no-explicit-any: error` — no `any`.
- `consistent-type-assertions: never` — **type assertions (`as`) are banned entirely.** This is
  why the code uses Zod `safeParse` + type guards and conditional object spreads instead of casts
  (see `formatActivity` and `formatComment` in `src/index.ts`).

Other constraints: **ESM only** (`"type": "module"`, `module: NodeNext`) — local/SDK imports use
explicit `.js` extensions and `verbatimModuleSyntax` requires `import type` for type-only imports.
`tsconfig.json` is strict (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`). Engine is
`node >= 24` (CI runs Node 22 with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`); uses the native global
`fetch`, no HTTP client dependency.

## Architecture

Everything lives in one file: **`src/index.ts`** (~925 lines), organized top-to-bottom into
clearly-bannered layers. Understanding the layering is the key to navigating it:

1. **Config** — reads env vars; `resolveAuthHeader()` builds the `Authorization` header once at
   startup (process exits if credentials are missing).
2. **Zod schemas** — the contract for Bitbucket's API responses. **Resilience is deliberate and
   pervasive:** every object uses `.passthrough()` (extra API fields don't break parsing) and
   fields use `.catch(...)` liberally (Bitbucket is inconsistent about null vs missing). When
   adding/editing a schema, keep this defensive style — assume any field may be absent or null.
3. **Inferred types** — `type X = z.infer<typeof XSchema>`; never hand-write these.
4. **HTTP helpers** — `rawFetch` is the single fetch chokepoint (throws on non-2xx with a sliced
   error body). Typed wrappers validate at the boundary: `getTyped`/`postTyped`/`putTyped` parse
   through a schema, `getText` returns raw text (used for diffs), `postVoid`/`deleteVoid` for
   no-body calls. (PUT is used by `update_pr`/`update_comment`/`update_task`.)
5. **Formatters** — `formatPrSummary`, `formatPrDetails`, `formatComment`, etc. reshape validated
   API objects into **compact, token-efficient JSON** for the LLM. Output is intentionally minimal.
6. **Workspace/repo resolution** — `resolveWs` (arg or `BITBUCKET_WORKSPACE`); `getContributorRepos`
   returns `BITBUCKET_REPOS` if set, else paginates the workspace's contributor repos.
7. **Tool input schemas** — Zod schemas (`PrRefInput`, `MyQueueInput`, …) validated at handler entry.
8. **`TOOLS`** — the `const` array of MCP tool definitions (name + description + JSON inputSchema)
   returned by `ListTools`.
9. **`handleTool(name, args)`** — a `switch` mapping each tool name to its logic; returns a string.
10. **Server bootstrap** — wires `ListTools`/`CallTool` handlers (errors, incl. `ZodError`, are
    caught and returned as `isError` text) and connects the stdio transport.

### Adding or changing a tool

A new tool touches **four** places — keep them in sync or the tool won't work:

1. A Zod **input schema** (or reuse/`.extend()` `PrRefInput`).
2. An entry in the **`TOOLS`** array. Each entry has `name`, **`group`** (a `ToolGroup` toolset),
   **`write`** (true if it mutates), `description`, and JSON `inputSchema`. The `group`/`write`
   tags are what `BITBUCKET_TOOLSETS` / `BITBUCKET_READ_ONLY` filter on.
3. A **`case`** in the `handleTool` switch.
4. Usually a **response Zod schema + a `formatX` formatter** for token-efficient output.

### Toolset gating

`TOOLS` entries are tagged with `group` + `write`. At startup, `ENABLED_GROUPS` (from
`BITBUCKET_TOOLSETS`, default all) and `READ_ONLY` (from `BITBUCKET_READ_ONLY`) are computed;
`isToolEnabled(group, write)` is the single predicate. The `ListTools` handler **filters** `TOOLS`
by it and **projects** each entry to the MCP wire shape `{ name, description, inputSchema }` (the
`group`/`write` tags are internal, not sent). `handleTool` re-checks `ENABLED_TOOL_NAMES` so a
disabled tool invoked directly returns a clear error. Adding a new domain = a new `ToolGroup`
literal (update the type + `isToolGroup`) — no other framework change.

## Auth & environment

Auth is HTTP **Basic**. Preferred: `BITBUCKET_EMAIL` + `BITBUCKET_API_TOKEN` (encoded
`email:token`). Legacy fallback: `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD` (Bitbucket app
passwords are being removed June 2026). Env vars (loaded via `dotenv`, e.g. from a `.env` file):

- `BITBUCKET_API_TOKEN` + `BITBUCKET_EMAIL` — auth
- `BITBUCKET_USERNAME` — used to filter PRs by the current user in queries
- `BITBUCKET_WORKSPACE` — default workspace when a tool's `workspace` arg is omitted
- `BITBUCKET_REPOS` — optional comma-separated allowlist; short-circuits repo discovery
- `BITBUCKET_TOOLSETS` — optional comma-separated toolset groups to expose (default: all)
- `BITBUCKET_READ_ONLY` — optional; `true`/`1` exposes only non-mutating tools

## Commits & releases

- **Conventional Commits are mandatory** and enforced by git hooks (husky): `pre-commit` runs
  `npm run check`, `commit-msg` runs commitlint. A failing check or non-conventional message
  blocks the commit. Use `!` for breaking changes (e.g. `feat!:`).
- **Releases are automated** via release-please: merging conventional commits to `main` opens a
  Release PR (version bump + CHANGELOG); merging that PR publishes to npm via the Release workflow.
- **Versioning is 0ver** (zero-based): major stays `0`. Breaking changes bump the minor; features
  and fixes bump the patch.
