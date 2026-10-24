---
name: agent-evaluation-harness
description: Specify an evaluation harness for non-deterministic agent behavior — fixed task set, trajectory versus outcome scoring, variance reporting across runs, regression definition, and drift detection — and treat its absence as a blocking architectural gap.
---

# Agent Evaluation Harness

## Purpose

An agent system without an evaluation harness cannot be improved, only rewritten. Non-determinism makes evaluation harder, not optional — a single passing run tells you nothing about a system whose behavior varies across runs. This skill specifies the harness before the system ships, and names its absence as a blocking gap rather than a follow-up.

## When to use

- Before signing off on any agent design.
- When someone proposes changing a prompt, tool, or model and cannot say how they would know it improved things.
- When a system "seems better" but the claim rests on demos.
- When behavior has drifted and no baseline exists to compare against.

## Step 1 — Fixed task set

Evaluation requires a task set that does not move. Specify:

- **Size** — enough to see variance, small enough to run often. Start where a full pass is cheap enough to run on every meaningful change.
- **Composition** — cover the happy path, the known-hard cases, the ambiguous cases, and the cases where the correct behavior is to refuse or escalate. A set with no refusal cases will not catch over-eagerness.
- **Provenance** — real traces where possible, synthetic only where real ones cannot be obtained, and label which is which.
- **Freeze rule** — the set changes only by deliberate addition, never by quiet removal of cases that started failing.

A task set that is edited whenever it fails is not an evaluation harness.

## Step 2 — Choose what is scored

There are two scoring targets and most systems need both:

| Target | What it measures | Use when |
|---|---|---|
| **Outcome** | Did the final result satisfy the task? | The end state is checkable — a file written, a value returned, a decision made |
| **Trajectory** | Did it take a sound path — right tools, no wasted loops, no unsafe steps? | Cost, latency, or safety matter, or outcomes are hard to check automatically |

Outcome-only scoring hides expensive and unsafe paths that happen to land correctly. Trajectory-only scoring rewards tidy process that fails the user. State which you are using and why.

For each, define the scorer: exact match, structural check, rubric applied by a model, or human review. Model-applied rubrics need their own spot-check against human judgement, or you are evaluating the scorer.

## Step 3 — Report variance, not a best case

Non-determinism is the whole reason this is hard. Run each task multiple times and report:

- **Pass rate across runs**, not pass/fail on one run.
- **Variance** — how much the result moves between runs on the same input.
- **Worst case** — the floor matters more than the mean for anything with side effects.
- **Cost and latency per full trajectory**, with their spread, not per model call.

A system at a high mean with a bad floor is a different risk profile than a stable system slightly below it. Report both so the board can choose.

## Step 4 — Define regression

Before any change, write down what counts as a regression:

- A drop in pass rate beyond the run-to-run variance band.
- Any new failure in a previously passing safety or refusal case — usually blocking regardless of aggregate movement.
- A trajectory cost or latency increase beyond a stated threshold.
- New variance where behavior was previously stable.

Without this written in advance, every change is arguable after the fact.

## Step 5 — Drift detection

Agent behavior moves without code changes — model updates, tool responses changing shape, retrieved content shifting underneath. Specify:

- **Cadence** — how often the fixed set runs absent any change.
- **Baseline** — the stored result the current run is compared against.
- **Alert condition** — what movement triggers a look.
- **Trace retention** — keeping enough of the failing trajectory to diagnose it later. A drift alert with no trace is a notification, not a signal.

## Step 6 — Judge the gap

If the evaluation harness cannot be specified, that finding *is* the output. Classify:

- **Blocking** — the system has side effects, spend, or user-facing output and no way to detect regression. Do not sign off.
- **Serious** — read-only or internal, but changes will be unfalsifiable. Record as accepted risk with an owner.
- **Acceptable** — a genuine throwaway prototype with a stated end date.

Most systems presented as the third are the second.

## Output

1. **Task set** — size, composition across case types, provenance, freeze rule.
2. **Scoring** — outcome, trajectory, or both, with the scorer for each.
3. **Variance plan** — runs per task, what is reported, floor as well as mean.
4. **Regression definition** — written thresholds, and which failures are blocking irrespective of aggregates.
5. **Drift detection** — cadence, baseline, alert condition, trace retention.
6. **Gap verdict** — blocking, serious, or acceptable, with reasoning.

## Red lines

- Never accept a single passing run as evidence about a non-deterministic system.
- Never allow failing cases to be quietly removed from the task set.
- Never report only the mean when the system has side effects.
- Never treat "evaluation is hard here" as a reason to skip it — it is a reason to scope it, and to record what remains unmeasured.
