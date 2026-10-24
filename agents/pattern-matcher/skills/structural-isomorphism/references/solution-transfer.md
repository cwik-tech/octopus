# Solution Transfer Checklist

A protocol for evaluating whether a source domain's solution can be transferred to the target domain after a structural isomorphism has been verified.

---

## The Five Transfer Tests

### Test 1: Mechanism Extraction

**Question:** What is the source domain's solution *mechanism* — the abstract principle, not the specific implementation?

**Protocol:**

1. State the source domain's solution in domain-specific terms.
2. Strip the domain-specific terms. Replace every noun with its abstract equivalent.
3. What remains is the mechanism.

**Examples:**

- "Coronary artery bypass graft" → "Create a parallel path that routes flow around the bottleneck, leaving the bottleneck in place."
- "A/B testing" → "Run parallel experiments on random subsets of the population to compare alternatives with controlled variance."
- "Vaccine" → "Expose the system to a low-cost simulation of the threat so it develops a fast-response capability before the real threat arrives."

**Red flag:** If you can't extract a clean mechanism, the solution may be too domain-specific to transfer.

---

### Test 2: Condition Check

**Question:** What conditions does the source solution depend on? Do those conditions exist in the target domain?

| Condition type | Example (source: medicine) | What to check in target |
|---------------|---------------------------|------------------------|
| **Physical possibility** | The bypass vessel can be grafted | Can you actually build a parallel path? |
| **Accessibility** | The surgeon can reach the blockage | Can you access the intervention point? |
| **Reversibility** | If the bypass fails, other treatments exist | If the transferred solution fails, can you recover? |
| **Measurement** | Blood flow can be measured before and after | Can you measure the relevant variable? |
| **Controllability** | The surgeon can control the intervention | Can you control the implementation precisely? |

**Decision rule:** If more than 2 critical conditions are absent, the solution likely doesn't transfer directly. Consider whether the mechanism can be adapted.

---

### Test 3: Constraint Check

**Question:** What constraints exist in the target domain that don't exist in the source domain?

| Constraint type | Impact on transfer |
|----------------|-------------------|
| **Regulatory** | May block entire categories of intervention |
| **Political** | Mechanism is sound but can't be implemented |
| **Resource** | Mechanism works but is too expensive |
| **Cultural** | Mechanism works but will be rejected |
| **Technical** | Mechanism works but can't be built |
| **Temporal** | Mechanism works but too slowly or too quickly |

---

### Test 4: Cost Check

**Question:** What does the solution cost in abstract terms, and is a comparable cost acceptable?

Cost categories: resource cost, disruption cost, opportunity cost, risk cost, maintenance cost.

**Key question:** In the source domain, the cost is justified because [X]. Does the same justification hold in the target?

**Example:** Bypass surgery costs $100K+ and weeks of recovery — justified because the alternative is death. Supply chain equivalent ($2M, 6 months) — is the bottleneck costing more than $2M in that timeframe? If not, the cost doesn't justify the transfer.

---

### Test 5: Failure Mode Check

**Question:** How does the source solution fail when it fails? Would that failure mode be acceptable in the target?

**Protocol:**

1. Identify the 2–3 most common failure modes of the source solution.
2. Map each to its equivalent in the target domain.
3. Flag any failure mode that is catastrophic in the target but manageable in the source.

**Example:**
- Source (epidemiology — vaccination): Failure modes: (a) insufficient uptake, (b) variant escape, (c) adverse reactions in small subset.
- Target (organizational change — "inoculation" against disruption): (a) insufficient adoption, (b) the disruption takes a different form than anticipated, (c) the preparation exercise itself causes anxiety in some teams.

---

## Transfer Verdict

```
### Solution Transfer Assessment

**Source solution:** [domain-specific description]
**Extracted mechanism:** [abstract mechanism]

| Test | Result | Notes |
|------|--------|-------|
| Mechanism extraction | Clear / Unclear | [one sentence] |
| Condition check | [N/M conditions present] | [critical gaps] |
| Constraint check | [N novel constraints] | [blocking constraints] |
| Cost check | Justified / Marginal / Unjustified | [key cost concern] |
| Failure mode check | Acceptable / Manageable / Catastrophic | [critical failure mode] |

**Transfer verdict:** Transfers / Partially transfers / Does not transfer
**What transfers:** [the specific part that works]
**What doesn't:** [the specific part that breaks]
**Adaptation needed:** [what must change for the mechanism to work]
```

---

## Transfer Strategies (for partial transfers)

1. **Mechanism decomposition** — Break into sub-mechanisms. Some may transfer even if the whole doesn't.

2. **Constraint-aware redesign** — Accept the target domain's constraints and redesign the implementation. The abstract principle holds; the implementation is new.

3. **Partial transfer + domain extension** — Transfer what works, fill gaps with domain-specific expertise (from the Domain Researcher).

4. **Inverse transfer** — Instead of transferring the solution, transfer the *failure mode analysis*. "This problem has the same structure as X, and in X the failure mode is Y. Let's make sure our solution avoids Y."

5. **Metaphorical seeding** — Even when the transfer is too weak for direct mechanism import, the structural match can *seed* domain-specific innovation by giving the Innovator a generative frame.

---

## When to Stop

Not every structural match needs a solution transfer. Sometimes the most valuable output is:

- **A failure mode warning:** "This has the same structure as X, which collapsed via Y. Watch for Y."
- **A reframe:** "We've been treating this as a flow problem, but structurally it's a coordination problem. The solutions are completely different."
- **A structural diagnosis:** "The reason nothing is working is that this is a tragedy of the commons, and we're applying flow-problem solutions."

Structural insight is often more valuable than any specific transferred solution.
