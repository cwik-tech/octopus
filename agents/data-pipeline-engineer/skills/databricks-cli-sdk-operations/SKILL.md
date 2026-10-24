---
name: databricks-cli-sdk-operations
description: >
  Operate a Databricks workspace with the current Databricks CLI (Go-based, version 0.205 or later), the Databricks SDK for Python, and the Databricks REST API 2.0. Use when authenticating to Databricks, managing config profiles, inspecting clusters, jobs, or workspace files, scripting with databricks-sdk, calling /api/2.0 endpoints directly, handling pagination, or troubleshooting Databricks CLI errors.
---

# Databricks CLI and SDK Operations

## Outcome

Run authenticated, least-privilege Databricks operations from the CLI, Python SDK, or REST API, with verified versions, predictable pagination and error handling, and mutating actions gated on approval.

## Setup

1. Verify the current CLI, not the legacy Python CLI: `databricks --version` must report 0.205 or later. Install or upgrade per the docs; on macOS `brew install databricks` or `brew upgrade databricks`.
2. Authenticate with OAuth user login (preferred, no stored secret): `databricks auth login --host https://<workspace-host>` creates a profile in `~/.databrickscfg`. For automation use an OAuth service principal: set `DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` from the environment or a secret store. Never write tokens, client secrets, or PATs into files, prompts, logs, or artifacts; reference env vars.
3. Select profiles explicitly: `databricks --profile prod workspace list /` or `export DATABRICKS_CONFIG_PROFILE=prod`. Confirm identity and target before any change: `databricks current-user me --profile prod` and check the workspace URL printed.
4. For the Python SDK, require a recent `databricks-sdk` (`pip show databricks-sdk`); it reads the same env vars and `~/.databrickscfg` profiles.

## Core command patterns

Read-only first; the same patterns apply to mutating calls after approval.

- Workspace: `databricks workspace list /Users` (add `--recursive` for a tree), `databricks workspace export /path/notebook -o out.ipynb`.
- Clusters: `databricks clusters list --output json`, `databricks clusters get <cluster-id>`.
- Jobs: `databricks jobs list --output json`, `databricks jobs get <job-id>`, `databricks jobs run-now --job-id <id>`.
- REST fallback for endpoints without a CLI wrapper: `curl -H "Authorization: Bearer $(databricks auth token --profile prod | jq -r .access_token)" https://<workspace-host>/api/2.0/clusters/list`. CLI command and flag names mirror the REST operation names; check the CLI commands reference before scripting.
- Python SDK: `from databricks.sdk import WorkspaceClient; w = WorkspaceClient(profile="prod")`, then `for c in w.clusters.list(): ...` — SDK list calls auto-paginate.

## Pagination and errors

- CLI list commands paginate automatically; the REST API returns `next_page_token` (or `has_more` with offset on older endpoints). When scripting against REST, loop until no `next_page_token`; never assume one page.
- Use `--output json` plus `jq` for parsing. Diagnose failures with `--debug` for request/response traces — the trace can contain headers, so do not paste it into artifacts.
- Map HTTP status to action: 401/403 = auth or permission (re-run `databricks auth login` or check the token's workspace), 404 = wrong workspace or ID, 429 = back off and retry with jitter.

## Permissions and safety

- Grant least privilege: workspace access entitlement, `CAN USE` on clusters and `CAN MANAGE RUN` or `CAN MANAGE` on jobs only where needed. Automation uses a service principal, never a personal account.
- Read-only operations (`list`, `get`, `export`, `current-user`) need no approval. Mutating operations (`create`, `update`, `run-now`, `start`, `restart`, `delete`) require a written plan and explicit user approval. Destructive operations (`delete`, `reset`, cluster permanent termination) additionally require naming the exact resource ID and a stated rollback path.
- Workflow: inspect (read-only) → plan (proposed calls with IDs and diffs) → execute → verify (re-read the object or run state) → rollback or roll forward.

## Troubleshooting

- `Error: cannot configure default credentials`: no auth configured; run `databricks auth login --host <url>` or set the env vars for your auth type.
- Commands hit the wrong workspace: a profile or `DATABRICKS_HOST` from a parent shell overrides intent; check `databricks auth env --profile <name>` and unset stray env vars.
- 403 on a valid token: the identity lacks workspace entitlement or object ACL; verify with `databricks current-user me` and check object-level permissions.
- Legacy CLI behavior (`databricks configure --token`, different flags): you are on CLI 0.18 or older; upgrade to 0.205+.
- SDK raises `NotFound` or `PermissionDenied` from `databricks.sdk.errors`: catch the mapped exception classes, not generic `Exception`.

## References

- Databricks CLI overview: https://docs.databricks.com/en/dev-tools/cli/index.html
- CLI auth commands: https://docs.databricks.com/en/dev-tools/cli/auth-commands.html
- Configuration profiles: https://docs.databricks.com/en/dev-tools/auth/config-profiles.html
- OAuth M2M (service principals): https://docs.databricks.com/en/dev-tools/auth/oauth-m2m.html
- REST API reference: https://docs.databricks.com/api/workspace/introduction
- SDK for Python: https://docs.databricks.com/en/dev-tools/sdk-python.html and https://pypi.org/project/databricks-sdk/

## Shared resources

Load only if the task needs them; the skill is self-contained without them.

- `../../references/security-control-baseline.md`

## Completion check

`databricks current-user me` returns the intended identity in the intended workspace, every mutating call was approved and re-read to confirm the resulting state, and no secret appears in any file, prompt, log, or artifact.
