---
name: data-security-checklist
description: >
  Screen a data design or release for classification, least privilege, encryption, secrets, masking, retention, deletion, audit, and non-production use. Use during intake, design review, contract review, and production readiness; escalate detailed threat modeling, privacy law, and certification work.
---

# Data Security Checklist

## Scope

This is a cross-cutting screening control, not a substitute for a security, privacy, legal, or compliance specialist.

## Method

1. Inventory sensitive fields and assign a classification with an owner and authority.
2. Map each principal, service, environment, and consumer to the minimum required access. Separate authentication from authorization.
3. Verify encryption requirements in transit and at rest, including backups, replicas, logs, exports, and temporary storage.
4. Verify secrets are externally managed, scoped, rotated, and excluded from code, logs, fixtures, and artifacts.
5. Define masking, tokenization, or aggregation for sensitive fields and prove downstream copies inherit the policy.
6. Define retention, legal hold, deletion, and propagation to derived datasets, caches, backups, and non-production environments.
7. Define audit events for access, privilege changes, exports, destructive operations, and policy overrides without logging protected values.
8. Review non-production data use, synthetic alternatives, incident response, and break-glass access.

## Escalate when

- The legal basis, consent, residency, or regulatory interpretation is unclear.
- Threat modeling, penetration testing, certification, or infrastructure security is required.
- Cross-border transfer, re-identification, cryptographic design, or privileged access creates material risk.

## Shared resources

Load only the resources needed for the current task. The links resolve inside the current agent package.

- `../../references/security-control-baseline.md`
- `../../templates/production-readiness-checklist.md`
- `../../templates/data-contract.yaml`

## Output

Return each control as satisfied, unsatisfied, not applicable with rationale, or decision-blocking. Name the owner and evidence for every satisfied control.
