---
name: prioritization
description: >
  Structured ranking, scoring, and sequencing of competing items — problems, features, initiatives,
  or tasks. Applies RICE, MoSCoW, impact/effort matrices, weighted scoring, and dependency-aware
  sequencing to answer "what should we do first and why?"
  Use when ordering problems, decisions, or actions by importance and urgency.
---

# Prioritization Skill

This skill answers the question that follows decomposition: "We have 8 sub-problems (or features, or initiatives). Which ones matter most, and in what order should we tackle them?"

Problem Decomposition breaks things into pieces. Prioritization ranks and sequences the pieces. Decision Analysis chooses between alternative approaches to a single problem. Prioritization chooses the **order** across multiple items.

---

## When to Use This Skill

- After Problem Decomposition produces multiple sub-problems
- When a backlog of features, tasks, or initiatives needs ranking
- When resources are constrained and everything can't be done simultaneously
- When stakeholders disagree on what's most important
- When "everything is priority 1" and nothing is actually getting done

## When NOT to Use This Skill

- Choosing between alternative approaches to one problem (use Decision Analysis)
- Evaluating a single item (no ranking needed)
- When there's a clear sequential dependency chain (the order is already determined)

---

## Prioritization Protocol

### Step 1: Define the Prioritization Context

Before scoring anything:

1. **What are we prioritizing?** (Features, problems, initiatives, tasks, investments.)
2. **What's the resource constraint?** (Time, budget, team capacity, attention.)
3. **What's the time horizon?** (This sprint, this quarter, this year.)
4. **Who are the stakeholders?** (Whose priorities matter? Are they aligned?)
5. **What's the strategic goal?** (What are we optimizing for? Growth, profitability, risk reduction, customer satisfaction?)

### Step 2: Choose the Right Framework

Different frameworks suit different contexts:

| Framework | Best For | Complexity | Output |
|---|---|---|---|
| **Impact/Effort Matrix** | Quick visual sort, team alignment | Low | 4-quadrant plot |
| **MoSCoW** | Scope negotiation, MVP definition | Low | Categorized list |
| **RICE** | Product backlogs, feature prioritization | Medium | Ranked score list |
| **Weighted Scoring** | Complex, multi-stakeholder decisions | High | Numerical ranking |
| **Cost of Delay** | Time-sensitive items, economic optimization | High | Economic ranking |

See `references/scoring-models.md` for detailed protocols for each.

### Step 3: Apply the Selected Framework

#### Impact/Effort Matrix (Quick Sort)

Plot each item on two axes:
- **Impact:** How much value does this deliver? (Customer value, revenue, risk reduction, strategic alignment.)
- **Effort:** How much does this cost to execute? (Time, money, complexity, dependencies.)

**Four quadrants:**
- **High Impact, Low Effort** → DO FIRST (Quick wins. High ROI. Build momentum.)
- **High Impact, High Effort** → PLAN AND SCHEDULE (Major projects. Worth doing but need resources and planning.)
- **Low Impact, Low Effort** → FILL IN (Nice-to-haves. Do when bandwidth allows. Don't prioritize over high-impact work.)
- **Low Impact, High Effort** → ELIMINATE OR DEFER (Time sinks. Actively deprioritize. Challenge why they're on the list.)

#### MoSCoW Method

Categorize each item into one of four buckets:

- **Must Have:** Without this, the solution/release is a failure. Non-negotiable. Define precisely — "must" means "literally cannot launch without."
- **Should Have:** Important but not critical. Would cause significant pain if missing but has a workaround. Include if possible.
- **Could Have:** Desirable but not necessary. Included only if time and resources permit. First to be cut when constrained.
- **Won't Have (this time):** Explicitly out of scope for this iteration. Acknowledged, recorded, deferred. Prevents scope creep.

**MoSCoW rule of thumb:** Must Haves should not exceed 60% of total effort. If they do, you've defined "must" too loosely.

#### RICE Scoring

Score each item on four dimensions:

- **Reach:** How many people/users/customers does this affect in a defined time period?
- **Impact:** How much does this move the needle per person affected? (3 = massive, 2 = high, 1 = medium, 0.5 = low, 0.25 = minimal)
- **Confidence:** How confident are you in your Reach and Impact estimates? (100% = high, 80% = medium, 50% = low)
- **Effort:** How many person-months (or person-weeks) does this require?

**RICE Score = (Reach × Impact × Confidence) / Effort**

Higher score = higher priority. See `references/scoring-models.md` for worked examples.

#### Weighted Scoring

When RICE dimensions don't capture what matters, define custom criteria:

1. **Define 4-6 criteria** relevant to the strategic goal (e.g., revenue impact, customer satisfaction, strategic alignment, technical risk, dependency count).
2. **Assign weights** (sum to 100).
3. **Score each item** on each criterion (1-5 or 1-9 scale).
4. **Calculate weighted scores** and rank.

This is the most flexible but most time-consuming approach. Reserve for high-stakes prioritization.

#### Cost of Delay

When items have different time sensitivities:

- **Cost of Delay (CoD):** How much value is lost per week/month by not doing this item?
- **Duration:** How long will this item take?
- **CD3 Score = Cost of Delay / Duration.** Prioritize highest CD3 first.

Types of delay cost:
- **Standard:** Value erodes linearly over time.
- **Urgent:** Value drops sharply after a deadline (regulatory compliance, market window).
- **Fixed date:** Zero value after a specific date (event launch, seasonal product).
- **Intangible:** Hard to quantify but real (employee morale, technical debt, reputation).

See `references/scoring-models.md` for CoD estimation techniques.

### Step 4: Apply Dependency-Aware Sequencing

Raw priority scores assume independence. Real work has dependencies:

1. **Map dependencies.** For each item: what must be completed before this can start?
2. **Identify blocking chains.** Items that block many others may need to be elevated regardless of their standalone score.
3. **Build the execution sequence:**
   - Start with unblockers (items that enable other high-priority items).
   - Then high-priority items with no dependencies.
   - Then high-priority items whose dependencies are now satisfied.
   - Defer items blocked by low-priority prerequisites.

See `references/sequencing-logic.md` for dependency-aware sequencing methods.

### Step 5: Validate and Communicate

Before finalizing:

1. **Sanity check:** Does the top of the list feel right? If the scoring produces a result that surprises you, investigate why. The surprise might be correct (you had a blind spot) or the model might be missing something.
2. **Stakeholder alignment:** Share the prioritized list with decision-makers. The framework makes trade-offs visible and defensible.
3. **Capacity check:** Can the top priorities actually be staffed? If the top 5 items require 3 different teams, is that feasible?
4. **Cut line:** Draw an explicit line: "Above this line: committed. Below this line: backlog." Avoid the trap of everything being "in progress."

Use the template at `templates/priority-matrix.md`.

---

## Anti-Patterns

- **Everything is priority 1.** If everything is highest priority, nothing is. Force-rank. If you can't force-rank, you haven't defined the strategic goal clearly enough.
- **Scoring without calibration.** Different people score "impact" differently. Calibrate with examples before scoring.
- **Ignoring dependencies.** A high-priority item blocked by a low-priority prerequisite is effectively low-priority until the prerequisite is done.
- **Static prioritization.** Priorities change as new information arrives. Re-prioritize at defined intervals (weekly, per sprint, per quarter).
- **Complexity theater.** Using RICE or weighted scoring for a 3-item list. If you have fewer than 5 items, Impact/Effort or MoSCoW is sufficient.
- **Sunk cost bias.** "We've already started this, so we should finish it." Evaluate current priority based on remaining value and remaining effort, not past investment.

---

## Integration with Other Skills

- **Problem Decomposition** produces the sub-problems that this skill prioritizes.
- **Decision Analysis** evaluates alternative approaches to individual items; Prioritization ranks items against each other.
- **Scenario Planning** may shift priorities — items that are robust across scenarios should rank higher.
- **Stakeholder Mapping** identifies whose priorities matter and how to communicate trade-offs.
- **Engagement Economics** uses prioritization to sequence consulting deliverables and identify quick wins.

---

## Reference Index

| File | Content | When to read |
|---|---|---|
| `references/scoring-models.md` | RICE, MoSCoW, Impact/Effort, Weighted Scoring, Cost of Delay — detailed protocols and examples | Step 3 |
| `references/sequencing-logic.md` | Dependency mapping, critical path, capacity-aware scheduling | Step 4 |
| `templates/priority-matrix.md` | Structured output for prioritization results | Final output |
