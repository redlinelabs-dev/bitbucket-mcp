# @redlinelabs/bitbucket-mcp

MCP server for Bitbucket Cloud. Gives AI assistants (Claude Desktop, Claude Code, etc.) tools to browse pull requests, review diffs, post comments, approve/request changes, and more.

## Tools

| Tool              | Description                                        |
| ----------------- | -------------------------------------------------- |
| `my_review_queue` | PRs where you are a reviewer                       |
| `my_open_prs`     | PRs you authored                                   |
| `pr_details`      | Full PR details (description, reviewers, branches) |
| `pr_comments`     | Threaded comments with inline file/line info       |
| `pr_diffstat`     | Changed files summary (lighter than full diff)     |
| `pr_diff`         | Full unified diff                                  |
| `pr_activity`     | Timeline of approvals, updates, comments           |
| `add_comment`     | Post a comment (general, inline, or reply)         |
| `approve_pr`      | Approve a PR                                       |
| `unapprove_pr`    | Remove your approval                               |
| `request_changes` | Request changes on a PR                            |
| `list_repos`      | List repos in the workspace                        |

## Setup

### 1. Create a Bitbucket App Password

Go to **Bitbucket > Personal settings > App passwords** and create one with read/write access to repositories and pull requests.

### 2. Configure environment

Create a `.env` file (or pass env vars directly):

```env
BITBUCKET_USERNAME=your-username
BITBUCKET_APP_PASSWORD=your-app-password
BITBUCKET_WORKSPACE=your-workspace
```

### 3. Add to Claude Code

```bash
claude mcp add --transport stdio \
  --env BITBUCKET_USERNAME=your-username \
  --env BITBUCKET_APP_PASSWORD=your-app-password \
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
        "BITBUCKET_USERNAME": "your-username",
        "BITBUCKET_APP_PASSWORD": "your-app-password",
        "BITBUCKET_WORKSPACE": "your-workspace"
      }
    }
  }
}
```

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
