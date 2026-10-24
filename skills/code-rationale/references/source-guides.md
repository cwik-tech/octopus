# Source guides

Read only the sections that match the available capabilities and the investigation plan. Tool names differ by environment. Inspect current tool descriptions or schemas instead of guessing command names.

## Repository and source-control history

Best for implementation chronology, shipped diffs, review-time tradeoffs, nearby tests, and links to other records.

Search:

- line and symbol history;
- commits that introduced or changed exact strings and constants;
- reviews or merge requests tied to substantive commits;
- related files and tests changed in the same work;
- repository decision records, changelogs, release notes, TODOs, and explanatory comments;
- reverts, follow-up fixes, backports, and later removals.

Watch for squash merges, ignored revisions, rebases, shallow clones, generated code, automated commits, misleading summaries, and history that moved between repositories. Source control is close to the implementation, but its messages may still omit or simplify the reason.

Return the commit or review identifier, stable link, author, date, relevant excerpt, affected code, and whether the record states rationale or only shows chronology.

## Issues and work tracking

Best for product needs, customer constraints, incident follow-ups, deadlines, ownership, scope changes, and links to specifications.

Start with issue identifiers found in commits and reviews. Read the full issue history, comments, parent relationships, duplicates, labels, linked documents, and status changes. Compare issue dates and scope with the shipped change.

Watch for boilerplate motivation, stale acceptance criteria, reopened issues, renamed projects, copied descriptions, and inaccessible private content.

Return identifiers, links, relevant dates, the stated problem or decision, scope changes, and links worth following.

## Specifications, decision records, and long-form documents

Best for alternatives, constraints, planned architecture, meeting decisions, migration plans, and postmortems.

Search by feature name, symbol, issue key, error string, review link, owning team, and the decision window. Follow direct backlinks and child pages within scope. Prefer finalized, contemporaneous records but preserve older drafts when they explain how the decision changed.

Do not search personal notebooks or unrelated private spaces without explicit authorization. Watch for plan-versus-implementation drift, abandoned drafts, copied templates, missing attachments, and documents written after the fact.

Return title, stable link, author or decision owner, status, dates, relevant section, short excerpt or summary, and discrepancies with shipped behavior.

## Team discussions and meeting records

Best for deliberation that never reached formal documentation, especially around incidents and small tactical changes.

Search direct identifiers first, such as a review URL, issue key, incident ID, error string, or feature-flag name. Bound searches by relevant channels, teams, and dates. Read the surrounding thread or meeting record rather than an isolated message.

Do not search direct messages, personal spaces, or unrelated channels without explicit authorization. Casual comments, jokes, partial excerpts, deleted history, retention limits, and recollections made long after the decision all reduce confidence.

Return a permalink or stable identifier, participants relevant to the decision, date range, minimal excerpt or paraphrase, surrounding context, and any unresolved disagreement.

## Incidents and operational telemetry

Best for defensive code, retries, timeouts, fallbacks, capacity limits, and reliability controls.

Search incidents, monitors, dashboards, metrics, traces, and tightly bounded logs around the change date. Compare the exact service, error, dimension, or threshold with the code. Look for incident action items or links that name the change.

Telemetry correlation is not stated motivation. A metric spike before a change and improvement afterward may support an explanation, but neighboring deployments, traffic changes, sampling, renamed telemetry, retention, and manual incident resolution can produce the same pattern.

Return the operational identifier, service and environment, query or condition, time range, compact aggregate, relevant chronology, and limits on causal interpretation.

## Error and exception history

Best for guards, catches, validation, retries, fallbacks, and corrective changes.

Search by exception type, message, file, function, release, and a tight time window. Check representative events, stack relevance, first and last seen dates, affected releases, grouping changes, sampling, and engineer comments.

An error disappearing after a release does not prove which commit fixed it. Check other changes in the release and possible regrouping or upstream fixes. Treat automated root-cause summaries as hypotheses unless primary events support them.

Return the issue or event identifier, project and environment, bounded counts, release chronology, minimal stack excerpt, comments, and alternative explanations.

## Analytics, experiments, flags, and warehouse records

Best for feature adoption, thresholds derived from distributions, experiment decisions, usage scale, migration cost, and retention of apparently unused behavior.

Orient within the authorized project and schema before querying. Confirm table and column meaning from current metadata. Use aggregates, row limits, explicit time windows, and read-only queries. Prefer maintained, typed models over raw event tables when their historical coverage fits the decision date.

Watch for instrumentation changes, schema drift, duplicate events, refresh lag, retention, sampled data, experiment assignment errors, and queries whose breadth creates cost or privacy risk. A distribution matching a code constant is supporting evidence, not proof that the data caused the choice.

Return the exact query or saved analysis identifier, authorized dataset, time range, compact numeric summary, data-quality limitations, and how it bears on the rationale.

## Support, customer, policy, and upstream records

Best when the change responds to a contractual requirement, support pattern, compliance rule, dependency limitation, or external API contract.

Search only the relevant authorized account, product, policy, or upstream documentation. Prefer de-identified counts and stable contract text over individual conversations. Check the version and effective date that applied when the code changed.

Watch for expired requirements, one-customer exceptions described as general rules, mutable vendor documentation, confidential terms, and support tags that do not establish causation.

Return the policy, contract, upstream version, de-identified support pattern, or stable source that states the constraint. Explain whether it still applies today.
