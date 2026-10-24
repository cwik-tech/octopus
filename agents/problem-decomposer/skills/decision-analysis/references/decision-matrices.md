# Decision Matrices: Weighted Scoring and Pugh Method

## Weighted Scoring Matrix

The most common decision analysis tool. Simple, transparent, and auditable.

### Construction

1. **List options** as columns.
2. **List criteria** as rows.
3. **Assign weights** to each criterion (sum to 100 or 1.0).
4. **Score each option** on each criterion (1-9 scale, with justification).
5. **Calculate weighted scores:** weight × score for each cell.
6. **Sum columns** for total weighted score per option.

### Worked Example: Choosing a CRM Platform

**Decision:** Select CRM (Customer Relationship Management) for a 50-person sales team. Options: Salesforce, HubSpot, Pipedrive.

| Criterion | Weight | Salesforce | HubSpot | Pipedrive |
|---|---|---|---|---|
| Feature completeness | 25 | 9 (225) | 7 (175) | 5 (125) |
| Ease of adoption | 20 | 4 (80) | 8 (160) | 9 (180) |
| Integration with existing stack | 20 | 8 (160) | 7 (140) | 5 (100) |
| Total cost (3-year) | 20 | 3 (60) | 6 (120) | 8 (160) |
| Vendor stability & support | 15 | 9 (135) | 8 (120) | 6 (90) |
| **Weighted Total** | **100** | **660** | **715** | **655** |

**Result:** HubSpot leads with 715, but the margin over Salesforce (660) is only 8%. Run sensitivity analysis.

**Sensitivity test:** If "Feature completeness" weight increases from 25 to 35 (and Ease of adoption drops to 10), Salesforce wins at 680 vs. HubSpot's 665. The decision hinges on how much the team values advanced features vs. ease of use.

**Recommendation:** HubSpot, with the caveat that if the team's needs are likely to become more complex in 18+ months, Salesforce's feature depth may justify the adoption cost.

### Common Scoring Scales

| Scale | When to Use |
|---|---|
| 1-9 (odd numbers only: 1,3,5,7,9) | Default. Forces differentiation, avoids "everything is a 5" |
| 1-5 | Simpler decisions, fewer options |
| 1-10 | When fine-grained differentiation matters |
| Pass/Fail + Score | Binary constraints first, then score remaining options |

---

## Pugh Matrix (Concept Selection)

A simpler alternative when you have a baseline or status quo to compare against.

### Construction

1. **Choose a baseline** (current state, leading option, or simplest approach).
2. **List criteria** as rows (no weights needed initially).
3. **Compare each option to baseline:** + (better), - (worse), S (same).
4. **Sum +, -, and S** for each option.
5. **Net score** = number of + minus number of -.

### When to Use Pugh vs. Weighted Scoring

| Pugh Matrix | Weighted Scoring |
|---|---|
| Early-stage, many options to narrow down | Final selection among 2-4 finalists |
| Criteria weights are unclear | Criteria weights are established |
| Quick screening needed | Rigorous, auditable decision required |
| Comparing against status quo | Comparing options against each other |

### Worked Example: Build vs. Buy vs. Partner for Data Pipeline

**Baseline:** Current manual process (status quo).

| Criterion | Build In-House | Buy Platform | Partner Integration |
|---|---|---|---|
| Time to value | - | + | + |
| Long-term cost | + | - | S |
| Customization | + | S | - |
| Maintenance burden | - | + | + |
| Data security control | + | S | - |
| Team skill availability | - | + | S |
| **+ count** | 3 | 3 | 2 |
| **- count** | 3 | 1 | 2 |
| **Net** | 0 | +2 | 0 |

**Result:** "Buy Platform" has the best net score. Build and Partner are tied at net 0 but for different reasons — Build excels on control but struggles on speed and maintenance; Partner excels on speed but sacrifices control.

---

## Tips for Agents

- **Always show your work.** The matrix itself is the argument. Don't just state a conclusion — show how you got there.
- **Justify every score.** A matrix with unjustified scores is just dressed-up gut feel.
- **Test sensitivity on close calls.** If two options are within 10% of each other, the decision is closer than it looks.
- **Use constraints as binary filters first.** If an option fails a non-negotiable requirement, eliminate it before scoring.
- **Don't over-engineer.** If one option obviously dominates, a quick Pugh matrix is sufficient. Save weighted scoring for genuinely close decisions.
