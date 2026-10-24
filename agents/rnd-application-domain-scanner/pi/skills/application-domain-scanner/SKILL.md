---
name: application-domain-scanner
description: Traverse NAICS and ISIC industry sectors to find where an abstract technical capability meets a genuine unmet job-to-be-done, producing 15-30 ranked candidate application domains. Use in Stage 2 of the R&D research pipeline, after capability deconstruction, when domain intuition has run out and systematic sector coverage is needed instead of hunch-driven guessing.
---

# Application Domain Scanner

A systematic protocol for identifying industries where abstract capabilities from prior research match genuine, unmet needs. This skill transforms capability statements into concrete market opportunities by systematically traversing all major industry sectors and evaluating jobs-to-be-done (JTBD) at each intersection.

## When to Use

- **Stage 2 of 5 in the Research Pipeline.** Receives abstract capability statements from the Capability Deconstructor agent. Input is a capability abstract: "This technology can [abstract capability] under constraints [C1, C2, ...]."
- When you have one or more deconstucted capabilities and need to find the 15–30 industries where they create the most leverage
- When domain intuition runs out and you need systematic coverage instead of hunch-driven guessing
- When the home domain offers insufficient opportunity and you must find applications in adjacent or distant markets

## Core Protocol: Five Steps

### Step 1 — NAICS/ISIC Taxonomy Traversal

Systematically walk all 20 North American Industry Classification System (NAICS) top-level sectors. For each sector, ask: "Does any activity in this sector require this capability?"

**Traversal rules:**

1. **Mandatory coverage:** Must traverse at least 8 of the 20 NAICS sectors. Harder requirement: traverse at least 5 sectors explicitly *unrelated* to the technology's origin domain.
2. **Depth protocol:** For sectors that show potential, drill into 3-digit subsectors. A 2-digit sector (e.g., 31-33 Manufacturing) is too broad. Find the specific subsector where the job lives.
3. **Taxonomy reference:** Use `references/domain-scanning-methods.md` for sector definitions, code numbers, commonly overlooked applications, and hidden opportunity patterns within each sector.
4. **ISIC alternative:** If scanning non-North American markets, use ISIC (International Standard Industrial Classification). Map ISIC divisions to NAICS equivalents for consistency.
5. **Activity mapping:** For each sector or subsector, list 3–5 core activities. For each activity, ask "Does it need the capability?" Record yes/no with a one-sentence rationale.

**Output from Step 1:** A traversal checklist showing which sectors were examined and which activities showed potential. Include at least one surprising sector with no obvious connection to the home domain.

### Step 2 — Jobs-to-be-Done Analysis

For each industry-activity match from Step 1, classify the job using the JTBD framework.

**Job classification:**

1. **Job type:** What is the job—functional (task to accomplish), emotional (feeling to achieve or avoid), or social (identity or status aspiration)?
2. **Current solution state:** Is the job overserved (existing solutions exceed what customers want/need), underserved (customers struggle with inadequate solutions), or non-consumed (no solution exists or cost/complexity prevents adoption)?
3. **ODI lens:** Apply Outcome-Driven Innovation (ODI) metrics: speed, accuracy, cost, scale, reliability, ease of use. Which metric matters most for this job? Where is the worst outcome today?

**JTBD signal strength:**

- **Strongest signal:** Non-consumed jobs in underserved industries. The capability enables something previously impossible.
- **Strong signal:** Underserved jobs where the capability substantially improves an outcome metric that customers prioritize.
- **Plausible signal:** Overserved jobs where the capability adds a new dimension (e.g., enables customization in a commoditized market).

**Output from Step 2:** For each candidate, a JTBD classification card: job type, current solution state, blocking outcome metrics, signal strength rationale.

### Step 3 — Analogical Reasoning Across Domains

Borrow from Structural Isomorphism but apply it to identify opportunity patterns across industries. For each strong candidate, ask: "What other industries face structurally similar jobs?" Use the domain distance heuristic to prioritize novel connections.

**Reasoning protocol:**

1. **Domain distance:** Rate the distance between industries on a scale: adjacent (1, e.g., food manufacturing to food service), related (2, e.g., insurance to banking), distant (3, e.g., agriculture to cybersecurity), alien (4, e.g., maritime shipping to neurosurgery). Start with distant and alien domains.
2. **Structure extraction:** What is the abstract structure of the job? (e.g., "Coordinate distributed teams under time pressure with incomplete information" is the structure, whether the team builds aircraft or coordinates surgical response.)
3. **Analogical search:** Find 2–3 other industries with structurally similar jobs. If the capability solves the job in one domain, it likely solves it in the other.
4. **Convergence check:** Do multiple distant domains face the same underlying job? Multi-domain convergence is the strongest signal.

**Output from Step 3:** For each analogical match, a one-sentence mapping. Example: "Like aircraft maintenance coordinators balancing safety and time pressure, hospital scheduling managers face the same constraint-relief job when allocating surgeons across operating theaters."

### Step 4 — Constraint-Relief Mapping

Identify domains where specific constraints (cost, speed, accuracy, scale, accessibility, regulatory) actively block progress and where the capability provides relief.

**Constraint types and questions:**

- **Cost constraint:** What prevents wider adoption today? Is it the expense of the current solution, or the inability to afford a solution at all?
- **Speed constraint:** Is slowness a friction point? Does bottleneck relief matter to this job?
- **Accuracy constraint:** Where does error have high cost? Can the capability improve precision beyond what's acceptable today?
- **Scale constraint:** Does the current solution break down at higher volume? Can the capability enable work that's currently impossible at needed scale?
- **Accessibility constraint:** Who is excluded today (expertise required, geography, disability, language)? Can the capability democratize access?
- **Regulatory constraint:** Does compliance prevent current solutions? Can the capability reduce regulatory friction?

**Relief assessment scale:**

- **Complete relief:** The capability removes the constraint entirely (before it was blocking, now it's not).
- **Substantial relief:** The constraint still exists but is dramatically less severe.
- **Partial relief:** The constraint is improved but still limits adoption.
- **Marginal relief:** The capability helps at the edges but doesn't move the needle on the main bottleneck.

**Output from Step 4:** For each candidate domain, a constraint-relief map: primary constraint, current blocker, relief provided by capability, relief magnitude (complete/substantial/partial/marginal).

### Step 5 — Backflow Check

Flag warning conditions:

1. **Secondary capability overmatch:** Do secondary capabilities generate more matches than the primary capability? If so, the primary capability may be overstated or the secondary may be the real opportunity.
2. **Homefield clustering:** Do matches cluster in the home domain or related industries? Broader distribution indicates genuine cross-domain relevance.
3. **JTBD leakage:** Do JTBD classifications cluster in one job type (e.g., all functional jobs, no emotional or social)? Narrow JTBD spectrum suggests the capability is narrowly applicable or the market is immature.
4. **Relief magnitude degradation:** Does relief quality decline as you move to more distant industries? Degradation may indicate the capability is most valuable near the home domain.

**Backflow rules:**

- Flag if >50% of matches come from industries within 1 hop of the home domain.
- Flag if secondary capabilities produce 40%+ as many matches as the primary.
- Flag if >70% of matches fall in one JTBD category.
- Flag if average relief assessment for distant domains is more than one tier below adjacent/related domains.

**Output from Step 5:** A backflow alert section. No alert necessary if distributions are healthy.

## Output Format

After running the protocol, deliver the domain scan report in this template format (see `templates/domain-scan.md`):

```
## Domain Scan Report: [Capability Name]

### Scan Metadata
- **Capabilities scanned:** [Names and abstracts]
- **Sectors traversed:** [N of 20 NAICS sectors; list sectors examined]
- **Sectors with matches:** [N sectors]
- **Total candidates identified:** [N]
- **Non-obvious candidates (from unrelated industries):** [N]
- **Traversal breadth:** [% of NAICS covered]

### Scan Summary
[3–5 sentence executive summary: strongest opportunities, any surprising patterns, key constraint-relief themes, backflow flags if any]

### Candidate Portfolio

#### Strong Fit [N candidates]
[Candidates with non-consumed or underserved JTBD + substantial/complete relief]

- **[Industry subsector / Company function]**
  - NAICS: [Code and description]
  - Job: [Functional/emotional/social + description]
  - Current pain: [One sentence: what makes this hard today]
  - Capability mapping: [How capability relieves the constraint]
  - JTBD solution state: [Overserved/underserved/non-consumed]
  - Relief assessment: [Complete/substantial/partial/marginal]
  - Signal rationale: [Why this is a strong fit]

#### Plausible Fit [N candidates]
[Candidates with underserved JTBD + partial relief, or non-obvious cross-domain analogies]

- **[Industry subsector]**
  - [Same structure as Strong Fit]

#### Speculative [N candidates]
[Interesting but unverified: emerging domains, early-stage JTBD, marginal relief, or high-distance analogies]

- **[Industry subsector]**
  - [Same structure as Strong Fit]

### NAICS Sector Coverage Map

| NAICS Code | Sector Name | Examined | Matches | Opportunity Notes |
|----------|----------|----------|---------|------------------|
| 11 | Agriculture, Forestry, Fishing, Hunting | Yes/No | N | [Observation if examined] |
| 21 | Mining, Quarrying, Oil & Gas | | | |
| 22 | Utilities | | | |
| 23 | Construction | | | |
| 31-33 | Manufacturing | | | |
| 42 | Wholesale Trade | | | |
| 44-45 | Retail Trade | | | |
| 48-49 | Transportation & Warehousing | | | |
| 51 | Information | | | |
| 52 | Finance & Insurance | | | |
| 53 | Real Estate, Rental, Leasing | | | |
| 54 | Professional, Scientific, Technical Services | | | |
| 55 | Management of Companies, Enterprises | | | |
| 56 | Administrative, Support, Waste Mgmt | | | |
| 61 | Educational Services | | | |
| 62 | Health Care & Social Assistance | | | |
| 71 | Arts, Entertainment, Recreation | | | |
| 72 | Accommodation & Food Service | | | |
| 81 | Other Services | | | |
| 92 | Public Administration | | | |

### Capability Heat Map

| Capability | Strong Matches | Plausible Matches | Speculative | Total | % of Portfolio |
|-----------|----------------|------------------|------------|-------|-----------------|
| [Capability 1] | N | N | N | N | X% |
| [Capability 2] | N | N | N | N | X% |
| [Secondary capability] | N | N | N | N | X% |

**Heat map interpretation:** Which capabilities generated the most matches? Which generated the fewest? Does the secondary capability outmatch the primary?

### Backflow Alerts

[If any backflow conditions triggered, describe them here. Otherwise state "None."]

- **Alert 1 (if any):** [Description and implication]

### Next Steps

- [Highest-priority candidate for deep-dive domain research]
- [Most surprising opportunity to validate]
- [Constraint-relief pattern to explore across multiple candidates]
```

## Key Principles

1. **Breadth over depth.** You will not fully understand 30 industries. The goal is rapid screening across the maximum range of sectors to find where the capability has outsized impact. Depth comes in follow-up stages (domain research, stakeholder interviews).

2. **Non-obvious minimum:** At least 5 candidates must come from industries unrelated to the technology's origin domain. If you can't find 5, either the capability is narrowly applicable or you haven't searched broadly enough. Go back and examine sectors you haven't looked at yet.

3. **Systematic traversal, not intuition.** Walk the taxonomy. Do not skip sectors because they "seem irrelevant." Some of the highest-impact applications live in domains you would have dismissed intuitively.

4. **Don't self-censor speculative matches.** Include opportunities where the JTBD is emerging, the relief is unproven, or the analogy is distant. Label them as Speculative, not Strong. The goal is to surface possibilities, not to filter conservatively. False negatives (missing real opportunities) are more costly than false positives (including speculative ones that don't pan out).

5. **15–30 candidates total.** Fewer than 15 suggests you haven't searched thoroughly enough or the capability is narrowly applicable. More than 30 suggests you're including too many marginal matches or haven't differentiated signal strength clearly.

6. **Signal strength tiers are strict:**
   - **Strong Fit:** Non-consumed or seriously underserved JTBD where the capability provides substantial or complete relief. Implication: worth deep research.
   - **Plausible Fit:** Underserved JTBD where relief is partial but meaningful, or non-obvious cross-domain analogy with proven mechanism transfer. Implication: worth validation before deep research.
   - **Speculative:** Emerging domain, early-stage JTBD, marginal relief, or untested analogies. Implication: interesting but uncertain. Revisit if market signals strengthen.

7. **Backflow check is not optional.** It reveals whether you've truly found a broadly applicable capability or whether you've identified something that works mainly near home. Act on the signals.
