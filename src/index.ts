#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// Config
// ============================================================================

const API_TOKEN = process.env["BITBUCKET_API_TOKEN"] ?? "";
const EMAIL = process.env["BITBUCKET_EMAIL"] ?? "";
const USERNAME = process.env["BITBUCKET_USERNAME"] ?? "";
const WORKSPACE = process.env["BITBUCKET_WORKSPACE"] ?? "";
const REPOS = (process.env["BITBUCKET_REPOS"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BASE = "https://api.bitbucket.org/2.0";

function resolveAuthHeader(): string {
  // API tokens with scopes (Basic auth with email:token)
  if (API_TOKEN && EMAIL) {
    return "Basic " + Buffer.from(`${EMAIL}:${API_TOKEN}`).toString("base64");
  }
  // Legacy: app passwords (Basic auth with username:password, removed June 2026)
  const appPassword = process.env["BITBUCKET_APP_PASSWORD"] ?? "";
  if (USERNAME && appPassword) {
    return "Basic " + Buffer.from(`${USERNAME}:${appPassword}`).toString("base64");
  }
  console.error(
    "Set BITBUCKET_EMAIL + BITBUCKET_API_TOKEN, or BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD.",
  );
  process.exit(1);
}

const AUTH_HEADER = resolveAuthHeader();

// ============================================================================
// Toolset gating — operators choose which tool groups load, to keep the
// model's context window lean. Two orthogonal axes:
//   BITBUCKET_TOOLSETS  — comma-separated group names, or "all" (default)
//   BITBUCKET_READ_ONLY — "true"/"1"/"yes" exposes only non-mutating tools
// ============================================================================

type ToolGroup = "pulls" | "comments" | "tasks" | "branches" | "repos";

function isToolGroup(s: string): s is ToolGroup {
  return s === "pulls" || s === "comments" || s === "tasks" || s === "branches" || s === "repos";
}

const ENABLED_GROUPS: Set<ToolGroup> = (() => {
  const raw = (process.env["BITBUCKET_TOOLSETS"] ?? "all").trim().toLowerCase();
  if (raw === "" || raw === "all") {
    return new Set<ToolGroup>(["pulls", "comments", "tasks", "branches", "repos"]);
  }
  const tokens = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of tokens) {
    if (!isToolGroup(t)) {
      console.error(
        `[bitbucket-mcp] Unknown toolset "${t}" ignored (valid: pulls, comments, tasks, branches, repos).`,
      );
    }
  }
  const enabled = new Set<ToolGroup>(tokens.filter(isToolGroup));
  if (enabled.size === 0) {
    console.error(
      "[bitbucket-mcp] No valid toolsets configured — all tools are disabled. Check BITBUCKET_TOOLSETS.",
    );
  }
  return enabled;
})();

const READ_ONLY = ["1", "true", "yes"].includes(
  (process.env["BITBUCKET_READ_ONLY"] ?? "").trim().toLowerCase(),
);

function isToolEnabled(group: ToolGroup, write: boolean): boolean {
  return ENABLED_GROUPS.has(group) && (!READ_ONLY || !write);
}

// ============================================================================
// Zod schemas — the contract between BitBucket's API and our code.
//
// .passthrough() on all objects: extra API fields don't break us.
// .catch() liberally: BitBucket is inconsistent about null vs missing.
// ============================================================================

// --- Primitives ---

const UserSchema = z
  .object({
    display_name: z.string().catch("Unknown"),
    username: z.string().optional().catch(undefined),
    account_id: z.string().optional().catch(undefined),
    uuid: z.string().optional().catch(undefined),
  })
  .passthrough();

const BranchRefSchema = z
  .object({
    branch: z.object({ name: z.string() }).passthrough(),
    repository: z.object({ full_name: z.string() }).passthrough().optional().catch(undefined),
  })
  .passthrough();

// --- Pull Request ---

const ReviewerSchema = z
  .object({
    display_name: z.string().catch("?"),
    username: z.string().optional().catch(undefined),
    account_id: z.string().optional().catch(undefined),
    uuid: z.string().optional().catch(undefined),
    approved: z.boolean().catch(false),
  })
  .passthrough();

const ParticipantSchema = z
  .object({
    user: UserSchema,
    role: z.string().catch(""),
    approved: z.boolean().catch(false),
    state: z
      .object({ name: z.string().catch("") })
      .passthrough()
      .nullable()
      .catch(null),
  })
  .passthrough();

const PullRequestSchema = z
  .object({
    id: z.number(),
    title: z.string(),
    description: z.string().nullable().catch(null),
    state: z.string(),
    author: UserSchema,
    source: BranchRefSchema,
    destination: BranchRefSchema,
    reviewers: z.array(ReviewerSchema).catch([]),
    participants: z.array(ParticipantSchema).catch([]),
    created_on: z.string().nullable().catch(null),
    updated_on: z.string().nullable().catch(null),
    comment_count: z.number().catch(0),
    task_count: z.number().catch(0),
    close_source_branch: z.boolean().catch(false),
    merge_commit: z.object({ hash: z.string() }).passthrough().nullable().catch(null),
    links: z
      .object({
        html: z.object({ href: z.string() }).passthrough().optional().catch(undefined),
      })
      .passthrough()
      .catch({}),
  })
  .passthrough();

// --- Comment ---

const CommentSchema = z
  .object({
    id: z.number(),
    user: UserSchema,
    content: z
      .object({ raw: z.string().catch("") })
      .passthrough()
      .catch({ raw: "" }),
    created_on: z.string().nullable().catch(null),
    updated_on: z.string().nullable().catch(null),
    resolution: z.object({ type: z.string() }).passthrough().nullable().catch(null),
    parent: z.object({ id: z.number() }).passthrough().nullable().catch(null),
    inline: z
      .object({
        path: z.string().catch(""),
        to: z.number().nullable().catch(null),
        from: z.number().nullable().catch(null),
      })
      .passthrough()
      .nullable()
      .catch(null),
  })
  .passthrough();

const CommentPostResponseSchema = z
  .object({
    id: z.number().optional().catch(undefined),
    created_on: z.string().nullable().catch(null),
  })
  .passthrough();

// --- Diffstat ---

const DiffstatEntrySchema = z
  .object({
    new: z.object({ path: z.string() }).passthrough().nullable().catch(null),
    old: z.object({ path: z.string() }).passthrough().nullable().catch(null),
    status: z.string().catch(""),
    lines_added: z.number().catch(0),
    lines_removed: z.number().catch(0),
  })
  .passthrough();

// --- Commit ---

const CommitSchema = z
  .object({
    hash: z.string(),
    date: z.string().nullable().catch(null),
    message: z.string().catch(""),
    author: z
      .object({
        raw: z.string().catch(""),
        user: UserSchema.optional().catch(undefined),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

// --- Build / commit status ---

const StatusSchema = z
  .object({
    key: z.string().catch(""),
    name: z.string().catch(""),
    state: z.string().catch(""),
    description: z.string().catch(""),
    url: z.string().nullable().catch(null),
    updated_on: z.string().nullable().catch(null),
  })
  .passthrough();

// --- PR Task ---

const TaskSchema = z
  .object({
    id: z.number(),
    state: z.string().catch("UNRESOLVED"),
    content: z
      .object({ raw: z.string().catch("") })
      .passthrough()
      .catch({ raw: "" }),
    creator: UserSchema.optional().catch(undefined),
    created_on: z.string().nullable().catch(null),
    updated_on: z.string().nullable().catch(null),
  })
  .passthrough();

// --- Branch (ref) ---

const BranchSchema = z
  .object({
    name: z.string(),
    target: z
      .object({
        hash: z.string().catch(""),
        date: z.string().nullable().catch(null),
      })
      .passthrough()
      .optional()
      .catch(undefined),
  })
  .passthrough();

// --- Activity ---

const ActivityApprovalSchema = z
  .object({
    approval: z.object({ user: UserSchema, date: z.string().nullable().catch(null) }).passthrough(),
  })
  .passthrough();

const ActivityUpdateSchema = z
  .object({
    update: z
      .object({
        author: UserSchema.optional().catch(undefined),
        date: z.string().nullable().catch(null),
        state: z.string().catch(""),
        description: z.string().catch(""),
      })
      .passthrough(),
  })
  .passthrough();

const ActivityCommentSchema = z
  .object({
    comment: z
      .object({
        user: UserSchema,
        created_on: z.string().nullable().catch(null),
        content: z
          .object({ raw: z.string().catch("") })
          .passthrough()
          .catch({ raw: "" }),
      })
      .passthrough(),
  })
  .passthrough();

const ActivityItemSchema = z.union([
  ActivityApprovalSchema,
  ActivityUpdateSchema,
  ActivityCommentSchema,
  z.object({}).passthrough(),
]);

// --- Repository ---

const RepoSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    updated_on: z.string().nullable().catch(null),
  })
  .passthrough();

// --- Paginated wrapper ---

function paginated<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    values: z.array(itemSchema).catch([]),
    page: z.number().optional().catch(undefined),
    size: z.number().optional().catch(undefined),
    next: z.string().optional().catch(undefined),
  });
}

// ============================================================================
// Inferred types — derived from schemas, never hand-written
// ============================================================================

type PullRequest = z.infer<typeof PullRequestSchema>;
type Comment = z.infer<typeof CommentSchema>;
type DiffstatEntry = z.infer<typeof DiffstatEntrySchema>;
type Commit = z.infer<typeof CommitSchema>;
type Status = z.infer<typeof StatusSchema>;
type Task = z.infer<typeof TaskSchema>;
type Branch = z.infer<typeof BranchSchema>;

// ============================================================================
// HTTP helpers — validate at the boundary
// ============================================================================

async function rawFetch(
  method: string,
  path: string,
  params?: Record<string, string | number> | undefined,
  body?: unknown,
): Promise<Response> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { Authorization: AUTH_HEADER };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url.toString(), init);
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`${method} ${path}: ${r.status} ${r.statusText} — ${text.slice(0, 200)}`);
  }
  return r;
}

async function getTyped<T>(
  schema: z.ZodType<T>,
  path: string,
  params?: Record<string, string | number> | undefined,
): Promise<T> {
  const r = await rawFetch("GET", path, params);
  const json: unknown = await r.json();
  return schema.parse(json);
}

async function getText(
  path: string,
  params?: Record<string, string | number> | undefined,
): Promise<string> {
  const r = await rawFetch("GET", path, params);
  return r.text();
}

async function postTyped<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
  const r = await rawFetch("POST", path, undefined, body);
  if (r.status === 204) return schema.parse({});
  const json: unknown = await r.json();
  return schema.parse(json);
}

async function putTyped<T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> {
  const r = await rawFetch("PUT", path, undefined, body);
  if (r.status === 204) return schema.parse({});
  const json: unknown = await r.json();
  return schema.parse(json);
}

async function postVoid(path: string, body?: unknown): Promise<void> {
  await rawFetch("POST", path, undefined, body);
}

async function deleteVoid(path: string): Promise<void> {
  await rawFetch("DELETE", path);
}

// ============================================================================
// Formatters — token-efficient, fully typed output shapes
// ============================================================================

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().replace("T", " ").slice(0, 19) + " UTC";
  } catch {
    return iso.slice(0, 19);
  }
}

function formatPrSummary(pr: PullRequest) {
  return {
    id: pr.id,
    repo: pr.destination.repository?.full_name ?? "?",
    title: pr.title,
    state: pr.state,
    author: pr.author.display_name,
    created: formatTimestamp(pr.created_on),
    updated: formatTimestamp(pr.updated_on),
    comment_count: pr.comment_count,
    task_count: pr.task_count,
    source_branch: pr.source.branch.name,
    dest_branch: pr.destination.branch.name,
  };
}

function formatPrDetails(pr: PullRequest) {
  const reviewers = pr.reviewers.map((r) => ({
    name: r.display_name,
    account_id: r.account_id ?? "",
    approved: r.approved,
    state: "",
  }));

  for (const p of pr.participants) {
    if (p.role === "REVIEWER") {
      const name = p.user.display_name;
      const rev = reviewers.find((r) => r.name === name);
      if (rev) {
        rev.approved = p.approved;
        rev.state = p.state?.name ?? "";
      }
    }
  }

  return {
    id: pr.id,
    title: pr.title,
    description: pr.description ?? "",
    state: pr.state,
    author: pr.author.display_name,
    reviewers,
    source_branch: pr.source.branch.name,
    dest_branch: pr.destination.branch.name,
    created: formatTimestamp(pr.created_on),
    updated: formatTimestamp(pr.updated_on),
    close_source_branch: pr.close_source_branch,
    comment_count: pr.comment_count,
    task_count: pr.task_count,
    merge_commit: pr.merge_commit?.hash ?? "",
    web_link: pr.links.html?.href ?? "",
  };
}

function formatComment(c: Comment) {
  const base = {
    id: c.id,
    author: c.user.display_name,
    content: c.content.raw,
    created: formatTimestamp(c.created_on),
    updated: formatTimestamp(c.updated_on),
    resolved: c.resolution?.type === "resolved",
    parent_id: c.parent?.id ?? null,
  };

  // Conditionally include inline location (avoids undefined with exactOptionalPropertyTypes)
  if (c.inline) {
    return {
      ...base,
      file: c.inline.path,
      line: c.inline.to ?? c.inline.from,
    };
  }

  return base;
}

function formatDiffstat(entries: readonly DiffstatEntry[]) {
  const files = entries.map((f) => ({
    path: f.new?.path ?? f.old?.path ?? "?",
    status: f.status,
    lines_added: f.lines_added,
    lines_removed: f.lines_removed,
  }));
  return {
    files_changed: files.length,
    total_lines_added: files.reduce((s, f) => s + f.lines_added, 0),
    total_lines_removed: files.reduce((s, f) => s + f.lines_removed, 0),
    files,
  };
}

function formatCommit(c: Commit) {
  const summary = c.message.split("\n")[0] ?? "";
  return {
    hash: c.hash.slice(0, 12),
    author: c.author?.user?.display_name ?? c.author?.raw ?? "?",
    date: formatTimestamp(c.date),
    message: summary.slice(0, 150),
  };
}

function formatStatus(s: Status) {
  return {
    key: s.key,
    name: s.name,
    state: s.state,
    description: s.description.slice(0, 150),
    url: s.url ?? "",
    updated: formatTimestamp(s.updated_on),
  };
}

function formatTask(t: Task) {
  return {
    id: t.id,
    state: t.state,
    resolved: t.state === "RESOLVED",
    content: t.content.raw,
    creator: t.creator?.display_name ?? "?",
    created: formatTimestamp(t.created_on),
    updated: formatTimestamp(t.updated_on),
  };
}

function formatBranch(b: Branch) {
  return {
    name: b.name,
    target: b.target?.hash?.slice(0, 12) ?? "",
    date: formatTimestamp(b.target?.date),
  };
}

function formatActivity(item: z.infer<typeof ActivityItemSchema>) {
  const asApproval = ActivityApprovalSchema.safeParse(item);
  if (asApproval.success) {
    const { approval } = asApproval.data;
    return {
      type: "approval",
      user: approval.user.display_name,
      date: formatTimestamp(approval.date),
    };
  }
  const asUpdate = ActivityUpdateSchema.safeParse(item);
  if (asUpdate.success) {
    const { update } = asUpdate.data;
    return {
      type: "update",
      author: update.author?.display_name ?? "?",
      date: formatTimestamp(update.date),
      state: update.state,
      description: update.description.slice(0, 200),
    };
  }
  const asComment = ActivityCommentSchema.safeParse(item);
  if (asComment.success) {
    const { comment } = asComment.data;
    return {
      type: "comment",
      author: comment.user.display_name,
      date: formatTimestamp(comment.created_on),
      content_preview: comment.content.raw.slice(0, 150),
    };
  }
  return null;
}

// ============================================================================
// Workspace & repo resolution
// ============================================================================

function resolveWs(workspace: string | undefined): string {
  const ws = workspace ?? WORKSPACE;
  if (!ws) {
    throw new Error("No workspace. Pass workspace arg or set BITBUCKET_WORKSPACE env var.");
  }
  return ws;
}

async function getContributorRepos(ws: string): Promise<string[]> {
  if (REPOS.length > 0) return REPOS;

  const slugs: string[] = [];
  const schema = paginated(RepoSchema);
  let nextPage: string | undefined;

  // First page
  const first = await getTyped(schema, `/repositories/${ws}`, {
    role: "contributor",
    pagelen: 100,
  });
  for (const r of first.values) slugs.push(r.slug);
  nextPage = first.next;

  // Follow pagination
  while (nextPage) {
    const url = new URL(nextPage);
    const params: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) params[k] = v;
    const page = await getTyped(schema, url.pathname.replace("/2.0", ""), params);
    for (const r of page.values) slugs.push(r.slug);
    nextPage = page.next;
  }

  return slugs;
}

// Map a list of reviewer account IDs into Bitbucket's reviewer payload shape.
function reviewersByAccountId(ids: readonly string[]): { account_id: string }[] {
  return ids.map((id) => ({ account_id: id }));
}

// Preserve a PR's existing reviewers across a PUT (Bitbucket replaces, not merges).
function preserveReviewers(
  reviewers: readonly z.infer<typeof ReviewerSchema>[],
): ({ account_id: string } | { uuid: string })[] {
  return reviewers
    .map((r) => (r.account_id ? { account_id: r.account_id } : r.uuid ? { uuid: r.uuid } : null))
    .filter((x): x is { account_id: string } | { uuid: string } => x !== null);
}

// Branch names legally contain "/" (kept as path separators) plus characters like
// "#" or "%" that would otherwise be parsed as a URL fragment / bad escape. Encode
// each segment while preserving the slashes Bitbucket's greedy ref route expects.
function encodeRef(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

// ============================================================================
// Tool input schemas (Zod — validated at handler entry)
// ============================================================================

const MyQueueInput = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string().optional(),
  state: z
    .union([z.literal("OPEN"), z.literal("MERGED"), z.literal("DECLINED"), z.literal("SUPERSEDED")])
    .default("OPEN"),
  max_results: z.number().int().min(1).max(100).default(25),
});

const PrRefInput = z.object({
  repo_slug: z.string(),
  pr_id: z.number(),
  workspace: z.string().optional(),
});

const PrCommentsInput = PrRefInput.extend({
  max_results: z.number().int().min(1).max(100).default(50),
});

const PrDiffInput = PrRefInput.extend({
  context_lines: z.number().int().min(0).max(20).default(3),
});

const PrActivityInput = PrRefInput.extend({
  max_results: z.number().int().min(1).max(100).default(30),
});

const PrCommitsInput = PrRefInput.extend({
  max_results: z.number().int().min(1).max(100).default(30),
});

const PrStatusesInput = PrRefInput.extend({
  max_results: z.number().int().min(1).max(100).default(30),
});

const AddCommentInput = z.object({
  repo_slug: z.string(),
  pr_id: z.number(),
  content: z.string(),
  workspace: z.string().optional(),
  file_path: z.string().optional(),
  line: z.number().optional(),
  parent_comment_id: z.number().optional(),
});

const CommentRefInput = PrRefInput.extend({
  comment_id: z.number(),
});

const UpdateCommentInput = CommentRefInput.extend({
  content: z.string(),
});

const CreatePrInput = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string(),
  title: z.string(),
  source_branch: z.string(),
  destination_branch: z.string().optional(),
  description: z.string().optional(),
  reviewers: z.array(z.string()).optional(),
  close_source_branch: z.boolean().optional(),
});

const UpdatePrInput = PrRefInput.extend({
  title: z.string().optional(),
  description: z.string().optional(),
  destination_branch: z.string().optional(),
  reviewers: z.array(z.string()).optional(),
  close_source_branch: z.boolean().optional(),
});

const MergePrInput = PrRefInput.extend({
  merge_strategy: z
    .union([z.literal("merge_commit"), z.literal("squash"), z.literal("fast_forward")])
    .optional(),
  message: z.string().optional(),
  close_source_branch: z.boolean().optional(),
});

const DeclinePrInput = PrRefInput.extend({
  message: z.string().optional(),
});

const PrTasksInput = PrRefInput.extend({
  max_results: z.number().int().min(1).max(100).default(50),
});

const AddTaskInput = PrRefInput.extend({
  content: z.string(),
});

const TaskRefInput = PrRefInput.extend({
  task_id: z.number(),
});

const UpdateTaskInput = TaskRefInput.extend({
  content: z.string().optional(),
  state: z.union([z.literal("RESOLVED"), z.literal("UNRESOLVED")]).optional(),
}).refine((a) => a.content !== undefined || a.state !== undefined, {
  message: "Provide content and/or state to update.",
});

const ListBranchesInput = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string(),
  q: z.string().optional(),
  max_results: z.number().int().min(1).max(100).default(50),
});

const BranchRefInput = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string(),
  name: z.string(),
});

const CreateBranchInput = z.object({
  workspace: z.string().optional(),
  repo_slug: z.string(),
  name: z.string(),
  target: z.string(),
});

const ListReposInput = z.object({
  workspace: z.string().optional(),
  role: z
    .union([z.literal("contributor"), z.literal("admin"), z.literal("member"), z.literal("owner")])
    .default("contributor"),
  max_results: z.number().int().min(1).max(100).default(50),
});

// ============================================================================
// Tool definitions — presented to Claude via MCP
//
// Each entry is tagged with `group` (toolset) and `write` (mutating?) so the
// ListTools handler can filter by BITBUCKET_TOOLSETS / BITBUCKET_READ_ONLY.
// ============================================================================

const TOOLS = [
  {
    name: "my_review_queue",
    group: "pulls",
    write: false,
    description:
      "List PRs where I am a reviewer. Returns compact summaries: id, repo, title, state, author, timestamps. Use pr_details/pr_comments/pr_diff to drill deeper.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: {
          type: "string",
          description: "Workspace slug (optional if BITBUCKET_WORKSPACE is set)",
        },
        repo_slug: {
          type: "string",
          description: "Filter to one repo (optional — omit to search all)",
        },
        state: {
          type: "string",
          enum: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
          default: "OPEN",
        },
        max_results: { type: "number", default: 25 },
      },
    },
  },
  {
    name: "my_open_prs",
    group: "pulls",
    write: false,
    description:
      "List PRs I authored. Returns compact summaries. Use pr_details for description/reviewers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: { type: "string" },
        repo_slug: { type: "string" },
        state: {
          type: "string",
          enum: ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
          default: "OPEN",
        },
        max_results: { type: "number", default: 25 },
      },
    },
  },
  {
    name: "pr_details",
    group: "pulls",
    write: false,
    description:
      "Full details for one PR: title, description (markdown), reviewers with approval status, branches, timestamps, links.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string", description: "Repository slug" },
        pr_id: { type: "number", description: "Pull request ID" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_comments",
    group: "comments",
    write: false,
    description:
      "Comments on a PR, threaded. Includes inline file/line info, resolution status, timestamps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        max_results: { type: "number", default: 50 },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_diffstat",
    group: "pulls",
    write: false,
    description:
      "Changed files with lines added/removed. Much lighter than pr_diff — use first to understand scope.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_diff",
    group: "pulls",
    write: false,
    description: "Full unified diff. Can be large — use pr_diffstat first to gauge size.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        context_lines: {
          type: "number",
          default: 3,
          description: "Lines of context (lower = smaller)",
        },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_activity",
    group: "pulls",
    write: false,
    description: "Timeline of approvals, updates, comments, merges for a PR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        max_results: { type: "number", default: 30 },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_commits",
    group: "pulls",
    write: false,
    description: "List the commits that make up a PR: short hash, author, date, message summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        max_results: { type: "number", default: 30 },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "pr_statuses",
    group: "pulls",
    write: false,
    description:
      "Build/commit statuses (CI checks) reported on a PR: key, name, state, description, url.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        max_results: { type: "number", default: 30 },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "create_pr",
    group: "pulls",
    write: true,
    description:
      "Create a pull request. Reviewers must be given as account IDs (not usernames). destination_branch defaults to the repo's main branch.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        title: { type: "string" },
        source_branch: { type: "string", description: "Branch to merge from" },
        destination_branch: {
          type: "string",
          description: "Branch to merge into (defaults to repo main)",
        },
        description: { type: "string", description: "PR description (markdown)" },
        reviewers: {
          type: "array",
          items: { type: "string" },
          description: "Reviewer account IDs (not usernames)",
        },
        close_source_branch: { type: "boolean" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "title", "source_branch"],
    },
  },
  {
    name: "update_pr",
    group: "pulls",
    write: true,
    description:
      "Edit a PR. Provide only the fields to change (e.g. just description). Other fields — including title and reviewers — are preserved. Reviewers, if given, are account IDs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        title: { type: "string" },
        description: { type: "string", description: "New description (markdown)" },
        destination_branch: { type: "string" },
        reviewers: {
          type: "array",
          items: { type: "string" },
          description:
            "Reviewer account IDs. If omitted, existing reviewers are preserved; if provided, replaces them entirely.",
        },
        close_source_branch: { type: "boolean" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "merge_pr",
    group: "pulls",
    write: true,
    description:
      "Merge a PR. DESTRUCTIVE / irreversible. merge_strategy defaults to the repo setting if omitted.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        merge_strategy: {
          type: "string",
          enum: ["merge_commit", "squash", "fast_forward"],
        },
        message: { type: "string", description: "Merge commit message" },
        close_source_branch: { type: "boolean" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "decline_pr",
    group: "pulls",
    write: true,
    description: "Decline (reject) a PR. DESTRUCTIVE — closes the PR without merging.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        message: { type: "string", description: "Reason for declining" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "approve_pr",
    group: "pulls",
    write: true,
    description: "Approve a pull request.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "unapprove_pr",
    group: "pulls",
    write: true,
    description: "Remove your approval from a pull request.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "request_changes",
    group: "pulls",
    write: true,
    description: "Request changes on a pull request.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "unrequest_changes",
    group: "pulls",
    write: true,
    description: "Remove your 'request changes' status from a pull request.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "add_comment",
    group: "comments",
    write: true,
    description:
      "Post a comment on a PR. Supports general, inline (file/line), and reply (parent_comment_id).",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        content: { type: "string", description: "Comment text (markdown)" },
        workspace: { type: "string" },
        file_path: { type: "string", description: "Inline: file path" },
        line: { type: "number", description: "Inline: line number" },
        parent_comment_id: {
          type: "number",
          description: "Reply to comment ID",
        },
      },
      required: ["repo_slug", "pr_id", "content"],
    },
  },
  {
    name: "update_comment",
    group: "comments",
    write: true,
    description: "Edit the text of an existing PR comment you authored.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        comment_id: { type: "number" },
        content: { type: "string", description: "New comment text (markdown)" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "comment_id", "content"],
    },
  },
  {
    name: "delete_comment",
    group: "comments",
    write: true,
    description: "Delete a PR comment. DESTRUCTIVE / irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        comment_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "comment_id"],
    },
  },
  {
    name: "resolve_comment",
    group: "comments",
    write: true,
    description: "Mark a PR comment thread as resolved.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        comment_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "comment_id"],
    },
  },
  {
    name: "reopen_comment",
    group: "comments",
    write: true,
    description: "Reopen (unresolve) a previously resolved PR comment thread.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        comment_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "comment_id"],
    },
  },
  {
    name: "pr_tasks",
    group: "tasks",
    write: false,
    description: "List the tasks (checklist items) on a PR with their resolved state.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        workspace: { type: "string" },
        max_results: { type: "number", default: 50 },
      },
      required: ["repo_slug", "pr_id"],
    },
  },
  {
    name: "add_task",
    group: "tasks",
    write: true,
    description: "Add a task (checklist item) to a PR.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        content: { type: "string", description: "Task text" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "content"],
    },
  },
  {
    name: "update_task",
    group: "tasks",
    write: true,
    description: "Update a PR task — change its text and/or mark it RESOLVED or UNRESOLVED.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        task_id: { type: "number" },
        content: {
          type: "string",
          description: "New task text. Provide content and/or state — at least one is required.",
        },
        state: {
          type: "string",
          enum: ["RESOLVED", "UNRESOLVED"],
          description: "Provide content and/or state — at least one is required.",
        },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "task_id"],
    },
  },
  {
    name: "delete_task",
    group: "tasks",
    write: true,
    description: "Delete a PR task. DESTRUCTIVE / irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        pr_id: { type: "number" },
        task_id: { type: "number" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "pr_id", "task_id"],
    },
  },
  {
    name: "list_branches",
    group: "branches",
    write: false,
    description:
      'List branches in a repo: name, latest commit hash, date. Optional q filter (BBQL, e.g. name~"feature").',
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        workspace: { type: "string" },
        q: { type: "string", description: "Bitbucket query filter (optional)" },
        max_results: { type: "number", default: 50 },
      },
      required: ["repo_slug"],
    },
  },
  {
    name: "get_branch",
    group: "branches",
    write: false,
    description: "Get one branch by its full name (slashes allowed, e.g. feature/login).",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        name: { type: "string", description: "Full branch name" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "name"],
    },
  },
  {
    name: "create_branch",
    group: "branches",
    write: true,
    description: "Create a branch pointing at a target commit hash or existing branch name.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        name: { type: "string", description: "New branch name" },
        target: {
          type: "string",
          description: "Commit hash or existing branch name to branch from",
        },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "name", "target"],
    },
  },
  {
    name: "delete_branch",
    group: "branches",
    write: true,
    description: "Delete a branch by full name. DESTRUCTIVE / irreversible.",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_slug: { type: "string" },
        name: { type: "string", description: "Full branch name" },
        workspace: { type: "string" },
      },
      required: ["repo_slug", "name"],
    },
  },
  {
    name: "list_repos",
    group: "repos",
    write: false,
    description: "List repos in the workspace. Useful to discover repo slugs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        workspace: { type: "string" },
        role: {
          type: "string",
          enum: ["contributor", "admin", "member", "owner"],
          default: "contributor",
        },
        max_results: { type: "number", default: 50 },
      },
    },
  },
] as const;

// Tool names exposed under the current BITBUCKET_TOOLSETS / BITBUCKET_READ_ONLY config.
const ENABLED_TOOL_NAMES = new Set<string>(
  TOOLS.filter((t) => isToolEnabled(t.group, t.write)).map((t) => t.name),
);

// ============================================================================
// Tool handlers
// ============================================================================

async function handleTool(name: string, rawArgs: unknown): Promise<string> {
  if (!ENABLED_TOOL_NAMES.has(name)) {
    throw new Error(
      `Tool "${name}" is not enabled. Adjust BITBUCKET_TOOLSETS / BITBUCKET_READ_ONLY to enable it.`,
    );
  }

  switch (name) {
    case "my_review_queue":
    case "my_open_prs": {
      const args = MyQueueInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const repos = args.repo_slug ? [args.repo_slug] : await getContributorRepos(ws);
      const field = name === "my_review_queue" ? "reviewers" : "author";
      const results: ReturnType<typeof formatPrSummary>[] = [];

      for (const slug of repos) {
        if (results.length >= args.max_results) break;
        try {
          const q = `${field}.username="${USERNAME}" AND state="${args.state}"`;
          const data = await getTyped(
            paginated(PullRequestSchema),
            `/repositories/${ws}/${slug}/pullrequests`,
            { q, pagelen: Math.min(args.max_results - results.length, 50) },
          );
          for (const pr of data.values) {
            results.push(formatPrSummary(pr));
          }
        } catch {
          continue;
        }
      }
      return results.length > 0 ? JSON.stringify(results, null, 2) : `No ${args.state} PRs found.`;
    }

    case "pr_details": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const pr = await getTyped(
        PullRequestSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}`,
      );
      return JSON.stringify(formatPrDetails(pr), null, 2);
    }

    case "pr_comments": {
      const args = PrCommentsInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(CommentSchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments`,
        { pagelen: Math.min(args.max_results, 100), sort: "created_on" },
      );
      const comments = data.values.slice(0, args.max_results).map(formatComment);
      return comments.length > 0 ? JSON.stringify(comments, null, 2) : "No comments on this PR.";
    }

    case "pr_diffstat": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(DiffstatEntrySchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/diffstat`,
        { pagelen: 500 },
      );
      return JSON.stringify(formatDiffstat(data.values), null, 2);
    }

    case "pr_diff": {
      const args = PrDiffInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      return getText(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/diff`,
        { context: args.context_lines },
      );
    }

    case "pr_activity": {
      const args = PrActivityInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(ActivityItemSchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/activity`,
        { pagelen: Math.min(args.max_results, 50) },
      );
      const activities = data.values
        .slice(0, args.max_results)
        .map(formatActivity)
        .filter((x): x is NonNullable<typeof x> => x !== null);
      return activities.length > 0 ? JSON.stringify(activities, null, 2) : "No activity recorded.";
    }

    case "pr_commits": {
      const args = PrCommitsInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(CommitSchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/commits`,
        { pagelen: Math.min(args.max_results, 100) },
      );
      const commits = data.values.slice(0, args.max_results).map(formatCommit);
      return commits.length > 0 ? JSON.stringify(commits, null, 2) : "No commits on this PR.";
    }

    case "pr_statuses": {
      const args = PrStatusesInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(StatusSchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/statuses`,
        { pagelen: Math.min(args.max_results, 100) },
      );
      const statuses = data.values.slice(0, args.max_results).map(formatStatus);
      return statuses.length > 0 ? JSON.stringify(statuses, null, 2) : "No statuses on this PR.";
    }

    case "create_pr": {
      const args = CreatePrInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const body: Record<string, unknown> = {
        title: args.title,
        source: { branch: { name: args.source_branch } },
      };
      if (args.destination_branch !== undefined) {
        body["destination"] = { branch: { name: args.destination_branch } };
      }
      if (args.description !== undefined) body["description"] = args.description;
      if (args.reviewers !== undefined) body["reviewers"] = reviewersByAccountId(args.reviewers);
      if (args.close_source_branch !== undefined) {
        body["close_source_branch"] = args.close_source_branch;
      }
      const pr = await postTyped(
        PullRequestSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests`,
        body,
      );
      return JSON.stringify(formatPrDetails(pr), null, 2);
    }

    case "update_pr": {
      const args = UpdatePrInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const base = `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}`;
      // Read-modify-write: Bitbucket's PUT replaces fields, so fetch current
      // state and overlay only what the caller provided.
      const current = await getTyped(PullRequestSchema, base);
      const body: Record<string, unknown> = {
        title: args.title ?? current.title,
        destination: {
          branch: { name: args.destination_branch ?? current.destination.branch.name },
        },
        close_source_branch: args.close_source_branch ?? current.close_source_branch,
      };
      // Always echo description back: Bitbucket's PUT replaces fields, and some API
      // versions reject a PUT that omits it. Default a null/absent description to "".
      body["description"] = args.description ?? current.description ?? "";
      body["reviewers"] =
        args.reviewers !== undefined
          ? reviewersByAccountId(args.reviewers)
          : preserveReviewers(current.reviewers);
      const updated = await putTyped(PullRequestSchema, base, body);
      return JSON.stringify(formatPrDetails(updated), null, 2);
    }

    case "merge_pr": {
      const args = MergePrInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const body: Record<string, unknown> = { type: "pullrequest" };
      if (args.merge_strategy !== undefined) body["merge_strategy"] = args.merge_strategy;
      if (args.message !== undefined) body["message"] = args.message;
      if (args.close_source_branch !== undefined) {
        body["close_source_branch"] = args.close_source_branch;
      }
      const pr = await postTyped(
        PullRequestSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/merge`,
        body,
      );
      return JSON.stringify({
        status: "merged",
        pr_id: args.pr_id,
        state: pr.state,
        merge_commit: pr.merge_commit?.hash ?? "",
      });
    }

    case "decline_pr": {
      const args = DeclinePrInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const body: Record<string, unknown> = {};
      if (args.message !== undefined) body["message"] = args.message;
      const pr = await postTyped(
        PullRequestSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/decline`,
        body,
      );
      return JSON.stringify({ status: "declined", pr_id: args.pr_id, state: pr.state });
    }

    case "approve_pr": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await postVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/approve`,
      );
      return JSON.stringify({ status: "approved", pr_id: args.pr_id });
    }

    case "unapprove_pr": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/approve`,
      );
      return JSON.stringify({
        status: "approval_removed",
        pr_id: args.pr_id,
      });
    }

    case "request_changes": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await postVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/request-changes`,
      );
      return JSON.stringify({
        status: "changes_requested",
        pr_id: args.pr_id,
      });
    }

    case "unrequest_changes": {
      const args = PrRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/request-changes`,
      );
      return JSON.stringify({
        status: "changes_request_removed",
        pr_id: args.pr_id,
      });
    }

    case "add_comment": {
      const args = AddCommentInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const body: Record<string, unknown> = {
        content: { raw: args.content },
      };
      if (args.file_path !== undefined && args.line !== undefined) {
        body["inline"] = { path: args.file_path, to: args.line };
      }
      if (args.parent_comment_id !== undefined) {
        body["parent"] = { id: args.parent_comment_id };
      }
      const result = await postTyped(
        CommentPostResponseSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments`,
        body,
      );
      return JSON.stringify({
        id: result.id,
        status: "posted",
        created: formatTimestamp(result.created_on),
      });
    }

    case "update_comment": {
      const args = UpdateCommentInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const comment = await putTyped(
        CommentSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments/${String(args.comment_id)}`,
        { content: { raw: args.content } },
      );
      return JSON.stringify(formatComment(comment), null, 2);
    }

    case "delete_comment": {
      const args = CommentRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments/${String(args.comment_id)}`,
      );
      return JSON.stringify({ status: "deleted", comment_id: args.comment_id });
    }

    case "resolve_comment": {
      const args = CommentRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await postVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments/${String(args.comment_id)}/resolve`,
      );
      return JSON.stringify({ status: "resolved", comment_id: args.comment_id });
    }

    case "reopen_comment": {
      const args = CommentRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/comments/${String(args.comment_id)}/resolve`,
      );
      return JSON.stringify({ status: "reopened", comment_id: args.comment_id });
    }

    case "pr_tasks": {
      const args = PrTasksInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(
        paginated(TaskSchema),
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/tasks`,
        { pagelen: Math.min(args.max_results, 100) },
      );
      const tasks = data.values.slice(0, args.max_results).map(formatTask);
      return tasks.length > 0 ? JSON.stringify(tasks, null, 2) : "No tasks on this PR.";
    }

    case "add_task": {
      const args = AddTaskInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const task = await postTyped(
        TaskSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/tasks`,
        { content: { raw: args.content } },
      );
      return JSON.stringify(formatTask(task), null, 2);
    }

    case "update_task": {
      const args = UpdateTaskInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const body: Record<string, unknown> = {};
      if (args.content !== undefined) body["content"] = { raw: args.content };
      if (args.state !== undefined) body["state"] = args.state;
      const task = await putTyped(
        TaskSchema,
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/tasks/${String(args.task_id)}`,
        body,
      );
      return JSON.stringify(formatTask(task), null, 2);
    }

    case "delete_task": {
      const args = TaskRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/pullrequests/${String(args.pr_id)}/tasks/${String(args.task_id)}`,
      );
      return JSON.stringify({ status: "deleted", task_id: args.task_id });
    }

    case "list_branches": {
      const args = ListBranchesInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const params: Record<string, string | number> = {
        pagelen: Math.min(args.max_results, 100),
        sort: "-target.date",
      };
      if (args.q !== undefined) params["q"] = args.q;
      const data = await getTyped(
        paginated(BranchSchema),
        `/repositories/${ws}/${args.repo_slug}/refs/branches`,
        params,
      );
      const branches = data.values.slice(0, args.max_results).map(formatBranch);
      return branches.length > 0 ? JSON.stringify(branches, null, 2) : "No branches found.";
    }

    case "get_branch": {
      const args = BranchRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const branch = await getTyped(
        BranchSchema,
        `/repositories/${ws}/${args.repo_slug}/refs/branches/${encodeRef(args.name)}`,
      );
      return JSON.stringify(formatBranch(branch), null, 2);
    }

    case "create_branch": {
      const args = CreateBranchInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      // Bitbucket's create-branch needs target.hash to be a commit SHA. Resolve a
      // branch name to its tip first so the documented "branch from a branch" works;
      // a bare commit hash passes through untouched.
      let hash = args.target;
      if (!/^[0-9a-f]{7,40}$/i.test(args.target)) {
        const ref = await getTyped(
          BranchSchema,
          `/repositories/${ws}/${args.repo_slug}/refs/branches/${encodeRef(args.target)}`,
        );
        // `||` (not `??`) on purpose: fall back to the original target when the
        // resolved hash is missing OR the empty string that BranchSchema's .catch("") yields.
        hash = ref.target?.hash || args.target;
      }
      const branch = await postTyped(
        BranchSchema,
        `/repositories/${ws}/${args.repo_slug}/refs/branches`,
        { name: args.name, target: { hash } },
      );
      return JSON.stringify(formatBranch(branch), null, 2);
    }

    case "delete_branch": {
      const args = BranchRefInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      await deleteVoid(
        `/repositories/${ws}/${args.repo_slug}/refs/branches/${encodeRef(args.name)}`,
      );
      return JSON.stringify({ status: "deleted", branch: args.name });
    }

    case "list_repos": {
      const args = ListReposInput.parse(rawArgs);
      const ws = resolveWs(args.workspace);
      const data = await getTyped(paginated(RepoSchema), `/repositories/${ws}`, {
        role: args.role,
        pagelen: Math.min(args.max_results, 100),
        sort: "-updated_on",
      });
      const repos = data.values.slice(0, args.max_results).map((r) => ({
        slug: r.slug,
        name: r.name,
        updated: formatTimestamp(r.updated_on),
      }));
      return JSON.stringify(repos, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============================================================================
// Server bootstrap
// ============================================================================

const server = new Server({ name: "bitbucket", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.filter((t) => isToolEnabled(t.group, t.write)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const text = await handleTool(request.params.name, request.params.arguments ?? {});
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    const message =
      err instanceof z.ZodError
        ? `Validation error: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
        : err instanceof Error
          ? err.message
          : String(err);
    return {
      content: [{ type: "text" as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BitBucket MCP server running on stdio");
}

main().catch((err: unknown) => {
  console.error("Fatal:", err);
  process.exit(1);
});
