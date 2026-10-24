---
name: databricks-workflows-operations
description: >
  Create, update, trigger, repair, and monitor Databricks Jobs (Lakeflow Jobs) via the Databricks CLI and the Jobs API 2.x. Use for Databricks job definitions, multi-task jobs with depends_on, run-now, repair-run, rerun failed tasks, job schedules, cron triggers, run state monitoring, or troubleshooting failed Databricks job runs.
---

# Databricks Workflows Operations

## Outcome

Define, run, repair, and monitor Databricks jobs with explicit approval for every mutating call, verified run states, and a stated recovery path for failed runs.

## Setup

1. Use the current Databricks CLI (0.205+; `databricks --version`) with an authenticated profile. See the `databricks-cli-sdk-operations` skill for profiles, OAuth, and SDK setup; never place tokens or secrets in job payloads or files — use `{{secrets/scope/key}}` references for credentials inside task configuration.
2. Confirm the target workspace and identity (`databricks current-user me --profile <name>`) before creating or triggering anything.
3. Check feature availability against your workspace: serverless vs. classic compute, `environments` for serverless tasks, and trigger types differ by cloud and release. Verify against the Jobs API reference before relying on a field.

## Job definition and lifecycle

- Inspect before changing: `databricks jobs get <job-id> --output json > before.json`. Store the prior definition so updates are reversible.
- Create from JSON: `databricks jobs create --json @job.json`. A multi-task job defines `tasks[]` each with `task_key`, a task type (`notebook_task`, `spark_python_task`, `pipeline_task`, `run_job_task`), and `depends_on: [{task_key: ...}]` for the DAG.
- Update deliberately: `databricks jobs update --job-id <id> --json @job.json` replaces settings; `databricks jobs reset --job-id <id> --json @job.json` overwrites all settings. Prefer `update`; use `reset` only with the full prior definition saved.
- Schedules and triggers: `schedule: {quartz_cron_expression, timezone_id, pause_status}` for cron, `trigger: {file_arrival|table_update|continuous}` where supported. Set `pause_status: PAUSED` on new jobs until the schedule is approved.

## Run, repair, monitor

- Trigger: `databricks jobs run-now --job-id <id>` returns `run_id`. Pass parameters with `--json '{"job_parameters": {...}}'` or task-scoped `--notebook-params`, `--python-params`.
- Monitor: `databricks jobs runs get --run-id <id>`; watch `state.life_cycle_state` (PENDING → RUNNING → TERMINATING → TERMINATED, or SKIPPED/INTERNAL_ERROR) and `state.result_state` (SUCCESS, FAILED, TIMEDOUT, CANCELED). For task-level detail, `databricks jobs runs get-output --run-id <task_run_id>`.
- Repair instead of blind rerun: `databricks jobs repair-run --run-id <id> --rerun-all-failed-tasks` (or `--rerun-tasks task_a,task_b`) reuses successful task output and reruns only failures. This is the default recovery path; full `run-now` re-executes everything.
- Cancel: `databricks jobs runs cancel --run-id <id>` — mutating, requires approval and a reason.

REST equivalents: `POST /api/2.1/jobs/create`, `POST /api/2.1/jobs/run-now`, `POST /api/2.1/jobs/runs/repair`, `GET /api/2.1/jobs/runs/get`. List endpoints paginate via `next_page_token` (use `limit` ≤ 100 and loop).

## Permissions and safety

- The caller needs `CAN VIEW` to inspect, `CAN MANAGE RUN` to trigger/cancel/repair, `CAN MANAGE` to update, reset, or delete. Keep automation on a service principal with only these grants.
- Read-only (`jobs get`, `runs list`, `runs get`, `runs get-output`) is unrestricted. `run-now`, `repair-run`, `update`, `reset`, `cancel`, `delete` are mutating: present the exact job ID, the diff or intended run, and get explicit user approval first. `delete` is destructive and needs a saved definition for rollback.
- Workflow: inspect → plan (diff of settings, or run with parameters) → execute → verify (`runs get` until terminal state, check `result_state`) → repair or roll back (restore saved definition with `reset`).

## Troubleshooting

- Run stuck in PENDING: cluster policy or max concurrent runs (`max_concurrent_runs`) blocks it; check `databricks jobs runs list --job-id <id>` for queued runs.
- `result_state: FAILED` on one task: `runs get-output --run-id <task_run_id>` for the traceback, then `repair-run --rerun-tasks <task_key>` after the fix.
- `INVALID_PARAMETER_VALUE` on create/update: validate the JSON against the Jobs API reference — common causes are a missing `task_key`, bad `depends_on` target, or a field your workspace version does not support.
- Cron fires at the wrong time: `timezone_id` must be an IANA name (e.g. `Europe/Warsaw`); UTC is not implied.
- Repair rejected: the run has no failed tasks or is too old; use `run-now` with task-scoped parameters instead.

## References

- Lakeflow Jobs overview: https://docs.databricks.com/en/jobs/
- Jobs API — create: https://docs.databricks.com/api/workspace/jobs/create
- Jobs API — run-now: https://docs.databricks.com/api/workspace/jobs/runnow
- Jobs API — repair run: https://docs.databricks.com/api/workspace/jobs/repairrun
- Jobs API — get run: https://docs.databricks.com/api/workspace/jobs/getrun

## Shared resources

Load only if the task needs them; the skill is self-contained without them.

- `../../templates/pipeline-design-specification.md`
- `../../references/reliability-and-slo-guide.md`

## Completion check

The job definition matches the approved JSON (`jobs get` diff is empty), the triggered run reached a terminal state with the expected `result_state`, failed tasks were repaired rather than silently rerun, and the schedule `pause_status` matches what was approved.
