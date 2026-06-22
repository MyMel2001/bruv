# bruv

> Source control that's easier than git — with native PRs, private repos, snapshots, and AI-powered merging.

## Why bruv?

Git is powerful but painful. `bruv` fixes the common frustrations:

- **Native PR support** — not a hacky addon on top of GitHub. PRs are first-class objects stored in the repo.
- **Private PRs & snapshots** — share with select users, not the whole world.
- **Private snapshots** (not branches) — can merge multiple without conflicts by default.
- **Tags** — commits that can be pushed without conflicts.
- **Never pushes .env or credential files** — unless you explicitly use `--danger`.
- **AI-powered file safety scanning** — configure an AI endpoint to decide which files are safe.
- **Conflict-free merging** — union merge by default; when conflicts do happen, choose interactively or let AI resolve.
- **No worktrees** — merge any snapshots simultaneously without the complexity.
- **Simple conflict resolution** — no editing complex merge files. Pick A or B per file, or let AI decide.
- **Built-in API server** — Express.js on port 2658 for GitHub-like app integration (perhaps someone should make a "BruvHub"?).
- **Auth system** — `bruv auth login` with username/password for private features.

## Install

```bash
npm install -g .
```

Or use directly:

```bash
node bin/bruv.js --help
```

## Quick Start

```bash
# Initialize a repository
bruv init

# Stage files
bruv add .

# Commit
bruv commit -m "Initial commit"

# Create a snapshot (like a branch, but better)
bruv snapshot create feature-x

# Switch to a snapshot
bruv snapshot switch feature-x

# Merge snapshots (conflict-free by default!)
bruv snapshot merge main feature-x

# Create a tag
bruv tag create v1.0

# Create a pull request
bruv pr create --title "Add feature X" --source feature-x --target main

# Merge a PR
bruv pr merge <pr-id>

# Start the API server
bruv server
```

## Configuration

Config is stored in `~/.config/bruv/bruv.env`:

```env
# User identity
BRUV_USER_NAME=yourname
BRUV_USER_EMAIL=you@example.com

# API server for auth & sharing
BRUV_API_URL=https://api.bruv.sh

# AI integration (for safe file scanning and automated merge)
BRUV_AI_ENDPOINT=https://api.openai.com/v1/chat/completions
BRUV_AI_API_KEY=sk-...
BRUV_AI_MODEL=gpt-4o

# Merge behavior
BRUV_MERGE_STRATEGY=union
BRUV_CONFLICT_STRATEGY=ask

# Security
BRUV_BLOCK_ENV_FILES=true
BRUV_BLOCKED_PATTERNS=.env,.env.*,*.pem,*.key,id_rsa,credentials.json,secrets.yml
```

Set config values via CLI:

```bash
bruv config --set BRUV_USER_NAME=yourname
bruv config --set BRUV_AI_ENDPOINT=https://api.openai.com/v1/chat/completions
bruv config --list
```

## Security

bruvs **never** lets you commit `.env` or similar credential files unless you pass `--danger`:

```bash
# This will BLOCK .env files
bruv add .

# This will FORCE include .env files (NOT RECOMMENDED)
bruv add . --danger
```

### AI-Powered Safety Scanning

If you configure an AI endpoint, `bruv` will use it to determine which files are safe:

```bash
bruv config --set BRUV_AI_ENDPOINT=https://api.openai.com/v1/chat/completions
bruv config --set BRUV_AI_API_KEY=sk-your-key
bruv config --set BRUV_AI_MODEL=gpt-4o
```

Even with AI enabled, `.env` files are **always blocked** for safety.

## Snapshots vs Branches

Snapshots are like branches but better:

- **Merge multiple without conflicts** — union merge combines all files
- **Private by default** — share with select users
- **No worktrees needed** — work on multiple snapshots simultaneously

```bash
bruv snapshot create feature-a
bruv snapshot create feature-b

# Merge both into main — no conflicts!
bruv snapshot merge main feature-a feature-b
```

## Pull Requests

PRs are native first-class objects:

```bash
# Create a PR
bruv pr create --title "Feature X" --source feature-x --target main

# Create a private PR
bruv pr create --title "Secret feature" --source feature-x --target main --private

# Share a private PR
bruv pr-share <pr-id> username

# List PRs
bruv pr list

# Merge a PR
bruv pr merge <pr-id>

# Merge with custom resolution for conflicts
bruv pr merge <pr-id> --strategy custom

# Merge with AI resolution for conflicts
bruv pr merge <pr-id> --strategy automated
```

## Conflict Resolution

In the unlikely event of conflicts (same file changed in both snapshots):

### Custom Merge (Interactive)

```bash
bruv merge-resolve feature-x main --strategy custom
# You'll be asked which version to keep for each file
```

### Automated Merge (AI)

```bash
bruv merge-resolve feature-x main --strategy automated
# The configured AI decides which version to keep
```

## Authentication

```bash
# Login
bruv auth login -u username -p password

# Register
bruv auth register -u username -p password -e email@example.com

# Check status
bruv auth status

# Logout
bruv auth logout
```

## API Server

Start the REST API on port 2658:

```bash
bruv server
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/repo/info` | Repository info |
| GET | `/api/repo/status` | Working tree status |
| POST | `/api/repo/add` | Stage files |
| POST | `/api/repo/commit` | Create commit |
| GET | `/api/repo/log` | Commit history |
| GET | `/api/repo/diff` | Staged changes |
| GET | `/api/snapshots` | List snapshots |
| POST | `/api/snapshots` | Create snapshot |
| POST | `/api/snapshots/switch` | Switch snapshot |
| POST | `/api/snapshots/merge` | Merge snapshots |
| POST | `/api/snapshots/:name/share` | Share private snapshot |
| GET | `/api/tags` | List tags |
| POST | `/api/tags` | Create tag |
| GET | `/api/prs` | List PRs |
| POST | `/api/prs` | Create PR |
| GET | `/api/prs/:id` | Get PR details |
| POST | `/api/prs/:id/merge` | Merge a PR |
| POST | `/api/prs/:id/close` | Close a PR |
| POST | `/api/prs/:id/comment` | Comment on PR |
| POST | `/api/prs/:id/approve` | Approve PR |
| POST | `/api/prs/:id/share` | Share private PR |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/register` | Register |
| GET | `/api/auth/me` | Current user |
| GET | `/api/remotes` | List remotes |
| POST | `/api/remotes` | Add remote |
| POST | `/api/security/scan` | Security scan files |

## Complete Command Reference

```
bruv init                    Initialize a repository
bruv add <files...>          Stage files
bruv rm <files...>           Unstage files
bruv commit -m <msg>         Commit staged changes
bruv status                  Show working tree status
bruv log                     Show commit history
bruv diff                    Show staged changes

bruv snapshot create <name>  Create a snapshot
bruv snapshot list           List snapshots
bruv snapshot switch <name>  Switch to a snapshot
bruv snapshot delete <name>  Delete a snapshot
bruv snapshot merge <...>    Merge snapshots

bruv tag create <name>       Create a tag
bruv tag list                List tags

bruv pr create               Create a pull request
bruv pr list                 List PRs
bruv pr show <id>            Show PR details
bruv pr merge <id>           Merge a PR
bruv pr close <id>           Close a PR
bruv pr comment <id> <body>  Comment on a PR
bruv pr approve <id>        Approve a PR

bruv pr-share <id> <user>    Share a private PR
bruv branch-share <snap> <user>  Share a private snapshot

bruv merge-resolve <s> <t>   Resolve merge conflicts

bruv remote add <name> <url> Add a remote
bruv remote remove <name>    Remove a remote
bruv remote list             List remotes

bruv push                    Push to remote
bruv pull                    Pull from remote
bruv clone <url> [dest]      Clone a repository

bruv auth login              Login
bruv auth register           Register
bruv auth logout             Logout
bruv auth status             Auth status

bruv server                  Start API server
bruv config                  View/set configuration
```

## License

MIT
