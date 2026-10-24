---
name: data-residency-and-secrets
description: Determine where user data physically lives once indexed, embedded, or sent to third parties, whether it can be deleted, and how credentials are stored and survive packaging and auto-update across macOS and Windows in local-first applications.
---

# Data Residency and Secrets

## Purpose

Answer two questions precisely: where do the bytes actually live, and where do the credentials actually live. Both are routinely assumed rather than determined, and both are expensive to change after the architecture is set.

## When to use

Use when private corpora are indexed or embedded, when third-party inference or storage providers enter the topology, when an application stores credentials locally, or when the product makes any local-first or privacy claim to users. Run after `trust-boundary-modeling` has produced the egress ledger.

---

## Part A — Data residency

### Step 1 — Trace the corpus

For each corpus the system ingests, follow it through every stage and record where the data or its derivatives come to rest:

| Stage | Where the bytes land | Who can read them |
|---|---|---|
| Source | | |
| Chunking / preprocessing | | |
| Embedding generation | | |
| Vector store | | |
| Cache / logs | | |
| Reranking or inference | | |

Caches and logs are the most commonly missed rows. Request and response logging at a provider is a residency fact regardless of the storage design.

### Step 2 — Treat derivatives as the original

Embeddings, summaries, extracted entities, and indexes derived from private content are private content. Embedding is not anonymization — inversion and membership inference are practical enough that treating a vector store as non-sensitive is not defensible at architecture level. Apply the same residency rules to derivatives as to sources.

### Step 3 — Establish deletability

For each resting place, answer whether deletion on request is actually achievable:

- Can a specific user's or document's contribution be identified and removed?
- Does removal require reindexing the whole corpus, and is that operationally feasible?
- Do provider-side logs and caches expire on a schedule you can state?
- Are there backups or replicas outside the deletion path?

An architecture that cannot delete is making a permanent commitment on the user's behalf. Say so explicitly.

### Step 4 — Separate verified from assumed

Mark every residency and retention claim as verified (documented in provider terms, with the relevant term named) or assumed. Do not let assumed claims enter the decision record as facts. State what would verify each assumed claim.

### Step 5 — Check the claim gap

Compare what the product tells users about where their data lives against what the architecture actually does. A local-first or private product that sends corpus content to a third-party embedding API has a claim gap, and that gap is an architecture finding, not a marketing detail.

### Step 6 — Multi-tenant index check

Where a vector or search index is shared across tenants, determine whether isolation is enforced by the store or by query-time filtering in application code. Query-time filtering is code-enforced isolation and will eventually leak; flag it as such and let the board decide knowingly.

---

## Part B — Secrets in local applications

### Step 7 — Locate each secret

For every credential the application holds, record where it lives and what protects it:

| Secret | Storage location | Protected by | Survives reinstall? |
|---|---|---|---|

Preferred locations, in order: OS credential store (macOS Keychain, Windows Credential Manager / DPAPI), then an OS-protected application data directory, then encrypted-at-rest with a key that is itself in the OS store. Plaintext config files, environment files shipped with the app, and anything inside the application bundle are not acceptable resting places.

### Step 8 — Reject bundled secrets

Any secret shipped inside the distributed artifact is public. Code signing establishes authenticity, not confidentiality — a signed bundle is still readable. If the architecture requires a shared secret to reach a backend, the correct answer is a per-user credential or a broker service, not obfuscation.

### Step 9 — Cross-OS divergence

macOS and Windows diverge enough to force branching. Determine and record for each platform: which store is used, what the access-control semantics are, what happens when the signing identity changes, and what the user-facing prompt looks like on first access. On macOS, keychain item access is tied to the signing identity, so a certificate change can orphan stored items — this is a packaging concern with a security consequence.

### Step 10 — Survive packaging and auto-update

Walk the full lifecycle and state what happens to secrets at each transition: first install, normal update, downgrade or rollback, signing identity change, and uninstall. An auto-update path that silently loses or, worse, re-prompts and re-stores credentials into a weaker location is a real and common failure.

### Step 11 — Sync-path check

If the application syncs local data, determine whether the secrets store is inside the sync scope. Credentials landing in a synced or backed-up directory extend their residency to wherever that sync goes, which is usually a third-party cloud the residency analysis has not accounted for.

---

## Output format

```markdown
### Corpus residency

| Stage | Resting place | Readable by | Deletable | Verified? |
|---|---|---|---|---|

### Claim gap

- Product claims: ...
- Architecture does: ...
- Gap: ...

### Secrets

| Secret | macOS location | Windows location | Survives update? |
|---|---|---|---|

### Residency and secrets constraints for the decision record

- ...
```

## Failure modes to avoid

- Treating embeddings as anonymized derivatives.
- Recording provider retention promises as verified without naming the term that states them.
- Omitting caches, logs, and backups from the residency table.
- Designing secret storage for the happy install path and not for update, rollback, and identity change.
- Assuming a single secrets approach spans macOS and Windows without divergence.
- Escalating residency concerns for a genuinely single-user local tool operating only on the user's own files — state proportionality and move on.
