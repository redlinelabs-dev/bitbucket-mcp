#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// ============================================================================
// Config
// ============================================================================

const USERNAME = process.env["BITBUCKET_USERNAME"] ?? "";
const APP_PASSWORD = process.env["BITBUCKET_APP_PASSWORD"] ?? "";
const WORKSPACE = process.env["BITBUCKET_WORKSPACE"] ?? "";
const BASE = "https://api.bitbucket.org/2.0";
const AUTH_HEADER = "Basic " + Buffer.from(`${USERNAME}:${APP_PASSWORD}`).toString("base64");

if (!USERNAME || !APP_PASSWORD) {
  console.error("BITBUCKET_USERNAME and BITBUCKET_APP_PASSWORD env vars are required.");
  process.exit(1);
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
  const contentLength = r.headers.get("content-length");
  if (contentLength === "0") return schema.parse({});
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
  const data = await getTyped(paginated(RepoSchema), `/repositories/${ws}`, {
    role: "contributor",
    pagelen: 100,
  });
  return data.values.map((r) => r.slug);
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

const AddCommentInput = z.object({
  repo_slug: z.string(),
  pr_id: z.number(),
  content: z.string(),
  workspace: z.string().optional(),
  file_path: z.string().optional(),
  line: z.number().optional(),
  parent_comment_id: z.number().optional(),
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
// ============================================================================

const TOOLS = [
  {
    name: "my_review_queue",
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
    name: "add_comment",
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
    name: "approve_pr",
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
    name: "list_repos",
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

// ============================================================================
// Tool handlers
// ============================================================================

async function handleTool(name: string, rawArgs: unknown): Promise<string> {
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
  tools: [...TOOLS],
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
