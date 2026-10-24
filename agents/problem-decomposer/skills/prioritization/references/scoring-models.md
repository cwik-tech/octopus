# Prioritization Scoring Models: Detailed Protocols

## Impact/Effort Matrix: Detailed Protocol

### Defining the Axes

**Impact axis options** (choose 1-2 that match your strategic goal):
- Revenue impact (direct contribution to revenue growth)
- Customer value (improvement in customer experience or satisfaction)
- Risk reduction (mitigation of a known threat)
- Strategic alignment (advancement toward a stated strategic objective)
- Cost savings (reduction in operational expense)

**Effort axis components:**
- Development/implementation time
- Team capacity required
- Technical complexity
- External dependencies
- Risk of overrun

### Calibration

Before plotting, agree on anchor points:
- "What's an example of a HIGH impact item everyone agrees on?"
- "What's an example of a LOW effort item everyone agrees on?"
- Use these as reference points for all subsequent assessments.

### Worked Example: Product Feature Backlog

| Feature | Impact (1-10) | Effort (1-10) | Quadrant |
|---|---|---|---|
| Single Sign-On (SSO) integration | 8 | 3 | DO FIRST |
| AI-powered search | 9 | 8 | PLAN AND SCHEDULE |
| Dark mode UI theme | 3 | 2 | FILL IN |
| Custom workflow builder | 7 | 9 | PLAN AND SCHEDULE |
| Email notification preferences | 4 | 7 | ELIMINATE OR DEFER |
| Mobile app performance optimization | 7 | 4 | DO FIRST |

**Execution order:** SSO → Mobile performance → AI search → Custom workflows → Dark mode → (Drop email notifications.)

---

## RICE Scoring: Detailed Protocol

### Dimension Definitions

**Reach (R):** The number of people who will be affected by this item within a defined time period.
- Define the time period upfront (per quarter, per month).
- Use actual data when available (active users, support tickets, page views).
- When estimating, be conservative. Round to the nearest order of magnitude.

**Impact (I):** The degree of impact per person reached.
- 3 = Massive (transforms the experience, eliminates a major pain point)
- 2 = High (significant improvement, notable benefit)
- 1 = Medium (noticeable improvement)
- 0.5 = Low (minor improvement, nice-to-have)
- 0.25 = Minimal (barely noticeable)

**Confidence (C):** How confident you are in your Reach and Impact estimates.
- 100% = Based on quantitative data and/or direct user research
- 80% = Based on qualitative feedback and reasonable assumptions
- 50% = Based on intuition, analogies, or weak signals

**Effort (E):** The total effort required, measured in person-months (or person-weeks for smaller items).
- Include design, development, testing, and deployment.
- Include coordination overhead for cross-team items.
- Round up. Estimates are almost always too low.

### Worked Example: SaaS Product Backlog

| Feature | Reach (users/qtr) | Impact | Confidence | Effort (person-months) | RICE Score |
|---|---|---|---|---|---|
| SSO Integration | 5,000 | 2 | 80% | 2 | 4,000 |
| AI Search | 10,000 | 3 | 50% | 6 | 2,500 |
| Mobile Performance | 8,000 | 1 | 100% | 1.5 | 5,333 |
| Custom Workflows | 2,000 | 3 | 50% | 8 | 375 |
| Dark Mode | 15,000 | 0.5 | 100% | 1 | 7,500 |
| Email Preferences | 3,000 | 0.5 | 80% | 3 | 400 |

**RICE ranking:** Dark Mode (7,500) → Mobile Performance (5,333) → SSO (4,000) → AI Search (2,500) → Email Preferences (400) → Custom Workflows (375).

**Note:** Dark Mode tops RICE because of massive reach, despite low per-user impact. This is RICE working as designed — high-reach, low-effort items rank well. If you disagree with this result, your strategic goal likely weights depth of impact over breadth of reach. Adjust by using Weighted Scoring instead.

---

## MoSCoW: Detailed Protocol

### Categorization Criteria

**Must Have** — Apply the "must" test rigorously:
- "If we ship without this, is the product broken or unusable?"
- "Would we delay launch to include this?"
- "Does this satisfy a legal, contractual, or safety requirement?"
- If the answer to all three is "no," it's not a Must Have.

**Should Have:**
- "This significantly improves the experience, but a workaround exists."
- "Stakeholders would be disappointed but not blocked."
- Should Haves typically become Must Haves in the next iteration.

**Could Have:**
- "This would be nice but doesn't move key metrics."
- "No stakeholder has said they need this."
- Could Haves are the buffer. When scope gets tight, these go first.

**Won't Have (this time):**
- Explicitly acknowledged and recorded.
- Prevents "but I thought we were doing X" conversations later.
- Won't Haves are not "never" — they're "not this iteration."

### Effort Allocation Rule

| Category | Target Effort Allocation |
|---|---|
| Must Have | ≤ 60% of total capacity |
| Should Have | ~20% of total capacity |
| Could Have | ~20% of total capacity |
| Won't Have | 0% (deferred) |

If Must Haves exceed 60%, either: (a) the scope is too large for the iteration, or (b) "Must" is defined too loosely. Challenge each Must Have with the three-question test above.

---

## Cost of Delay: Detailed Protocol

### Estimating Cost of Delay (CoD)

CoD answers: "What's the economic impact of NOT doing this for one more week/month?"

**Quantifiable CoD:**
- Revenue: "Each week of delay costs $X in lost sales / missed renewals."
- Cost: "Each week of delay costs $X in manual workarounds / inefficiency."
- Penalty: "Missing this deadline incurs a $X fine / contract penalty."

**Semi-quantifiable CoD:**
- Market position: "Competitor launches in N weeks. Each week we're late reduces our capture by ~X%."
- Churn risk: "Y customers are at risk. Each week without a fix increases churn probability by Z%."

**Intangible CoD (use relative sizing):**
- "Technical debt accrues, making future changes harder."
- "Team morale degrades, increasing attrition risk."
- For intangible items, use T-shirt sizing: S (low delay cost), M (moderate), L (high), XL (critical).

### CD3 Prioritization

**CD3 = Cost of Delay / Duration**

| Item | CoD ($/week) | Duration (weeks) | CD3 Score | Priority |
|---|---|---|---|---|
| Regulatory compliance fix | $50,000 | 2 | 25,000 | 1 |
| Revenue-critical feature | $20,000 | 4 | 5,000 | 2 |
| Customer retention fix | $15,000 | 3 | 5,000 | 3 (tie) |
| Infrastructure upgrade | $5,000 | 6 | 833 | 4 |
| Internal tool improvement | $2,000 | 1 | 2,000 | — |

**Note:** The internal tool improvement has low CoD but high CD3 (because it's so fast). CD3 naturally favors quick wins — short-duration items rank higher than their raw CoD would suggest.

---

## Weighted Scoring: Detailed Protocol

When RICE or Impact/Effort don't capture the right dimensions, build a custom model:

### Step-by-Step

1. **Define criteria** (4-6 maximum):
   - Revenue impact
   - Customer satisfaction impact
   - Strategic alignment
   - Technical feasibility
   - Competitive differentiation
   - Team enthusiasm / morale impact

2. **Assign weights** (distribute 100 points):
   - Revenue impact: 30
   - Customer satisfaction: 25
   - Strategic alignment: 20
   - Technical feasibility: 15
   - Competitive differentiation: 10

3. **Score each item** on each criterion (1-5 scale):
   - 1 = Very low / negative impact
   - 2 = Low / marginal impact
   - 3 = Moderate / expected impact
   - 4 = High / above-average impact
   - 5 = Very high / transformative impact

4. **Calculate weighted score** per item: Σ(weight × score) for all criteria.

5. **Rank** by weighted score. Run sensitivity analysis on close calls (see Decision Analysis skill).

### When Weighted Scoring Beats RICE

- When "reach" isn't a meaningful dimension (internal tools, B2B with few customers).
- When strategic alignment matters more than user-level impact.
- When multiple stakeholders need to see their priorities reflected in the model.
- When you need a framework that maps to your organization's specific values.
