# Workflows

This folder contains the inter-team workflow layer.

- `registry.yaml` registers reusable workflow templates
- `templates/` contains workflow YAML definitions
- `types.ts` defines the workflow contract model
- `loader.ts` loads workflow registry entries and workflow templates
- `validation.ts` checks workflow-template consistency against the team registry
- `selector.ts` retains the dormant legacy deterministic matcher for possible
  future offline fallback or retrieval shortlisting. Run chat and
  `spawn_workflow` do not use it for semantic selection.
- `handoff.ts` maps prior workflow artifacts into the next step brief
- `runner.ts` executes declared workflow steps deterministically through team delegation
- `results.ts` normalizes workflow-level result summaries

`team.yaml` remains the intra-team workflow definition.

Active semantic selection is performed by an LLM from the injected set of
preflight-valid workflows. The server accepts only an exact structured
workflow id from that set. Run Orchestrator remains responsible for
deterministic brief readiness, persistence, launch validation, authorization,
concurrency, and execution.

The deterministic planning/readiness policy lives in
`domains/run-orchestrator/`, with public plan shapes in
`contracts/run-plan.ts`. Application services own persistence, admission, and
launch coordination.

This folder contains the contracts and runtime for inter-team workflow
execution; it is not the active semantic-selection authority.
