# GitHub Forge - make.fun github-core-clone-01 entry

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/morashad1010/mf-github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/morashad1010/mf-github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

GitHub-compatible git forge for the [make.fun "Build a GitHub-compatible git forge"](https://make.fun/bounty/github-core-clone-01) bounty.

## Implemented

- **Git smart HTTP** (`/{owner}/{repo}.git`): upload-pack v2, receive-pack v0
- **REST v3 API** (`/api/v3`): repos, issues, pulls, contents, labels
- **GraphQL v4** (`/api/graphql`): introspection, repository, issues, pulls, createPullRequest
- **MCP** (`/mcp`): initialize, tools/list, tools/call (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request)

## Run

```bash
node --experimental-strip-types main.ts
```

Requires `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` environment variables.

## Architecture

Single Node.js 22 process, no dependencies, no git binary. In-memory object store with SHA-1 content addressing.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty.
