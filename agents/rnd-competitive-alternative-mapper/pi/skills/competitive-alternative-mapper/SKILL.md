---
name: competitive-alternative-mapper
description: Map the full landscape of alternatives competing for the same customer problem, assess displacement risk, and detect backflow to incumbent solutions. Use at Stage 4 of the R&D research pipeline, when entering a new market or segment, when adoption slows for unclear reasons, or when pricing and positioning depend on knowing who the real competitors are.
---

# Competitive Alternative Mapper

A systematic protocol for mapping the full landscape of alternatives to a validated application, identifying which solutions are competing for the same customer problem, assessing displacement risk, and detecting backflow—where satisfied customers from alternatives return to the original solution.

## When to Use

- At Stage 4 of 5 in the research pipeline, after an application has been validated and is ready to compete
- When entering a new market or customer segment to understand the full set of alternatives customers currently use
- When an application's adoption slows to diagnose whether market saturation, alternative solutions, or design failure is responsible
- When pricing or positioning decisions require understanding who the real competitors are (not just other companies, but different approaches to solving the same problem)
- When evaluating whether an application can displace incumbents or if it will be confined to non-consumption

## Core Protocol: Six Steps

### Step 1 — Problem Definition

Define the customer problem the application solves with precision. This is not the application's feature set—it is the outcome the customer is trying to achieve.

**Definition questions:**

1. What is the *core job-to-be-done* the application does? (Not "provides analytics" but "helps marketing managers measure campaign effectiveness to justify budget to CFOs")
2. Who is the *customer* and what *constraints* do they face? (Time, budget, technical skill, risk tolerance, organizational politics)
3. What *quantifiable metric* measures success? (Revenue impact, time saved, risk reduced, compliance achieved)
4. What *minimum viable performance* does the solution need? (Below this threshold, the customer won't adopt it)
5. What is the customer's *current state*? (Using a competitor, using multiple tools, doing it manually, not doing it at all)

**Output:** A one-paragraph problem statement that is application-agnostic. Replace the application's name with "a solution" and the statement should still be clear.

**Example:**

- Application-specific: "Our workflow automation platform helps enterprise operations teams automate repetitive tasks to reduce manual error."
- Problem statement: "Operations teams need to reduce time spent on routine, repetitive tasks so they can focus on exception handling and continuous improvement. They are currently using a mix of manual processes, spreadsheets, and disconnected tools."

### Step 2 — Alternative Universe Mapping

Identify all alternative ways the customer could solve the problem *without your application*. Map them into four categories: direct competitors, adjacent solutions, do-it-yourself (DIY), and non-consumption (doing nothing or accepting the problem).

**Mapping protocol:**

1. **Direct competitors:** Other applications that solve the same job with the same mechanism. (Slack competitors: Teams, Discord, Telegram)
2. **Adjacent solutions:** Applications that solve a broader or narrower scope of the job, or solve it differently. (Workflow automation competitors: Zapier, Make, or even custom APIs; or adjacent: data integration tools, RPA platforms)
3. **DIY and workarounds:** The customer could build or assemble a solution themselves using available tools, processes, or people. (Hiring a developer, building in-house scripts, using spreadsheets and manual handoff)
4. **Non-consumption:** The customer does nothing—they accept the cost of the problem (staying inefficient, accepting manual error, hiring more people, running slower)

**Alternative universe rules:**

- For each alternative, answer: "How does this solve the customer's problem, and what does it cost (money, time, skill, risk)?"
- Include at least one alternative from each category.
- Do not exclude alternatives because they are less polished, less known, or more expensive. An alternative that is more expensive but requires no implementation, or less polished but free, is real competition.
- For non-consumption, identify what the customer is doing *instead* and what it costs them.

**Output:** A table with columns: Category, Alternative, How It Solves the Problem, Approximate Cost (monetary + time + effort).

### Step 3 — Competitive Analysis Methods

For each alternative identified in Step 2, conduct a competitive analysis using frameworks from the competitive-analysis-methods reference. Apply four assessments to each alternative.

**Four assessments:**

1. **Four Categories Mapping:** Map the alternative into the four-category framework (direct, adjacent, DIY, non-consumption). If you misclassified it in Step 2, correct it now.

2. **Porter's Five Forces:** For each alternative, identify which force makes it competitive: supplier power (hard to switch away from), buyer power (customer has strong negotiating position), threat of substitution (alternative can be replaced), competitive rivalry (many options exist), threat of new entrants (barriers to entry are low). This reveals *why* the alternative is competitive.

3. **Technology S-Curve Assessment:** Map each alternative on its S-curve: emerging (early stage, improving fast, uncertain viability), growth (clear value, adoption accelerating, dominant design forming), maturity (saturated, slower improvement, incumbency advantage), decline (being displaced, new alternatives emerging). Where is your application on this curve? Where are the main competitors?

4. **Willingness-to-Pay (WTP) Estimation:** Estimate the maximum the customer would pay for the alternative based on the value it creates (cost avoided, revenue enabled, risk reduced). Compare to the actual price. A large gap (customer would pay much more) means the alternative has pricing power or the customer is getting a deal. A small gap means the customer sees low value or the price is already optimized.

**Output:** For each alternative, a row in the competitive analysis table: alternative name, four categories classification, dominant Porter force, S-curve stage, estimated WTP, actual price, gap analysis.

### Step 4 — Displacement Threshold Assessment

For each alternative, determine whether your application can realistically displace it. Use three criteria: switching cost, adoption friction, and incumbent inertia.

**Displacement assessment:**

1. **Switching cost:** How much does the customer lose by switching? (Data loss, retraining, workflow disruption, lost integration with other tools, sunk time investment) High switching costs make displacement hard unless your application provides overwhelming value gain.

2. **Adoption friction:** How much effort does the customer need to invest to use your application? (Implementation time, learning curve, configuration, integration with existing systems) High friction makes displacement possible only if the value gain is proportional.

3. **Incumbent inertia:** How locked in is the customer to the alternative? (Contractual obligation, organizational standard, single point of failure if they switch, politics inside the organization) Strong inertia makes displacement hard unless your application is an order-of-magnitude better or the incumbent fails.

**Displacement verdict:**

- **High displacement risk:** Low switching cost, low adoption friction, weak incumbent inertia. Your application will likely take share.
- **Medium displacement risk:** One or two of the conditions favor switching, but at least one blocks it. Share gain will be slow or capped.
- **Low displacement risk:** High switching cost, high adoption friction, strong incumbent inertia. Your application will reach non-consumption or adjacent use cases, not displace the incumbent.

**Output:** For each alternative, a displacement verdict and a brief explanation of which factor is the primary blocker or enabler.

### Step 5 — Backflow Detection

Identify whether customers who adopted an alternative and *then* adopted your application later switched back to the alternative. This reveals whether your application solves the problem better or just differently.

**Backflow protocol:**

1. From customer interviews or usage data, find customers who: (a) used the alternative first, (b) switched to your application, and (c) either returned to the alternative, used both in parallel, or replaced your application with something else.

2. For each backflow case, identify the reason: (a) your application didn't deliver the promised value, (b) the alternative improved and is now better, (c) the customer's needs changed and your application didn't adapt, (d) the alternative was already so ingrained that switching cost was too high, or (e) unforeseen integration issues made your application incompatible with the customer's workflow.

3. Aggregate backflow patterns. If multiple customers are returning to the same alternative for the same reason, that reason is a real weakness in your application or a real strength in the alternative.

**Output:** Count of backflow cases, primary backflow reasons, and whether backflow is concentrated in a specific customer segment or use case.

### Step 6 — Market Structure Assessment

Synthesize the alternative universe into a market structure. Identify whether the market is fragmented (many competing alternatives, none dominant), consolidated (one or two incumbents, weak alternatives), or in transition (an incumbent is being displaced by a new alternative, market share is shifting rapidly).

**Structure assessment questions:**

1. How many alternatives have a meaningful share of the customer's attention or budget?
2. Is there a clear market leader, or are the alternatives roughly equivalent in capability and share?
3. Are customers using one alternative or multiple alternatives in combination (multi-homing)?
4. Is the S-curve moving in a clear direction (emerging solutions growing, mature solutions declining), or is the market frozen?
5. What would have to change for the market structure to shift? (A new alternative emerging? An incumbent improving? Customer needs changing?)

**Output:** A one-paragraph market structure assessment describing consolidation, fragmentation, or transition, and what would trigger structural change.

## Output Format

After running the protocol, deliver the competitive landscape analysis in this format:

```
## Competitive Landscape Analysis

### Problem Definition
[One-paragraph application-agnostic problem statement]

### Alternative Universe Map

[Table: Category | Alternative | How It Solves the Problem | Approximate Cost]

### Competitive Analysis

[Table: Alternative | Four Categories | Dominant Porter Force | S-Curve Stage | Est. WTP | Actual Price | WTP Gap]

### Displacement Risk Assessment

[Table: Alternative | Switching Cost | Adoption Friction | Incumbent Inertia | Displacement Verdict | Primary Blocker/Enabler]

### Backflow Analysis
- **Total backflow cases:** [number]
- **Primary backflow reasons:** [list with counts]
- **Concentrated in:** [segment or use case, or "distributed across all segments"]

### Market Structure
[One-paragraph assessment of consolidation, fragmentation, transition, and structural change triggers]

### Competitive Positioning Recommendation
[1–2 sentences: the structural insight from the analysis that should guide positioning, pricing, or go-to-market strategy]
```

## Key Principles

1. **Problem before solution.** Do not start by listing competitors. Start by defining the problem with such clarity that a customer could recognize whether your application solves it without ever hearing the name.

2. **Four categories are exhaustive.** Every alternative the customer uses to solve the problem falls into direct competition, adjacent solutions, DIY, or non-consumption. If you can't classify an alternative, your problem definition is too narrow.

3. **Non-consumption is the biggest competitor.** Most applications do not lose to other applications—they lose to the status quo. Map what customers are doing now, measure the cost, and determine whether your application justifies the switch.

4. **Switching cost is higher than you think.** Customers overestimate the cost of switching more than they underestimate it. Always include organizational inertia, workflow disruption, and retraining in your switching cost estimate.

5. **WTP gap reveals pricing power.** A large gap between willingness-to-pay and actual price means either the customer is getting a deal or the alternative is mispriced. Either way, it's a vulnerability.

6. **Backflow is a diagnostic signal.** One customer returning to an alternative is an anecdote. Three or more customers returning for the same reason is a pattern. The pattern reveals a real gap between your application and the alternative.

7. **Market structure determines strategy.** In a fragmented market, you compete on differentiation. In a consolidated market, you compete on price or by creating non-consumption. In a market in transition, you compete on momentum and mind share. Understand your structure first.
