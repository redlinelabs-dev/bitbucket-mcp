# @redlinelabs/bitbucket-mcp

MCP server for Bitbucket Cloud. Gives AI assistants (Claude Desktop, Claude Code, etc.) tools to browse pull requests, review diffs, post comments, approve/request changes, and more.

## Tools

Tools are organized into **toolsets** (groups) you can enable/disable — see
[Toolsets](#toolsets). `✏️` marks mutating (write) tools, which can be disabled all at
once with `BITBUCKET_READ_ONLY`.

### `pulls`

| Tool                   | Description                                          |
| ---------------------- | ---------------------------------------------------- |
| `my_review_queue`      | PRs where you are a reviewer                         |
| `my_open_prs`          | PRs you authored                                     |
| `pr_details`           | Full PR details (description, reviewers w/ approval) |
| `pr_diffstat`          | Changed files summary (lighter than full diff)       |
| `pr_diff`              | Full unified diff                                    |
| `pr_activity`          | Timeline of approvals, updates, comments             |
| `pr_commits`           | Commits that make up the PR                          |
| `pr_statuses`          | Build/CI statuses reported on the PR                 |
| `create_pr` ✏️         | Open a new pull request                              |
| `update_pr` ✏️         | Edit a PR (description, title, reviewers, …)         |
| `merge_pr` ✏️          | Merge a PR (destructive)                             |
| `decline_pr` ✏️        | Decline/reject a PR (destructive)                    |
| `approve_pr` ✏️        | Approve a PR                                         |
| `unapprove_pr` ✏️      | Remove your approval                                 |
| `request_changes` ✏️   | Request changes on a PR                              |
| `unrequest_changes` ✏️ | Remove your "request changes" status                 |

### `comments`

| Tool                 | Description                                  |
| -------------------- | -------------------------------------------- |
| `pr_comments`        | Threaded comments with inline file/line info |
| `add_comment` ✏️     | Post a comment (general, inline, or reply)   |
| `update_comment` ✏️  | Edit an existing comment                     |
| `delete_comment` ✏️  | Delete a comment (destructive)               |
| `resolve_comment` ✏️ | Resolve a comment thread                     |
| `reopen_comment` ✏️  | Reopen (unresolve) a comment thread          |

### `tasks`

| Tool             | Description                                |
| ---------------- | ------------------------------------------ |
| `pr_tasks`       | List PR tasks with resolved state          |
| `add_task` ✏️    | Add a task to a PR                         |
| `update_task` ✏️ | Edit a task or mark it resolved/unresolved |
| `delete_task` ✏️ | Delete a task (destructive)                |

### `branches`

| Tool               | Description                          |
| ------------------ | ------------------------------------ |
| `list_branches`    | List branches (name, latest commit)  |
| `get_branch`       | Get one branch by full name          |
| `create_branch` ✏️ | Create a branch from a commit/branch |
| `delete_branch` ✏️ | Delete a branch (destructive)        |

### `repos`

| Tool         | Description                 |
| ------------ | --------------------------- |
| `list_repos` | List repos in the workspace |

## Setup

### 1. Create a Bitbucket API Token

Go to **Bitbucket > Personal settings > API tokens** and create one with read/write access to repositories and pull requests.

### 2. Configure environment

Create a `.env` file (or pass env vars directly):

```env
BITBUCKET_API_TOKEN=your-api-token
BITBUCKET_EMAIL=your-atlassian-email
BITBUCKET_USERNAME=your-bitbucket-username
BITBUCKET_WORKSPACE=your-workspace
```

- `BITBUCKET_EMAIL` — your Atlassian account email (used for API token auth)
- `BITBUCKET_USERNAME` — your Bitbucket username (used for filtering PRs by user)
- `BITBUCKET_WORKSPACE` — default workspace (tools accept a `workspace` arg to override)
- `BITBUCKET_REPOS` — optional comma-separated repo allowlist (skips repo discovery)
- `BITBUCKET_TOOLSETS` — optional comma-separated [toolsets](#toolsets) to expose (default: all)
- `BITBUCKET_READ_ONLY` — optional; set to `true` to expose only read tools

### 3. Add to Claude Code

```bash
claude mcp add --transport stdio \
  --env BITBUCKET_API_TOKEN=your-api-token \
  --env BITBUCKET_EMAIL=your-atlassian-email \
  --env BITBUCKET_USERNAME=your-bitbucket-username \
  --env BITBUCKET_WORKSPACE=your-workspace \
  bitbucket -- npx -y @redlinelabs/bitbucket-mcp
```

Env vars are scoped to the server process — no global environment setup needed.

### 4. Add to Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "bitbucket": {
      "command": "npx",
      "args": ["-y", "@redlinelabs/bitbucket-mcp"],
      "env": {
        "BITBUCKET_API_TOKEN": "your-api-token",
        "BITBUCKET_EMAIL": "your-atlassian-email",
        "BITBUCKET_USERNAME": "your-bitbucket-username",
        "BITBUCKET_WORKSPACE": "your-workspace",
        "BITBUCKET_REPOS": "repo-name-one,repo-name-two"
      }
    }
  }
}
```

## Toolsets

To avoid bloating the model's context window, you can expose only the tool groups you
need. Two independent controls:

- **`BITBUCKET_TOOLSETS`** — comma-separated group names, or `all` (default). Groups:
  `pulls`, `comments`, `tasks`, `branches`, `repos`.
- **`BITBUCKET_READ_ONLY`** — `true`/`1` exposes only non-mutating tools (drops every `✏️`
  tool across all enabled groups).

```env
# Only PR + comment tools, and never anything that writes:
BITBUCKET_TOOLSETS=pulls,comments
BITBUCKET_READ_ONLY=true
```

Disabled tools are hidden from `tools/list` and rejected if called directly.

## Development

```bash
npm install
npm run dev       # watch mode
npm run check     # typecheck + lint + format check
npm run build     # production build
```

## Versioning

This project uses [0ver](https://0ver.org/) (zero-based versioning). The major version will remain at `0` indefinitely. Breaking changes bump the minor version; features and fixes bump the patch version.

Releases are automated via [release-please](https://github.com/googleapis/release-please). Commits must follow [Conventional Commits](https://www.conventionalcommits.org/).
