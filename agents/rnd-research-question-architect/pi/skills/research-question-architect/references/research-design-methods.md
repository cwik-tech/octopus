# Research Design Methods: Reference Guide

## Hypothesis-Driven Research Planning

Hypothesis-driven research inverts the typical research flow. Instead of asking "What should we research?" you ask "What assumptions, if wrong, would kill this direction? How can we test those?"

### Structure Template

```
Assumption → Risk Assessment → Hypothesis Formulation → Method Selection → Kill Criteria Design
```

1. **Assumption:** Explicit statement of what you believe to be true.
2. **Risk Assessment:** If this assumption is wrong, what happens? Fatal? Damaging? Adjustable?
3. **Hypothesis:** Reformulation of the assumption as a testable proposition.
4. **Method Selection:** What is the best way to test this hypothesis given timeline and budget constraints?
5. **Kill Criteria:** What specific outcome would conclusively prove or disprove the hypothesis?

### Good Hypothesis vs. Bad Hypothesis

| Good | Bad |
|------|-----|
| "We believe enterprise customers will adopt our product because it reduces onboarding time by 70%, and we can validate by surveying 20 procurement teams and running a 4-week pilot with 3 customers. If confirmed, we can ship. If the pilot shows adoption friction in the first 2 weeks, we pivot the UX." | "We think customers will like it." |
| "We believe the market for AI-powered scheduling is $500M+ because the TAM (Total Addressable Market) of enterprise software is $600B and scheduling represents 0.1% of enterprise spending, testable via bottom-up market sizing (surveying 50 IT departments) and top-down TAM analysis. If this survey confirms 0.08–0.12%, we proceed; if it shows 0.01–0.05%, we reprioritize." | "The market could be big." |
| "We believe customer churn is driven by inadequate onboarding (not price) because churned customers report feature discovery friction (60% of exit interviews), testable via A/B test on guided onboarding module with 1000 new users over 3 weeks. If the test shows churn reduction of 15%+, we invest in onboarding; if less than 5%, the driver is elsewhere." | "Maybe onboarding is the issue." |
| "We believe the regulatory constraint that requires annual audits is eliminable through a self-certification framework, testable by interviewing 5 regulatory bodies in target markets and reviewing precedents in adjacent industries. If 3+ regulators signal openness, we escalate; if all 5 resist, we accept the constraint." | "Regulation is the problem." |

### Assumption Categories & Specific Questions

#### Technical Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| We can build this. | Can we achieve < 200ms latency with current architecture? | Prototype the bottleneck; load test. |
| The technology is mature enough. | Is the ML model accuracy sufficient (>92%)? | Benchmark against baseline; run evaluation set. |
| We can integrate with existing systems. | Will our API integrate with Salesforce without modification? | Document integration requirements; design API contract; test with Salesforce dev environment. |
| We can scale to 100K users. | Can the database handle 1M requests/hour without degradation? | Load test; run capacity analysis; simulate peak traffic. |

#### Market Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| The market exists. | Do healthcare providers actually spend on admin automation? | Survey 30 healthcare CFOs; analyze procurement records; interview 5 hospital IT directors. |
| The TAM is large. | Is the addressable market for enterprise scheduling >$200M? | Bottom-up TAM (survey IT departments); top-down TAM (enterprise software total × scheduling share). |
| Customers will pay for this. | Will customers pay $100/month for this feature? | Conjoint survey (willingness-to-pay); price sensitivity analysis; pilot program with pricing. |
| Demand is growing. | Is demand for AI-powered tools in this category accelerating? | Track Google Trends; analyze funding in adjacent categories; interview 10 domain experts. |

#### Economic Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| Unit economics work. | Can we deliver this at $50/customer acquisition cost? | Model customer LTV (Lifetime Value); analyze cohorts; track CAC (Customer Acquisition Cost) by channel. |
| Pricing scales. | Can we raise prices as we add features without churn? | Analyze historical price-elasticity; survey customers on value; A/B test pricing tiers. |
| We can achieve margin targets. | Can we hit 60% gross margin at scale? | Analyze competitor margins; model operating leverage; stress-test cost assumptions. |

#### Competitive Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| Competitors haven't solved this. | Do incumbents offer this feature? | Competitive feature audit; interview customers on competitor offerings; analyze recent product releases. |
| We have a defensible advantage. | Is our approach patentable or otherwise defensible? | Patent landscape search; interview IP attorneys; analyze competitor lock-in strategies. |
| We can compete on price. | Can we undercut competitors by 30% and still be profitable? | Competitive pricing analysis; cost modeling; margin stress tests. |
| Market consolidation won't kill us. | Could a larger competitor copy and dominate? | Analyze acquisition patterns; interview domain experts; assess switching costs. |

#### Adoption Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| Decision-makers will champion this. | Will product managers (end users) actively advocate for this feature? | User research interviews; power-user groups; champion identification. |
| The org will implement this. | Will IT departments actually deploy this in their infrastructure? | Implementation interviews; deployment simulations; pilot programs. |
| Behavior will change. | Will employees actually use this new workflow instead of the old one? | Field observation; usage analytics; behavior change research. |
| Adoption will be fast. | Can we achieve 30% adoption in Year 1? | Cohort analysis; adoption curve models; similar product benchmarks. |

#### Regulatory Assumptions

| Assumption | Example Question | How to Test |
|-----------|-----------------|------------|
| Regulation allows this. | Does GDPR (General Data Protection Regulation) permit this data architecture? | GDPR compliance audit; consult legal counsel; review regulatory guidance; test with pilot customers in target jurisdictions. |
| We can comply cost-effectively. | Can we achieve SOC (Service Organization Control) 2 compliance for <$200K? | Compliance cost analysis; security audit; process design. |
| Rules won't change. | Will data residency rules remain stable in our target markets? | Regulatory tracking; expert interviews; scenario planning. |

---

## Information Gap Analysis

The three-column framework explicitly separates what you know, what you don't know, and what you need to research.

### Framework

```
What We Know          | What We Don't Know           | What We Need to Know
(from upstream)       | (complete unknowns)          | (unknowns that matter)
```

### Analysis Discipline

1. **Column 1 — What We Know**
   - Explicitly list all outputs from Problem Decomposition, Domain Research, Scenario Planning, Strategic Reframing.
   - Include sourced facts (market size, competitor positioning, regulatory constraints).
   - Include validated assumptions (from previous research, pilots, or market tests).

2. **Column 2 — What We Don't Know**
   - Exhaustively enumerate unknowns. Don't filter yet.
   - Include technical unknowns (performance, reliability, scalability).
   - Include market unknowns (customer segments, pricing sensitivity, adoption dynamics).
   - Include competitive unknowns (competitor capabilities, market timing).
   - Include regulatory unknowns (constraint changes, compliance cost).

3. **Column 3 — What We Need to Know**
   - Filter ruthlessly. Include ONLY unknowns that would change a decision.
   - For each entry, include rationale: "This matters because: [decision it unlocks] OR [risk it eliminates]."
   - Explicitly move interesting-but-non-critical unknowns to the Parking Lot with comment: "Interesting but would not change path."

### Cost of Unnecessary Research

Each research effort has a cost in time and money. More importantly, it has an opportunity cost — time spent researching non-critical questions is time not spent on critical ones.

| Failure Mode | Cost | Example |
|-------------|------|---------|
| **Researching the interesting, not the critical.** | 4–8 weeks; $30–50K; delays decision | Spending 2 months analyzing TAM when market size isn't the constraint; the constraint is product-market fit. |
| **Researching in the wrong order.** | 8–12 weeks; $50–100K; pursues dead ends | Validating market demand before confirming technical feasibility; kills direction after 3 months of research. |
| **Over-researching kill criteria.** | 2–4 weeks; $15–30K; false confidence | Getting 99% certainty on something that only needs 75% to decide. |
| **Researching non-researchable questions.** | 6–12 weeks; $30–100K; no decision impact | Trying to answer "Which competitor will move first?" — inherently unpredictable, should be left as scenario planning. |

---

## Critical Assumption Testing

### Risk-Certainty Matrix

The two-by-two matrix maps assumption risk (if wrong) against certainty (is it true).

```
                    HIGH CERTAINTY          LOW CERTAINTY
                    ────────────────        ───────────
FATAL RISK          ✓ Validate (low effort) → RESEARCH FIRST (high priority)
                    Already confident      Must eliminate uncertainty

DAMAGING RISK       Monitor & document     Research if budget permits
                    Unlikely to shift      Lower priority than Fatal+Low

ADJUSTABLE RISK     Accept the assumption  Park if uncertain
                    Low research ROI       Can adapt if wrong
```

**Priority matrix:**
- **Fatal + Low Certainty = RESEARCH FIRST.** These are the questions that could kill the direction and are uncertain.
- **Fatal + High Certainty = Validate once, document, move on.** Low additional research needed; the assumption is already validated.
- **Damaging + Low Certainty = Research if budget permits.** Second-priority questions.
- **Adjustable + Low Certainty = Parking Lot.** These are "nice to know but not critical."

### Kill Criteria Design

A kill criterion is a specific, observable outcome that would conclusively end a research direction or kill an assumption.

#### Good Kill Criteria vs. Bad

| Good | Bad |
|------|-----|
| "If fewer than 3 of 5 procurement directors see this as solving a real problem, we kill this customer segment." | "If we're not confident." |
| "If the prototype achieves <150ms latency with 100K concurrent users, we reprioritize the architecture." | "If performance is bad." |
| "If the pilot shows adoption below 10% by week 4, we pivot the onboarding." | "If adoption is weak." |
| "If customer surveys show price elasticity below -0.5, we're not price-sensitive enough to compete on cost." | "If pricing doesn't work." |

#### Kill Criteria Components

1. **Specificity:** Exact threshold or condition. "3 of 5 directors" not "some directors."
2. **Observability:** You must be able to measure or observe it. "Time to onboarding completion" not "feels easy to adopt."
3. **Decisiveness:** The outcome conclusively answers the question. If you get this result, you *know* what to do next.
4. **Early-testability:** You can determine it before launch, not "we'll know after we have 10K users."

#### Common Kill Criteria Patterns

| Pattern | When to Use | Example |
|---------|------------|---------|
| **Threshold kill.** | When there's a minimum viable performance level. | "If the system accuracy is below 85%, we reprioritize." |
| **Comparative kill.** | When you need to beat a baseline. | "If our approach doesn't outperform the incumbent by 20%, we pivot to a different positioning." |
| **Adoption kill.** | When you're testing traction. | "If pilot adoption doesn't reach 15% by week 3, we kill this feature." |
| **Economic kill.** | When unit economics matter. | "If CAC (Customer Acquisition Cost) is above $5K and LTV (Lifetime Value) is below $50K, the unit economics don't work." |
| **Market kill.** | When testing customer demand. | "If fewer than 40% of surveyed IT directors would consider buying this, the market is too small." |
| **Timing kill.** | When market timing is critical. | "If competitors launch a similar feature within 6 months, we pivot to a defensible niche." |

#### Kill Criterion Template

```
Research Question: [question]
Hypothesis: [what we believe]
Method: [how we'll test]
Kill Criterion: If [specific observable outcome], we [kill / pivot / deemphasize].
Go Criterion: If [opposite outcome], we [proceed / invest / scale].
Contingency: If the outcome is ambiguous (in between), we [run additional test / escalate / defer].
```

---

## Research Method Selection

### Decision Tree

```
START
  │
  ├─ Is the answer documented?
  │  ├─ YES → Desk Research
  │  └─ NO → Continue
  │
  ├─ Is this a mechanism or judgment question?
  │  ├─ YES (why does X happen?) → Expert Interviews or Field Observation
  │  ├─ NO → Continue
  │
  ├─ Do we need statistical validation?
  │  ├─ YES → Market Surveys or Prototyping
  │  ├─ NO → Expert Interviews
  │
  └─ Is this about technical feasibility?
     ├─ YES → Prototyping
     └─ NO → Market Surveys or Field Observation
```

### Method Benchmarks Table

| Method | Best For | Timeline | Cost | Confidence | Sample Size |
|--------|----------|----------|------|------------|-------------|
| **Desk Research** | Documented answers (market size, rules, history) | 1–2 weeks | Low ($1K–5K) | Medium–High | N/A |
| **Expert Interviews** | Tacit knowledge, mechanisms, judgment | 2–4 weeks | Low–Medium ($5K–15K) | Medium | 3–10 interviews |
| **Market Surveys** | Statistical validation, segment analysis | 4–8 weeks | Medium ($15K–30K) | Medium–High | 100–500 respondents |
| **Prototyping** | Technical feasibility, feature viability | 2–6 weeks | Medium–High ($20K–50K) | High | 5–20 users |
| **Field Observation** | Real behavior, adoption barriers, usage | 4–12 weeks | Medium ($15K–30K) | High | 5–30 users observed |

### Method Detail

#### Desk Research
- **Protocol:** Literature search, analyst reports, regulatory filings, competitor websites, historical data.
- **When to use:** You need documented facts (market size, regulatory rules, competitor pricing).
- **Strength:** Fast, cheap, gives you baseline context.
- **Weakness:** Only answers questions that have been asked before; misses emerging dynamics.
- **Confidence gain:** Medium. Documents may be outdated or biased. Triangulate with other methods.

#### Expert Interviews
- **Protocol:** Semi-structured interviews with 3–10 domain experts (not your users, not your competitors — independent domain experts).
- **When to use:** You need tacit knowledge (mechanisms, judgment, mental models). Or you need to pressure-test an assumption against informed skepticism.
- **Strength:** Fast way to access informed judgment; good for "why" questions.
- **Weakness:** Experts can be wrong; expert consensus is often followed by disruption. Must triangulate.
- **Confidence gain:** Medium. Depends on expert credibility and consensus.

#### Market Surveys
- **Protocol:** Questionnaire (online or phone) to statistically representative sample. Can include conjoint analysis (for pricing), segmentation analysis, intent questions.
- **When to use:** You need to validate patterns across a population (e.g., "What percentage of enterprises would buy this?"). Or you need willingness-to-pay data.
- **Strength:** Statistical credibility; can quantify segments.
- **Weakness:** Survey responses ("I would buy this") often don't predict actual behavior. Requires careful questionnaire design.
- **Confidence gain:** Medium–High. Depends on sample size and question design.

#### Prototyping
- **Protocol:** Build a functional (or functional-enough) prototype; test with 5–20 users; measure technical performance (speed, reliability, scalability) and user interaction.
- **When to use:** You need to test technical feasibility or feature viability. Or you need actual user behavior, not intent.
- **Strength:** Gold standard for feasibility and behavior. Actual behavior > stated intent.
- **Weakness:** Expensive; reveals only what you test for.
- **Confidence gain:** High. Prototype results are credible unless sample is too small.

#### Field Observation
- **Protocol:** Spend time in the customer's environment; observe actual workflows, pain points, workarounds; interview during observation (contextual inquiry).
- **When to use:** You need to understand actual behavior in context, not stated behavior. Or you need to identify adoption barriers, workflow friction.
- **Strength:** Reveals what customers *actually do*, not what they say they do. Discovers unknown unknowns.
- **Weakness:** Very time-intensive; only works for observable behaviors.
- **Confidence gain:** High. Observed behavior is credible and generalizable (with caveats about sample).

### Method Combinations for Triangulation

**Strongest evidence** comes from multiple methods converging on the same conclusion.

| Question | Method 1 | Method 2 | Method 3 | Why Triangulation Works |
|----------|----------|----------|----------|------------------------|
| "Do customers feel pain around X?" | Field observation (see them struggle) | Expert interviews (experts confirm this is widespread) | Market surveys (quantify the population) | Three independent data sources, different methods, same answer = credible. |
| "Will customers pay for this?" | Conjoint survey (stated willingness) | Prototype pilot (real $ commitment) | Market interviews (expert assessment of price sensitivity) | Combines intent, revealed preference, and expert judgment. |
| "Can we achieve this performance?" | Prototype load test (measured capability) | Expert interview (is this realistic?) | Desk research (what do competitors achieve?) | Technical evidence + expert credibility + competitive benchmark. |

---

## Decision Gate Architecture

### Purpose

Decision gates force binary (or ternary) decisions at planned intervals. Each gate tests a subset of critical assumptions and has explicit go/no-go/pivot conditions. Gates prevent endless research and force clear decision-making.

### Design Principles

1. **Front-load fatal questions.** Gate 1 should answer "Can we build this?" before Gate 2 asks "Will customers buy this?"
2. **2–3 week gates.** Each gate runs ~2–3 weeks. Longer gates delay decision-making; shorter gates may not give enough time for research.
3. **Binary or ternary outcomes.** Each gate produces a decision: Go (proceed to next gate), No-Go (kill this direction), or Pivot (shift scope/positioning and return to previous gate).
4. **No surprises.** Each gate should have predetermined go/no-go conditions. Ambiguous results trigger a defined contingency (additional research, escalation, or deferral).

### Standard Three-Gate Structure

#### Gate 1 — Technical Feasibility
**Answers:** Can we build this? Is the approach technically sound?

| Question | Method | Timeline | Go Condition | No-Go Condition | Pivot Condition |
|----------|--------|----------|-------------|-----------------|-----------------|
| "Can we achieve the performance targets?" | Prototype, load test | 2–3 weeks | Prototype hits targets in testing. | Prototype cannot achieve targets. | Prototype needs architectural change; impacts design, pivot and re-test. |
| "Is the technology mature enough?" | Prototype, expert review | 2–3 weeks | All critical dependencies are stable. | Key dependencies are in alpha/beta. | Dependency available but requires workaround; acceptable pivot. |
| "Can we integrate with existing systems?" | Prototype integration, architecture review | 2 weeks | API contract defined; integration documented; no blockers. | Integration impossible without custom work. | Integration possible but expensive; impacts business model, pivot. |

**Gate 1 Decision:**
- **Go:** Proceed to Gate 2 (market validation).
- **No-Go:** Kill this technical approach; explore alternatives or kill the direction.
- **Pivot:** Modify architecture/scope; return to Gate 1 with new design.

#### Gate 2 — Market Validation
**Answers:** Will customers buy this? Is there real demand?

| Question | Method | Timeline | Go Condition | No-Go Condition | Pivot Condition |
|-----------|--------|----------|-------------|-----------------|-----------------|
| "Do customers see this as solving a real problem?" | Expert interviews, field observation | 2 weeks | 4+ of 5 customers confirm this is a real problem. | Fewer than 3 customers confirm. | Customers see problem but positioning is wrong; pivot positioning, re-test. |
| "Will customers pay for this?" | Conjoint survey, pilot pricing | 3 weeks | 40%+ would buy at target price; CAC economics work. | <30% would buy; CAC is prohibitive. | Price sensitivity is high; pivot business model, re-test. |
| "Can we reach customers cost-effectively?" | CAC analysis, pilot campaign | 2 weeks | CAC is <25% of LTV. | CAC is >50% of LTV. | CAC is 30–40% of LTV; acceptable but requires tight execution; pivot go-to-market strategy. |

**Gate 2 Decision:**
- **Go:** Proceed to Gate 3 (competitive positioning).
- **No-Go:** Kill this customer segment or market; explore adjacent segments.
- **Pivot:** Shift positioning, pricing, or go-to-market; return to Gate 2.

#### Gate 3 — Competitive Positioning
**Answers:** Can we compete on these terms? Is there a defensible position?

| Question | Method | Timeline | Go Condition | No-Go Condition | Pivot Condition |
|-----------|--------|----------|-------------|-----------------|-----------------|
| "Do we have a defensible advantage?" | Competitive audit, expert interviews | 2 weeks | Our approach is differentiated; defensible for 2+ years. | Competitors already offer this; no differentiation. | Our approach is differentiated but only for 12 months; acceptable but requires speed, pivot to acceleration. |
| "Can we compete on price/performance?" | Competitive benchmarking, pricing analysis | 2 weeks | We beat incumbents on price or performance by 20%+. | We're 20%+ worse on both dimensions. | We're better on one dimension, worse on another; acceptable depending on customer preference, pivot positioning. |
| "Will the market evolve in our favor?" | Scenario planning, trend analysis | 2 weeks | Market consolidation trend supports our positioning; adoption curve favors us. | Market consolidation trend favors larger competitors. | Market evolution is neutral or uncertain; acceptable but requires contingency planning. |

**Gate 3 Decision:**
- **Go:** Proceed to execution (business case, resource allocation).
- **No-Go:** Kill this direction; explore different positioning or different market.
- **Pivot:** Adjust competitive strategy; return to Gate 3 or revisit Gate 2 if positioning change affects demand.

### Gate Reporting Template

```
GATE [N] REPORT
Date: [date]
Direction: [application / market / product]

QUESTIONS TESTED:
- [Question 1]: Method [method], Result [result], Implication [go/no-go/pivot]
- [Question 2]: Method [method], Result [result], Implication [go/no-go/pivot]

DECISION: [GO / NO-GO / PIVOT]

IF GO:
- Next gate: [Gate N+1]
- Timeline: [weeks]
- Budget: [$X]
- Key assumptions tested: [list]
- Remaining risks: [list]

IF NO-GO:
- Rationale: [specific finding that kills direction]
- Recommendation: [alternative to explore or direction to kill]

IF PIVOT:
- What's changing: [scope / positioning / target market]
- Why: [specific finding that requires change]
- Re-test plan: [what we'll re-test and how]
- Timeline: [weeks]

NEXT STEPS:
- [Action 1]
- [Action 2]
```
