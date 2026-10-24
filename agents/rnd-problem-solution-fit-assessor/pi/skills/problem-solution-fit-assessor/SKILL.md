---
name: problem-solution-fit-assessor
description: Screen candidate applications on desirability, feasibility, and viability, then rank the survivors by adoption friction and value-chain alignment. Use at Stage 3 of the R&D research pipeline to narrow 15-30 domain-scanner candidates to the 3-5 most defensible, and when you need to know why a candidate fails rather than only that it did.
---

# Problem-Solution Fit Assessor

A systematic protocol for validating whether candidate applications represent real opportunities. This skill filters the 15–30 candidates from the Application Domain Scanner (ADS), eliminating those that fail desirability, feasibility, or viability tests, and ranks survivors by adoption friction and value-chain alignment.

## When to Use

- **Stage 3 of 5** in the research pipeline, after the Application Domain Scanner has identified broad candidate opportunities
- When you have 15–30 candidates from the ADS and need to narrow to the 3–5 most defensible opportunities
- When deciding which opportunities merit deep due diligence (Market Structure Mapper, Competitive Landscape Decoder)
- When you need to understand *why* a candidate fails—not just eliminate it

## Core Protocol: Six Steps

### Step 1 — DFV Screening (Desirability, Feasibility, Viability)

All three dimensions must pass. Failure in any dimension is elimination.

**Desirability: Do people actually want this?**

Look for:
- Active workarounds (what do customers do today to solve this problem themselves?)
- Budget allocation (is money already being spent on solutions, even imperfect ones?)
- Vocal complaints (how often does this problem come up in public discourse, support tickets, social media?)
- Switching cost acceptance (would customers incur cost and disruption to switch?)

Weak signals: theoretical demand, "people say they want this," feature requests with low engagement.
Strong signals: existing budget spend, daily workarounds, rapid adoption of competitor solutions, customer escalations, willingness to pilot.

**Feasibility: Can technology realistically deliver?**

Check:
- Performance envelope against domain requirements (can the tech meet latency, throughput, accuracy, or reliability targets?)
- Technology Readiness Level (TRL) assessment (is the core science mature enough, or is this still experimental?)
- Integration complexity with existing infrastructure (greenfield, major rewrite, API layer, or plug-and-play?)

Weak signals: "it's theoretically possible," proof-of-concept only, performance within research papers.
Strong signals: commercial deployments in related domains, performance benchmarks from real-world use, clear TRL 6+.

**Viability: Do the economics work?**

Analyze:
- Gross margins on the solution (is there enough revenue pool to fund acquisition and delivery?)
- Customer Acquisition Cost (CAC) to Lifetime Value (LTV) ratio (is CAC < 1/3 LTV achievable with this domain's sales cycles?)
- Sales cycle length and complexity (how long from awareness to contract signature, and how many stakeholders must approve?)

Weak signals: "margins could work," "if we scale to 1000 customers," venture-backed narratives.
Strong signals: established pricing in adjacent markets, clear budget owner, procurement precedent, subscription or recurring revenue model.

**Output:** Pass / Fail for each dimension. If any fails, note the specific reason and move to elimination log.

### Step 2 — Diffusion of Innovations Assessment (Rogers)

For candidates that pass DFV, score the five attributes of innovation adoption using Everett Rogers' framework.

**The five attributes:**

| Attribute | Definition | Scoring Guide |
|-----------|-----------|----------------|
| **Relative Advantage** | How much better is the solution than the status quo? | 1 = marginal (5-10% improvement) / 2 = meaningful (25-50%) / 3 = dramatic (2-5x) / 4 = transformative (10x+, changes economics of the domain) |
| **Compatibility** | How well does the solution fit existing workflows, skills, values, and infrastructure? | 1 = breaking (requires fundamental retraining, cultural shift, or architecture replacement) / 3 = moderate friction (new workflows but uses existing tools) / 5 = seamless (integrates into existing practice) |
| **Complexity** | How hard is it for users to understand and operate? | 1 = simple (no training needed) / 3 = moderate (training required, intuitive for power users) / 5 = complex (deep expertise required, non-intuitive) |
| **Trialability** | Can users test the solution on a small scale before full commitment? | 1 = easy (can test in hours/days, low switching risk) / 3 = moderate (can test in weeks, some commitment) / 5 = difficult (requires full deployment, months of commitment) |
| **Observability** | Can results be easily seen and measured? | 1 = immediate and visible (ROI clear within days/weeks) / 3 = delayed but clear (ROI measurable in months) / 5 = difficult (subjective, hard to quantify) |

**Adoption friction formula:**

```
Adoption Friction = (Complexity × 2) + (5 − Compatibility) + (5 − Trialability)
```

Lower friction = faster adoption. Score range: 0–20.
- 0–5: Low friction, rapid adoption path
- 6–10: Moderate friction, adoption takes 2–3 years
- 11–15: High friction, adoption takes 5+ years or fails
- 16–20: Critical friction, adoption unlikely

**Output:** Scorecard showing the five attributes, friction score, and comparison to benchmarks in the domain (see references).

### Step 3 — Hair on Fire Test

Classify the problem-solution pair into one of three categories, each with distinct economics and sales motion.

**Vitamin** (nice-to-have improvement)
- Symptoms: "It would be nice if we could…"
- Customers: motivated by efficiency or margin gains, but can live without it
- Sales: hard, long, expensive. Must educate on ROI, compete with internal projects
- Revenue model: licensing, usage-based, unlikely to reach $1M+ annual spend per customer
- Risk: easy to deprioritize when budgets tighten

**Painkiller** (solves known pain, customer knows they have it)
- Symptoms: active workarounds, budget allocation, vocal complaints
- Customers: motivated to solve a recognized problem, willing to evaluate alternatives
- Sales: medium difficulty, faster cycles, customer self-education on options
- Revenue model: subscription, project-based, can reach $100K–$1M+ per customer
- Risk: moderate adoption friction, but willingness to pay is high

**Cure** (eliminates critical problem that creates its own demand)
- Symptoms: problem creates urgency, failure has catastrophic consequences, no current solutions exist
- Customers: motivated to find any solution, willing to invest heavily, may create new roles/budgets
- Sales: fast, customer-driven, ability to command premium pricing
- Revenue model: high-value contracts, can reach $1M–$10M+ per customer
- Risk: may face resistance from beneficiaries of the status quo (value-destroying to incumbents)

**Discovery path:** Identify which category the candidate fits. If Vitamin, ask: does the domain have any Painkillers or Cures in similar areas (and what economics did they achieve)?

**Output:** Classification (Vitamin / Painkiller / Cure), justification, and revenue tier estimate.

### Step 4 — Value Chain Insertion Analysis

Determine whether the solution creates, destroys, or is neutral to incumbent value chains. This predicts adoption resistance and pricing power.

**Three types:**

**Value-creating:** Solution makes incumbents' existing services more attractive or efficient. Incumbents become allies.
- Example: A tool that helps SaaS companies onboard faster makes the SaaS product itself more valuable. The SaaS company sells harder.
- Test: Would an incumbent pay to integrate this into their offering?

**Value-neutral:** Solution operates in a new space or serves customers who don't use incumbent services. Incumbents are indifferent.
- Example: A new tool for remote teams has no direct relationship to enterprise VPN vendors (they use different infrastructure layers).
- Test: Does the incumbent lose revenue or competitive position if this succeeds?

**Value-destroying:** Solution makes incumbents' revenue harder to capture or justifies switching away. Incumbents resist or acquire to kill.
- Example: A tool that automates the work that justifies hiring contractors. The contract labor market shrinks.
- Test: Does the incumbent have a motivation to block or undermine this solution?

**Asymmetric motivation test (Christensen):** If incumbents see this as value-destroying, they will use their market power (distribution, brand, pricing leverage) to resist adoption. They may lower prices, bundle, acquire competitors, or use regulatory/legal tactics. Rate the incumbent motivation to resist on a scale of 1–5.

**Output:** Value chain type (creating / neutral / destroying), incumbent motivation to resist (1–5), predicted adoption barriers.

### Step 5 — Adoption Barrier Assessment

Enumerate and rate the barriers to adoption by type. Each barrier has a severity scale specific to its type.

**Barrier types and severity scales:**

| Barrier Type | Severity Scale |
|--------------|-----------------|
| **Regulatory** | Months to resolve (low) / Years to resolve (medium) / Decades or impossible (high) |
| **Infrastructure** | Minor (works with existing stack) / Major (requires new components) / Greenfield (requires complete rebuild) |
| **Behavior Change** | Incremental (adds to existing workflows) / Moderate (changes some workflows) / Fundamental (requires cultural or role changes) |
| **Training** | Hours (documentation + support) / Days (classroom or hands-on) / Months (sustained program, certification) |
| **Integration** | API (standard REST/GraphQL integration) / Custom (significant engineering effort) / Architecture (requires rethinking system design) |
| **Budget Cycle Timing** | Funded now / Wait for next budget cycle / Fiscal year mismatch / Multi-year approval required |

**Assessment protocol:**
1. For each barrier, name the specific barrier (not just the type). Example: "HIPAA compliance for patient data" (regulatory, years).
2. Estimate the cost or effort to overcome it.
3. Rate as low / medium / high severity.
4. Flag if any single barrier is a kill switch (e.g., requires legislation that's unlikely to pass).

**Output:** Table or list of barriers, severity ratings, and cumulative adoption friction from barriers.

### Step 6 — Backflow Check

If more than 70% of candidates are eliminated at this stage, signal the ADS to re-scan with broader search criteria. A high elimination rate suggests either:
- The ADS criteria were too narrow
- The initial problem space was mischaracterized
- The domain is genuinely crowded with poor-fit opportunities (rare)

**Output:** Elimination rate. If >70%, note reason and recommendation for ADS re-scan.

## Output Format

After running the protocol, deliver the assessment in this structure:

```
## Fit Assessment Results

### Summary
- **Candidates evaluated:** [N]
- **Shortlist (passed all gates):** [N]
- **Parking lot (timing only):** [N]
- **Eliminated:** [N]
- **Survival rate:** [%]

### Shortlist
[Ranked 1–5 by composite score. For each:]

#### [Rank]. [Candidate Name]

**Five-Dimension Scorecard:**
| Dimension | Score | Confidence |
|-----------|-------|-----------|
| Problem Severity | 1–5 | H/M/L |
| Solution Adequacy | 1–5 | H/M/L |
| Adoption Friction | 1–5 | H/M/L |
| Value Chain Risk | 1–5 | H/M/L |
| Timing Readiness | 1–5 | H/M/L |

**Composite Score:** [calculated from dimensions]

**DFV Assessment:**
- Desirability: [Pass / Fail] — [specific signals]
- Feasibility: [Pass / Fail] — [TRL, performance targets]
- Viability: [Pass / Fail] — [margins, CAC:LTV, sales cycle]

**Hair on Fire Classification:** [Vitamin / Painkiller / Cure] — [reasoning]

**Rogers Score:**
- Relative Advantage: [score 1–4]
- Compatibility: [score 1–5]
- Complexity: [score 1–5]
- Trialability: [score 1–5]
- Observability: [score 1–5]
- **Adoption Friction Score:** [0–20]

**Value Chain Insertion:** [Creating / Neutral / Destroying] — [incumbent motivation 1–5]

**Key Adoption Barriers:**
- [Barrier 1] — [Severity: low/medium/high]
- [Barrier 2] — [Severity]
- [Barrier 3] — [Severity]

**Ranking Rationale:** [Why this candidate ranks where it does. Highlight unusual asymmetries—e.g., high friction but high viability.]

---

### Parking Lot
[Candidates that fail on *timing* but pass on fundamentals. For each:]

#### [Candidate Name]

**Why parked:** [Timing barrier, regulatory pending, infrastructure not ready, budget cycle, etc.]

**Revisit trigger:** [What would change to move this from parking to shortlist?]

**Estimated timeline:** [6 months, 2 years, when regulation X passes, etc.]

---

### Eliminated Candidates

| Candidate | Primary Reason | Could Revisit? | Notes |
|-----------|----------------|----------------|-------|
| [Name] | [Failed gate: DFV, friction, value chain] | [Yes/No] | [Brief reasoning] |
| [Name] | | | |

---

### Backflow Check
- **Elimination rate:** [%]
- **Status:** [Green (healthy) / Yellow (monitor) / Red (rescan recommended)]
- **Recommendation:** [If red, specific re-scan guidance for ADS]

---

### Validation Confidence Summary

**Overall confidence in shortlist:** [High / Medium / Low]

**Confidence drivers:**
- [2–3 key factors that increase or decrease confidence]

**Open questions:**
- [What would increase confidence? E.g., "customer interviews on Vitamin candidates," "CAC data for this domain"]
```

## Key Principles

1. **Constructive skepticism.** Your job is to find real opportunities, not to be cynical. Watch equally for false negatives (eliminating strong candidates too early) and false positives (advancing weak ones on hope).

2. **DFV is non-negotiable.** If a candidate fails any of the three dimensions, it fails. There are no exceptions. "We'll figure out the feasibility later" is a common failure mode.

3. **Parking lot is not elimination.** Some candidates fail only on timing—regulation pending, infrastructure in progress, market not ready yet. Document them explicitly. They may be opportunities in 18 months.

4. **Every elimination needs reasoning.** Don't just mark a candidate as failed. Write the specific reason: "Failed DFV—viability: No customer budget for this use case in this domain (e.g., healthcare compliance consulting budgets are capped at $50K/year; solution costs $500K/year)."

5. **Watch for false dichotomies in Rogers scores.** A candidate might score low on Complexity but high on Compatibility—these are independent. A hard-to-use tool that plugs into existing workflows can still succeed. Trialability often surprises—freemium models can make a Cure adoptable even with high Complexity.

6. **Value chain is predictive.** Value-destroying solutions face active resistance. Budget for that. Value-creating solutions often win by becoming strategic partnerships with incumbents. Plan accordingly.

7. **Adoption barriers compound.** Three medium-severity barriers are worse than one high-severity barrier—they require parallel efforts. Flag when barriers are sequential vs. parallel.

8. **Timing beats friction sometimes.** A Painkiller with high adoption friction but a legal mandate (e.g., GDPR, SOX) to adopt can outrank a Vitamin with low friction. Context matters.

9. **Backflow check prevents waste.** If you're eliminating >70% of candidates, the root cause is usually upstream (too-narrow ADS criteria, mischaracterized domain), not downstream (your standards are too high).
