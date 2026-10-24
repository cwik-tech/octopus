# Search strategy

Search for the answer, not for coverage. Start close to the code, follow concrete leads, and broaden only when the expected information gain justifies the cost and access.

## Evidence ladder

Use this order unless the question gives a stronger starting point:

1. Current code, tests, comments, configuration, and repository documents.
2. Commit history, blame, diffs, reviews, merge requests, and release notes.
3. Linked issues, decision records, specifications, migration plans, and postmortems.
4. Relevant team discussions and meeting records.
5. Runtime telemetry, error history, feature-flag records, experiments, analytics, support records, and warehouse data.

Later steps are not inherently more authoritative. They are farther from the code and often more sensitive or expensive to search.

## Choose sources from cues

| Question or code cue | Start with | Expand when needed |
|---|---|---|
| Named design choice or rejected alternative | Reviews, decision records, specifications | Issues and discussion threads |
| Guard, fallback, retry, timeout, or rate limit | Commit and review history, tests | Incidents, errors, telemetry |
| Numeric threshold or capacity limit | Commit history, comments, upstream contract | Metrics, analytics, experiments |
| Product rule or customer-visible behavior | Issues and product documents | Support records, analytics, discussions |
| Migration, compatibility path, or legacy branch | File history, release notes, migration documents | Incidents and customer constraints |
| Security, privacy, or compliance control | Decision records, security review, policy | Incident and audit records within scope |
| Code that appears unused | Call sites, feature flags, release history | Issues, support records, ownership history |

These are starting points, not mandatory source lists.

## Build the local anchor

Adapt to the available source-control system and repository state. Useful Git operations include:

```bash
git status --short --branch
git remote -v
git blame -L <start>,<end> -- <file>
git log --follow --oneline -- <file>
git log -S '<exact text>' -p -- <path>
git log -G '<pattern>' -p -- <path>
git show <commit> -- <path>
```

Use symbol history when the installed Git version supports it. Inspect ignored-revision configuration before relying on blame. If history is shallow or the file was generated, vendored, moved without detectable similarity, or imported from another repository, say so.

For hosted reviews and issues, detect the remote host and use its available CLI, API, connector, or web interface. Do not assume GitHub or a particular command-line tool.

## Use two bounded passes

### First pass

Search the code anchor and the one or two sources most likely to contain the rationale. Capture stable identifiers and outbound leads.

Stop after the first pass when the record explicitly answers the exact question, the implementation matches it, and no material contradiction appears.

### Follow-up pass

Rank new leads by expected value:

1. A direct link or identifier tied to the change.
2. A contemporaneous record from a decision participant.
3. A source that could confirm or refute the leading explanation.
4. A broad keyword search with no direct connection.

Pursue the strongest leads within the remaining budget. Record unsearched lower-value leads rather than following them indefinitely.

## Search for disconfirming evidence

Do not search only for the user's guess or the first plausible explanation. Try at least one query for:

- a competing reason;
- a later reversal or superseding decision;
- a neighboring change that could explain the same telemetry;
- evidence that the documented plan did not ship;
- evidence that the current behavior survived after its original constraint disappeared.

## Bound the work

Choose limits that fit the question. Consider:

- maximum source categories;
- maximum connector calls or pages opened;
- time range around the change;
- maximum telemetry or warehouse scan;
- maximum follow-up depth;
- maximum quoted material.

Use aggregation and narrow filters for high-volume systems. Stop rather than broadening silently when a useful next step would exceed the budget or authorization.

## Optional delegation

Delegation can reduce latency when several independent sources must be searched. It is not required.

If available:

- divide work by independent question or source capability;
- give each investigator the same code anchor, scope, budget, and evidence model;
- require structured findings and stable citations;
- prevent writes and cross-scope access;
- reconcile results before assigning follow-up leads;
- cap concurrency to the runtime's limit.

Do not prescribe agent types, model names, or platform-specific modes. A single capable agent should be able to execute the full workflow sequentially.
