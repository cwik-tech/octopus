# Logic Review Template

Use this template during Layer 2 (Structural Logic) of the Editorial Review protocol. Complete before moving to Layer 3.

---

## Document: [Title]
## Primary recommendation: [State the recommendation being stress-tested]

---

## Part 1 — Argument Map

For each major claim in the document, fill in the chain:

### Claim 1: [State the claim]

| Element | Content | Status |
|---|---|---|
| **Evidence** | [What data or facts support this claim?] | Present / Absent / Weak |
| **Reasoning** | [How does the evidence connect to the claim?] | Clear / Implied / Missing |
| **Implication** | [So what — why does this claim matter for the recommendation?] | Stated / Missing |
| **Overall** | | Supported / Partially supported / Unsupported / Circular |

**Issues found:**
> [Describe any logical gaps, leaps, or breaks in this claim's chain]

---

### Claim 2: [State the claim]

| Element | Content | Status |
|---|---|---|
| **Evidence** | | Present / Absent / Weak |
| **Reasoning** | | Clear / Implied / Missing |
| **Implication** | | Stated / Missing |
| **Overall** | | Supported / Partially supported / Unsupported / Circular |

**Issues found:**
> [...]

*(Repeat for each major claim)*

---

## Part 2 — Fallacy Check

| Fallacy | Present? | Location | Severity |
|---|---|---|---|
| Correlation-causation confusion | Yes / No | | BLOCKING / WARNING / — |
| Survivorship bias | Yes / No | | BLOCKING / WARNING / — |
| False dichotomy | Yes / No | | BLOCKING / WARNING / — |
| Appeal to authority | Yes / No | | BLOCKING / WARNING / — |
| Hasty generalisation | Yes / No | | BLOCKING / WARNING / — |
| Sunk cost reasoning | Yes / No | | BLOCKING / WARNING / — |
| Moving the goalposts | Yes / No | | BLOCKING / WARNING / — |
| Straw man | Yes / No | | BLOCKING / WARNING / — |
| Anchoring | Yes / No | | BLOCKING / WARNING / — |
| Composition/division fallacy | Yes / No | | BLOCKING / WARNING / — |

**Fallacy details:**

For each "Yes" above, describe:
- **Where:** [Section and paragraph]
- **What:** [Specific instance]
- **Fix:** [How to address it]

---

## Part 3 — Assumption Surface

List the major unstated assumptions the document relies on:

| Assumption | Category | Safety | Action |
|---|---|---|---|
| [Assumption 1] | [Stable environment / Capability / Timing / etc.] | Safe / Reasonable / Risky / Hidden | State explicitly / Defend / Caveat conclusion |
| [Assumption 2] | | | |
| [Assumption 3] | | | |

**Risky/Hidden assumptions requiring explicit treatment:**

### Assumption: [Name it]
- **What it assumes:** [State the assumption clearly]
- **Why it's risky:** [What happens to the recommendation if this assumption is wrong?]
- **Recommended treatment:** [Add a caveat / defend it with evidence / restructure the recommendation]

---

## Part 4 — Causal Chain Validation

For the primary recommendation's causal chain: [e.g., "Investment in X → Y → Z outcome"]

| Link | Mechanism | Evidence | Strength |
|---|---|---|---|
| [Cause] → [Effect 1] | [How does the cause produce the effect?] | [Evidence supporting this link] | Strong / Moderate / Weak / Missing |
| [Effect 1] → [Effect 2] | | | |
| [Effect 2] → [Outcome] | | | |

**Weakest link:** [Which link is least supported?]
**Overall chain strength:** Strong / Adequate / Weak — [based on weakest link]

---

## Part 5 — Stress Test

### Test 1 — Inversion
> If the opposite recommendation were made, what evidence could support it? [Write 2-3 sentences.]

Does this inversion reveal a weakness in the document's argument? **Yes / No**
If yes, describe: [...]

---

### Test 2 — Extreme Condition
> Under what circumstances would this recommendation fail? [List 2-3 scenarios.]

1. [Scenario]
2. [Scenario]
3. [Scenario]

Are these scenarios acknowledged in the document? **Yes / Partially / No**
Recommended treatment: [Flag as assumption / add risk section / caveat recommendation]

---

### Test 3 — Time Horizon
> Is the recommendation evaluated over the right time horizon?

- Short-term impact addressed: **Yes / No / Partially**
- Medium-term impact addressed: **Yes / No / Partially**
- Long-term impact addressed: **Yes / No / Partially**

If any horizon is missing: [Describe what's absent and whether it matters for this document]

---

## Logic Review Summary

| Issue | Severity | Location |
|---|---|---|
| [Issue 1] | BLOCKING / WARNING / SUGGESTION | [Section] |
| [Issue 2] | | |

**Total BLOCKING issues from logic review:** [n]
**Total WARNING issues from logic review:** [n]

**Overall logic health:** Sound / Adequate / Weak / Fundamentally flawed
