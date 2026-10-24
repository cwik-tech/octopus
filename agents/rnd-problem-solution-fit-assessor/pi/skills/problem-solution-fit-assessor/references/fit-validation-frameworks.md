# Fit Validation Frameworks

Reference material for the Problem-Solution Fit Assessor. This document provides detailed frameworks, scoring guides, and historical patterns for each validation step.

## DFV Framework: Desirability, Feasibility, Viability

### Desirability: Signal Types and Strength

**Weak signals** (Vitamin indicators—nice-to-have)
- Expressed desire: "That would be nice." Hypothetical preference with no action.
- Low engagement: Feature requests on product forums with few votes or comments.
- No current spend: No budget line item for the problem. It's solved ad hoc or not solved at all.
- No switching cost: Customers would need to invest substantially to switch. Current solution, even if imperfect, has switching costs that exceed the pain.

**Strong signals** (Painkiller indicators—known problem)
- Active workarounds: Customers spend time/money on partial solutions. If the partial solution (workaround) requires budget allocation, the pain is real.
- Budget already allocated: Money flows to this problem today. Vendors exist and have paying customers.
- Vocal complaints: The problem appears regularly in public forums, social media, support tickets, or analyst reports. Frequency and emotional intensity indicate urgency.
- Rapid adoption of alternatives: When a new solution appears (even an imperfect one), customers adopt it quickly. This signals both problem severity and solution appetite.
- Customer escalations: Support or sales teams hear this issue repeatedly. It's a blocker or frustration for a material portion of the customer base.

**Strongest signals** (Cure indicators—critical problem)
- Willingness to pilot at cost: Customers fund a pilot without vendor pressure.
- Procurement precedent: The organization has budgeted for similar solutions before. The decision-making precedent exists.
- Customer-driven search: Customers are hunting for solutions, not waiting for vendors to approach them.
- Multiple vendor solutions in play: Competition is already active. The domain knows it has a problem and wants to solve it.

**How to validate:**
- Customer interviews: "How do you solve this today?" reveals workarounds.
- Market analysis: Are there multiple vendors? Are they growing? This signals budget allocation.
- Search volume: Do people search for solutions? What terms do they use?
- Social listening: How often does this problem appear in Slack, Reddit, Twitter, Hacker News within the domain?

---

### Feasibility: Technology Readiness Level (TRL) and Performance Envelope

**Technology Readiness Level (TRL) Scale (1–9):**

| TRL | Stage | Characteristics | Timescale |
|-----|-------|-----------------|-----------|
| **1** | Basic research | Fundamental principles observed. No application yet. | N/A |
| **2** | Concept formulation | Theoretical feasibility demonstrated. Lab proof-of-concept. | 3–5 years to TRL 4 |
| **3** | Experimental proof-of-concept | Technology concept tested in lab under controlled conditions. | 2–4 years to TRL 4 |
| **4** | Technology validation | Technology demonstrated in a relevant laboratory environment. Bench testing. | 2–3 years to TRL 5 |
| **5** | Technology demonstration | Technology demonstrated in relevant industrial environment. Pilot or prototype. | 2–5 years to TRL 6 |
| **6** | Technology readiness demonstration | Technology demonstrated in operational environment. Real-world deployment at small scale. | 1–3 years to TRL 7 |
| **7** | System prototyping | Prototype system in operational environment. Multiple deployments in similar contexts. | 1–2 years to TRL 8 |
| **8** | System commissioning | Technology ready for operational deployment. Commercial offering exists. Multiple successful deployments. | 1–2 years to TRL 9 |
| **9** | Full commercial deployment | Mature, proven technology. Market accepted, widely deployed, proven business model. | Ongoing |

**Minimum TRL for business viability:**
- **TRL 6+** = Feasible for venture-scale business. Core technology proven in relevant environment. Known unknowns are integration and scale, not whether the technology works.
- **TRL 5 or below** = High risk. Requires substantial R&D funding. Timescale to commercialization is 3–5+ years. Unless you're a deep-tech venture with patient capital, pass.

**Performance envelope assessment:**

Identify 3–5 key performance metrics required by the domain. Then:
1. What does the domain require? (Latency, accuracy, throughput, reliability, cost, power consumption, etc.)
2. What does the current technology deliver?
3. What is the gap? Is it bridgeable with engineering, or fundamental?

**Example: Machine learning for medical diagnosis**
- Domain requirement: 95%+ sensitivity (catch all cases) and 95%+ specificity (avoid false alarms).
- Current technology: 92% sensitivity, 94% specificity in peer-reviewed studies.
- Gap: Bridgeable with more training data or model refinement. Engineer assessment: 6–12 months, low risk.

**Example: Quantum computing for cryptography**
- Domain requirement: 256-qubit stable quantum computer.
- Current technology: 100-qubit stable quantum computer (2025).
- Gap: Not bridgeable with existing technology. Requires fundamental physics advances. Timescale: 10–20 years.

---

### Viability: Economics and Customer Acquisition

**Gross Margin Analysis:**

Calculate the cost structure of delivering the solution:

```
Gross Margin = (Revenue - Cost of Goods Sold) / Revenue × 100%
```

For a SaaS business:
- COGS ≈ hosting costs, payment processing, support staff, payment processing (roughly 5–25% of revenue for mature products)
- Gross margin target: 60–80% (needed to fund sales/marketing 20–35%, R&D 15–25%, and operations 10–20%)

For a professional services business:
- COGS ≈ labor cost + overhead
- Gross margin target: 40–60% (services typically lower margin than software)

**Red flag:** If the domain's typical gross margins are 20% or lower, and your solution doesn't improve underlying economics, viability is questionable.

**Customer Acquisition Cost (CAC) to Lifetime Value (LTV) Ratio:**

```
CAC = (Sales & Marketing Spend) / (Number of New Customers Acquired)
LTV = (Gross Profit per Customer) × (Average Customer Lifetime in Years)
CAC:LTV Ratio = CAC / LTV
```

**Healthy ratio:** CAC:LTV ≤ 0.33 (for SaaS). In other words, you recover CAC in the first 3 years of customer lifetime.

**Stress test the ratio:**
- What is the CAC for similar solutions in this domain? (Research comps.)
- What is typical customer lifetime? (Is churn high in this domain, or do customers stay for 5+ years?)
- Can we achieve LTV in that timeframe? (Does pricing allow it?)

**Example: Enterprise security software**
- CAC = $150K (long sales cycle, many stakeholders)
- LTV = $50K annual revenue × 3 year average lifetime = $150K
- Ratio = 1.0 (This is a break-even scenario. Risky.)

**Example: Bottom-up SaaS for developers**
- CAC = $5K (low-touch, product-led growth)
- LTV = $2K annual revenue × 5 year lifetime = $10K
- Ratio = 0.5 (Strong viability.)

**Sales cycle length and complexity:**

Determine how long it takes from first awareness to contract signature, and how many stakeholders must approve.

| Domain | Typical Sales Cycle | Stakeholders | Complexity |
|--------|-------------------|--------------|-----------|
| SMB (Small Business) self-serve SaaS | 1–4 weeks | 1–2 (user + manager) | Low |
| Mid-market SaaS | 2–6 months | 3–5 (user, IT, finance, legal) | Medium |
| Enterprise software | 6–18 months | 5–10+ (user, IT, security, procurement, legal, executive) | High |
| Healthcare/regulated | 12–24 months | 10–20+ (clinicians, compliance, legal, procurement, risk) | Very high |
| Infrastructure/platform | 9–24 months | 5–15 (technical, procurement, integration, legal) | High |

**Prediction:** Longer sales cycles + more stakeholders = higher CAC, longer time to LTV realization.

---

## Rogers' Diffusion of Innovations: Scoring and Benchmarks

### The Five Attributes with Historical Patterns

**Relative Advantage:**

Scoring: 1 (marginal 5–10%) / 2 (meaningful 25–50%) / 3 (dramatic 2–5x) / 4 (transformative 10x+)

Historical pattern by advantage level:
- **Marginal (1):** Adoption takes 5–10 years, if at all. Example: Incremental efficiency gains in office software.
- **Meaningful (2):** Adoption takes 2–5 years among early adopters, broader in 5–10 years. Example: Overnight shipping (vs. ground shipping).
- **Dramatic (3):** Adoption takes 1–3 years for early adopters, 5+ years for mainstream. Example: Mobile computing (vs. desktop).
- **Transformative (4):** Adoption can be rapid (months) if other barriers are low. Example: Electricity (vs. candlelight).

**Compatibility:**

Scoring: 1 (breaking—requires fundamental change) / 3 (moderate friction) / 5 (seamless)

Examples:
- **Seamless (5):** A new phone app that works alongside existing phones. No retraining, no new infrastructure.
- **Moderate (3):** A new programming language. Developers must learn syntax, but can integrate with existing tools. Organizations can adopt piecemeal.
- **Breaking (1):** A new operating system that requires rewriting all software. Everything must be compatible. Example: moving from Windows to a new OS; the entire ecosystem must follow.

**Complexity:**

Scoring: 1 (simple—no training) / 3 (moderate—training required) / 5 (complex—expertise needed)

Examples:
- **Simple (1):** A new smartphone interface. Intuitive, discoverable, usable in minutes.
- **Moderate (3):** A new cloud platform. Requires learning API docs, best practices, maybe a week of training.
- **Complex (5):** A new database system. Requires deep expertise: schema design, optimization, disaster recovery. Non-obvious to novices.

**Trialability:**

Scoring: 1 (easy—hours/days, low commitment) / 3 (moderate—weeks, some commitment) / 5 (difficult—months, full deployment)

Examples:
- **Easy (1):** A SaaS tool with a free tier. Sign up in minutes, try for free.
- **Moderate (3):** Enterprise software with a POC program. Deploy a pilot, run for 1–3 months, then decide.
- **Difficult (5):** A new manufacturing process. Requires capital, retraining, process redesign. Full deployment only.

**Observability:**

Scoring: 1 (immediate & visible—days/weeks) / 3 (delayed but clear—months) / 5 (difficult—subjective, hard to quantify)

Examples:
- **Immediate (1):** A faster algorithm. Users see performance improvements in real time.
- **Delayed (3):** A security vulnerability patch. Results visible once the vulnerability is patched, but the benefit is absence of harm (invisible until a breach doesn't happen).
- **Difficult (5):** A new organizational structure. Benefits (better collaboration, faster decisions) are subjective and hard to measure. ROI unclear.

### Adoption Friction Formula and Benchmarks

```
Adoption Friction = (Complexity × 2) + (5 − Compatibility) + (5 − Trialability)
```

Range: 0–20

**Benchmarks:**

| Score | Category | Adoption Timeline | Example |
|-------|----------|-------------------|---------|
| 0–5 | Low friction | Months to 1 year | Mobile app store, SMS, email |
| 6–10 | Moderate friction | 2–3 years | Cloud storage, collaborative tools, internet to enterprise |
| 11–15 | High friction | 5–10 years | New programming language, new OS, organizational restructuring |
| 16–20 | Critical friction | Unlikely to adopt, unless mandated | Legacy system replacement, fundamental behavior change, new infrastructure |

**Historical validation:**
- **Email adoption (1980s):** Low friction (easy to use, works with existing workflows, trialable immediately). Adoption ~3 years to 90% business penetration.
- **Cloud computing (2000s):** Moderate friction (requires learning new concepts, but integrates with existing systems). Adoption ~8–10 years to 50%+ enterprise adoption.
- **Agile methodology (1990s):** High friction (requires new workflows, training, cultural change). Adoption ~15+ years to 50%+ adoption; still not 100% in 2025.

---

## Hair on Fire Test: Classification Criteria and Revenue Models

### Vitamin vs. Painkiller vs. Cure

**Vitamin (Nice-to-have):**
- Customer motivation: "This would be nice. It would save us time or money."
- Budget: Optional, discretionary. Deprioritized if budget tightens.
- Sales motion: Long, educational, must prove ROI. Customer must be convinced.
- Pricing power: Low. Commoditized solutions are available. Customer willing to pay only if price is compelling.
- Revenue model: Licensing ($10K–$100K/year per customer), usage-based, or freemium.
- Typical market size: $1M–$100M per segment. Crowded with competitors.
- Customer lifetime: 2–3 years. Churn is high because the solution is nice-to-have.
- Example: A collaboration tool that makes meetings 10% more efficient. Useful, but not urgent.

**Painkiller (Solves known pain):**
- Customer motivation: "We have this problem today. We need a solution."
- Budget: Allocated or available. Not optional, but subject to ROI justification.
- Sales motion: Medium length (2–6 months). Customer self-education on options. Multiple vendors in play.
- Pricing power: Medium. Customer willing to pay if the solution clearly solves the pain.
- Revenue model: Subscription ($100K–$1M+/year per customer), project-based, or mixed.
- Typical market size: $100M–$1B per segment. Several successful vendors.
- Customer lifetime: 4–7 years. Churn is moderate because customers have invested in the solution.
- Example: A tool that automates a time-consuming manual process. Clear ROI, multiple vendors exist.

**Cure (Eliminates critical problem):**
- Customer motivation: "This problem is costing us millions. We'll pay anything to fix it."
- Budget: Urgent or emergency. Money will be found if a viable solution exists.
- Sales motion: Fast (1–3 months). Customer-driven, often RFP-based. Few vendors (or none) exist yet.
- Pricing power: High. Customer willing to pay premium for proven solution.
- Revenue model: High-value contracts ($1M–$10M+/year), fixed project fee, or equity participation.
- Typical market size: $1B+ per segment. Limited vendors (often market leader is created).
- Customer lifetime: 7–10 years or longer. Churn is low because switching costs are very high once in place.
- Example: A tool that prevents a regulatory violation, eliminates production downtime, or unlocks a new revenue stream.

### Discovery Path

**For Vitamins:**
- Ask: Are there any Painkillers or Cures in adjacent use cases? If yes, what economics did they achieve?
- Example: If customer onboarding is a Vitamin, are there Painkillers in related processes (e.g., customer retention, account management)? If Painkillers exist, the market viability exists.
- Conclusion: Vitamins often survive if they can be bundled with Painkillers or sold to a subset of customers for whom they're Painkillers.

**For Painkillers:**
- Ask: Is this problem actively solved today? By whom? At what scale?
- This tells you the market is real and active. Validate by competitor analysis.

**For Cures:**
- Ask: How are customers currently managing without a solution? What's the cost?
- If customers are not managing (i.e., the problem is causing failures, lost revenue, or regulatory risk), this is a Cure.
- Validate by customer interviews: willingness to pay, budget availability, timeline urgency.

---

## Value Chain Insertion Analysis: Types and Asymmetric Motivation

### Three Types: Definition and Examples

**Value-Creating Solutions**

Definition: The solution makes an incumbent's existing revenue more defensible or increases a customer's willingness to buy the incumbent's core service.

Examples:
- A data analytics tool that helps a SaaS company serve customers better. The SaaS company increases its own pricing or retention because of the analytics tool. → The SaaS company becomes an ally and may integrate or bundle the tool.
- A training platform that helps a professional services firm scale faster. The firm's utilization and revenue increase. → The firm becomes an ally and may white-label or resell the tool.

Test: Would an incumbent pay to integrate this into their offering? (Usually yes, because it increases their revenue.)

**Value-Neutral Solutions**

Definition: The solution operates in a separate value chain and doesn't directly affect incumbent revenue or competitive position.

Examples:
- A scheduling app for construction crews. The app doesn't threaten any incumbent service; it's complementary.
- A new tool for remote team standups. It doesn't affect enterprise communication platforms or productivity tools directly.

Test: Does the incumbent lose revenue if this succeeds? (No.)

**Value-Destroying Solutions**

Definition: The solution makes an incumbent's revenue harder to capture, justifies switching away, or eliminates the need for the incumbent's service.

Examples:
- A tool that automates the work that justifies hiring contractors. Contractor revenue declines. → Contractor agencies resist.
- A telehealth platform that reduces in-clinic visits. Hospital outpatient revenue declines. → Hospitals resist.
- A platform that enables companies to manufacture their own products. Third-party manufacturers are threatened. → Manufacturers resist and may lobby against the platform.

Test: Does the incumbent have a financial motivation to block or undermine this solution? (Yes.)

### Christensen's Asymmetric Motivation Test

Incumbent response depends on whether the solution is value-creating or value-destroying:

**Value-creating solutions (Incumbent has high motivation to adopt):**
- Incumbent integrates the solution into their offering or partners with the creator.
- Incumbent may acquire the solution creator.
- Adoption is relatively frictionless because incumbent actively pushes it.

**Value-destroying solutions (Incumbent has high motivation to resist):**
- Incumbent uses market power to slow adoption:
  - Lower pricing on their own competing solution to make the disruptive solution economically unattractive.
  - Bundle services to make switching more expensive.
  - Use distribution power to block or slow availability.
  - Lobby for regulatory hurdles or legal barriers.
  - Acquire the creator to prevent them from competing.
- Adoption is slow and faces active resistance.

**Incumbent motivation rating (1–5):**
1. No motivation to resist (value-creating or neutral)
2. Low motivation (minor revenue threat, affects niche)
3. Moderate motivation (affects 10–20% of revenue)
4. High motivation (affects 20–50% of revenue)
5. Critical motivation (core business at risk, existential threat)

**Prediction:** Motivation ratings of 4–5 signal sustained incumbent resistance. Plan for 5–10+ year adoption cycle, regulatory battles, or acquisition attempts.

---

## Adoption Barrier Severity Scales by Type

### Regulatory Barriers

Timeline to resolve:
- **Months (Low):** Regulatory guidance exists or process is well-established. Example: FCC approval for a consumer electronics device (typically 3–6 months).
- **Years (Medium):** Regulation exists but interpretation is unclear or process is slow. Example: FDA approval for medical device (typically 1–3 years for 510k pathway, 5–7 years for new drug approval).
- **Decades or impossible (High):** Regulation doesn't exist and would require legislation or is fundamentally at odds with law. Example: A tool that requires decriminalization of an activity; a tool that requires overturning established treaty obligations.

**Mitigation:** For barriers that take years, ask: can we launch in an unregulated geography first and work backward? (Often yes, especially for software.)

### Infrastructure Barriers

Complexity of integration:
- **Minor (Low):** Works with existing stack. Plug-and-play integration. Example: A new SaaS tool that integrates via API with Salesforce.
- **Major (Medium):** Requires new infrastructure components or significant customization. Example: A new database that requires migration from existing database (possible but requires engineering effort, 2–6 months).
- **Greenfield (High):** Requires complete rebuild of existing infrastructure. Example: Moving from Windows to a new operating system; every application must be rewritten.

**Mitigation:** Greenfield barriers are severe. They're often kill switches unless they're mandatory (e.g., regulatory change).

### Behavior Change Barriers

Scope of change required:
- **Incremental (Low):** Adds to existing workflows. No change in roles, responsibilities, or decision-making. Example: A new reporting tool that adds to existing reporting suite.
- **Moderate (Medium):** Changes some workflows or requires new training. Some roles affected. Example: A new CRM that requires sales teams to log activities in a new system.
- **Fundamental (High):** Requires cultural shift, new roles, new decision-making. Example: Moving from command-and-control to autonomous teams; moving from individual contributor to collaborative model.

**Mitigation:** Fundamental changes require executive sponsorship and 6–12 months of sustained effort. They often fail without visible executive commitment.

### Training Barriers

Time and effort to competency:
- **Hours (Low):** Self-service documentation, short tutorial, minimal support needed. Example: Learning a new SaaS tool with good UI/UX.
- **Days (Medium):** Classroom training or hands-on workshop, 2–5 days of effort. Example: Learning a new programming language.
- **Months (High):** Sustained training program, certification, ongoing support. Example: Becoming proficient in a new surgical technique, platform administration role.

**Mitigation:** Build train-the-trainer programs and certification to scale training.

### Integration Barriers

Effort required for technical integration:
- **API (Low):** Standard REST/GraphQL integration. 1–4 weeks of engineering effort. Example: Adding a third-party payment processor.
- **Custom (Medium):** Significant engineering effort but no architectural rethinking. 1–3 months. Example: Integrating a new data warehouse into existing ETL (Extract, Transform, Load) pipeline.
- **Architecture (High):** Requires rethinking system design, messaging patterns, data flows. 3–6+ months. Example: Moving from monolith to microservices.

**Mitigation:** For custom or architecture barriers, invest in reference implementations and engineering partnerships early.

### Budget Cycle Timing Barriers

Funding readiness:
- **Funded now (Low):** Budget exists or can be approved quickly. Purchase in current quarter.
- **Wait for next cycle (Medium):** Budget available next fiscal cycle (3–6 months away). Purchase timeline known.
- **Fiscal year mismatch (High):** Budget is available but not until next fiscal year (up to 12 months away).
- **Multi-year approval (High):** Requires multi-year funding commitment or capital allocation process. 12–24+ months.

**Mitigation:** Understand the customer's fiscal calendar and budget cycles. Plan sales and implementation timelines accordingly. Sometimes timing is beyond your control.

---

## Composite Scoring and Weighting

The five-dimension scorecard in the output template uses these dimensions:

| Dimension | Definition | Weight | Score |
|-----------|-----------|--------|-------|
| **Problem Severity** | How acute is the problem? Is it a Vitamin, Painkiller, or Cure? | 25% | 1–5 |
| **Solution Adequacy** | Can the technology deliver? Is it TRL 6+? Does it meet performance targets? | 25% | 1–5 |
| **Adoption Friction** | How hard is it to adopt? (From Rogers' formula: 0–20, normalized to 1–5.) | 20% | 1–5 |
| **Value Chain Risk** | Is incumbent motivation to resist high (4–5)? | 15% | 1–5 |
| **Timing Readiness** | Are regulatory, budget, and infrastructure timing favorable? | 15% | 1–5 |

**Composite score calculation:**
```
Composite Score = (Problem Severity × 0.25) + (Solution Adequacy × 0.25) + (Adoption Friction × 0.20) + (Value Chain Risk × 0.15) + (Timing Readiness × 0.15)
```

This produces a score of 1–5. Candidates scoring 4.0+ are strong shortlist candidates. 3.5–3.9 are marginal. Below 3.5 should be eliminated or parked.

---

## References and Further Reading

- Rogers, E. M. (2003). *Diffusion of Innovations* (5th ed.). Free Press. (Core framework for adoption scoring.)
- Christensen, C. M. (1997). *The Innovator's Dilemma*. Harvard Business School Press. (Asymmetric motivation and incumbent response.)
- Moore, G. A. (2014). *Crossing the Chasm*. Harper Business. (Adoption lifecycle and early adopters vs. mainstream.)
- Payne, A. (2012). *The Customer Painkiller Pyramid*. (Framework for Vitamin vs. Painkiller classification.)
