---
template_name: business-plan
description: >
  Comprehensive business plan for a company or new venture. Covers strategy, market,
  operations, team, and financials. Suitable for investor presentations, bank financing,
  or internal strategic planning. Audience and style profile should be set per engagement.
style_profile: analytical-detailed   # Default. Override to proposal-persuasive for investor/pitch context.
sections_required:
  - executive_summary
  - company_overview
  - mission_and_vision
  - market_analysis
  - competitive_analysis
  - products_and_services
  - go_to_market
  - operations_plan
  - management_team
  - financial_projections
  - funding_requirements
  - risk_analysis
variables:
  - company_name
  - client_name
  - date
  - author
  - industry
  - stage               # e.g., Pre-seed / Seed / Series A / Growth / Established
  - primary_audience    # e.g., Investors / Bank / Board / Internal
  - funding_amount      # e.g., £2M Series A (leave blank if not seeking funding)
  - projection_years    # e.g., 3 or 5
output_format: docx
---

# {{company_name}} — Business Plan

**Prepared by:** {{author}}
**Date:** {{date}}
**Confidential — prepared for:** {{client_name}}

---

## Executive Summary

<!--
WRITER INSTRUCTIONS:
- Write this section LAST, after all other sections are complete.
- Length: 1-2 pages maximum. Every sentence must earn its place.
- Must stand alone — a reader who reads only this section should understand the business,
  the opportunity, the ask, and why this team can execute.
- Structure: Problem → Solution → Market → Traction → Team → Ask (if funding)
- Lead with the most compelling fact about the business, not background.
- Audience adjustment: For investors, emphasise return potential and market size.
  For banks, emphasise cash flow, collateral, and repayment capacity.
  For internal/board, emphasise strategic rationale and resource requirements.
-->

[TODO: Write after all sections are complete]

---

## Company Overview

<!--
WRITER INSTRUCTIONS:
- Length: Short (1-2 paragraphs)
- Cover: what the company does, what it sells, who it serves, when it was founded,
  where it operates, and its current stage.
- One crisp paragraph describing the business as if explaining it to a smart outsider
  in 60 seconds. No jargon.
- Second paragraph: legal structure, founding date, location, and any significant
  milestones to date (first customer, product launch, funding raised).
-->

### What {{company_name}} Does

[TODO: One paragraph. What the company does, who it serves, and what problem it solves.]

### Company Facts

- **Founded:** [Year]
- **Legal structure:** [e.g., Limited company / LLC / Partnership]
- **Headquarters:** [City, Country]
- **Stage:** {{stage}}
- **Current team size:** [Number of full-time employees]
- **Key milestones to date:** [2-3 bullet points: first product, first customer, first revenue, etc.]

---

## Mission and Vision

<!--
WRITER INSTRUCTIONS:
- Length: Short (1 paragraph each, or brief statements)
- Mission: What the company does today and for whom. Specific, not aspirational.
  "We help [customer] do [outcome] by [method]."
- Vision: Where the company is going in 5-10 years. Ambitious but believable.
- Values (optional): 3-5 operating principles that shape decisions. Only include if
  they are genuinely distinctive and evidenced in how the company operates — not
  generic corporate values.
-->

**Mission:** [TODO: One sentence. What the company does, for whom, and how.]

**Vision:** [TODO: One sentence. What the world looks like when the company succeeds at scale.]

### Values

<!-- Optional. Only include if distinctive and genuine. -->

1. **[Value name]:** [One sentence describing what this means in practice]
2. **[Value name]:** [One sentence]
3. **[Value name]:** [One sentence]

---

## Market Analysis

<!--
WRITER INSTRUCTIONS:
- Length: Medium (3-5 paragraphs + data tables)
- This section must answer: How big is the opportunity? Is it growing? Who is the customer?
- Structure: Market size → Growth trends → Customer segments → Customer pain points
- TAM/SAM/SOM framework:
    TAM (Total Addressable Market): The total global demand for this type of product/service.
    SAM (Serviceable Addressable Market): The portion of TAM the company can realistically target
      given its geography, product, and go-to-market.
    SOM (Serviceable Obtainable Market): The realistic market share the company expects to capture
      in the projection period.
- Cite sources for market data. "We estimate" is acceptable with clear methodology.
- Customer segments: Describe the 1-3 primary customer types in concrete terms
  (industry, size, role, behaviour — not vague demographics).
- Pain points: Be specific about what the customer suffers without this product.
  Avoid "customers want better solutions" — describe the actual problem they experience.
-->

### Market Size

| Market | Size | Growth Rate | Source |
|---|---|---|---|
| Total Addressable Market (TAM) | [£/$ value] | [% CAGR] | [Source] |
| Serviceable Addressable Market (SAM) | [£/$ value] | [% CAGR] | [Source] |
| Serviceable Obtainable Market (SOM, Year {{projection_years}}) | [£/$ value] | — | [Methodology] |

[TODO: 1-2 paragraphs on market trends — what is driving growth? What tailwinds support the company's timing?]

### Customer Segments

#### Primary Segment: [Segment Name]

- **Profile:** [Industry, company size, geography, role of buyer/user]
- **Problem they experience:** [Specific pain — what does their day look like without this product?]
- **How they solve it today:** [Current workaround — competitor, manual process, ignoring it]
- **Why current solutions are insufficient:** [What gap exists?]
- **Size of this segment within SAM:** [Estimated value or count]

#### Secondary Segment: [Segment Name] *(if applicable)*

- **Profile:**
- **Problem they experience:**
- **How they solve it today:**
- **Size of this segment within SAM:**

---

## Competitive Analysis

<!--
WRITER INSTRUCTIONS:
- Length: Medium (2-3 paragraphs + comparison table)
- This section must answer: Who else is solving this problem? Why will customers choose
  {{company_name}} over them?
- Do NOT disparage competitors. Describe them accurately and then differentiate.
- Competitive positioning: Name the specific dimensions on which {{company_name}} wins.
  These must be real, defensible advantages — not just "better product" or "lower price."
- Be honest about where competitors are strong. Readers who know the market will lose
  trust if you pretend competitors are weak.
- Competitive moat: What makes the advantage durable? (Network effects, proprietary data,
  switching costs, regulatory barriers, brand, cost structure?)
-->

### Competitive Landscape

[TODO: 1 paragraph characterising the competitive landscape — who are the main players,
how is the market structured, where are the gaps?]

### Competitor Comparison

| | {{company_name}} | [Competitor A] | [Competitor B] | [Competitor C] |
|---|---|---|---|---|
| [Dimension 1, e.g., Pricing model] | | | | |
| [Dimension 2, e.g., Target segment] | | | | |
| [Dimension 3, e.g., Key capability] | | | | |
| [Dimension 4, e.g., Integration depth] | | | | |
| [Dimension 5, e.g., Geographic coverage] | | | | |

### Competitive Advantage

[TODO: 1-2 paragraphs. What does {{company_name}} do better, and why is this advantage
durable? What would a competitor need to do to replicate it, and how long would that take?]

---

## Products and Services

<!--
WRITER INSTRUCTIONS:
- Length: Medium (3-5 paragraphs, optionally with a product overview table)
- This section must answer: What exactly does the company sell? How does it work?
  What does the customer get?
- Avoid technical depth that only insiders understand. Write for a smart outsider.
- Cover: core product/service description, key features and how they deliver value
  (not a feature list — tie each feature to a customer outcome), pricing model,
  and product roadmap direction.
- If the product is early-stage, describe current state honestly and roadmap clearly.
  Do not overstate maturity.
-->

### Core Offering

[TODO: 1-2 paragraphs. What the product/service is, how it works, and what the customer
gets from using it. Write as if explaining to an intelligent non-technical investor.]

### How It Delivers Value

| Feature / Capability | Customer outcome |
|---|---|
| [Feature 1] | [What this means for the customer in practical terms] |
| [Feature 2] | [Customer outcome] |
| [Feature 3] | [Customer outcome] |

### Pricing Model

- **Model:** [e.g., Subscription / Per-seat / Usage-based / Project-based / Retainer]
- **Entry price:** [e.g., £X/month for Y users]
- **Typical contract value:** [e.g., £X-Y annually]
- **Pricing rationale:** [Why this model fits the customer's buying behaviour]

### Product Roadmap

[TODO: Brief description of the next 12-18 months of product direction. What is being
built, and why does it matter for the commercial opportunity? Do not list features —
describe capability directions and their strategic purpose.]

---

## Go-to-Market Strategy

<!--
WRITER INSTRUCTIONS:
- Length: Medium (3-5 paragraphs)
- This section must answer: How does {{company_name}} find, win, and keep customers?
- Cover: sales model (direct / channel / self-serve / enterprise), primary acquisition
  channels, customer acquisition cost (CAC) and payback period (if known), retention
  and expansion strategy, and key partnerships.
- Be specific about channels — "digital marketing" is not a strategy. Name the channels,
  the approach, and why they work for this customer.
- Traction: If the company has early commercial evidence (customers, pilots, Letters of
  Intent (LOIs), revenue), include it here. Numbers beat assertions.
-->

### Sales Model

[TODO: How does {{company_name}} sell? Direct sales? Self-serve? Channel partners?
What is the typical sales motion — who are the buyers, what does the evaluation process
look like, who signs off?]

### Acquisition Channels

| Channel | Approach | Current status | Expected contribution |
|---|---|---|---|
| [e.g., Outbound sales] | [Description] | [Active / Planned / Testing] | [% of new ARR] |
| [e.g., Inbound / content] | [Description] | | |
| [e.g., Partnerships] | [Description] | | |
| [e.g., Events / conferences] | [Description] | | |

### Commercial Traction

[TODO: What evidence exists that the go-to-market works? Customers signed, pilots underway,
revenue run rate, pipeline size, conversion rates. If pre-revenue, describe the validation
done (customer interviews, LOIs, waitlist sign-ups). Be specific — numbers matter here.]

### Retention and Expansion

[TODO: How does {{company_name}} retain customers and grow revenue within the existing base?
Net Revenue Retention (NRR) if known. Expansion vectors (upsell, cross-sell, seat expansion).]

---

## Operations Plan

<!--
WRITER INSTRUCTIONS:
- Length: Short-to-medium (2-3 paragraphs)
- This section must answer: How does the company deliver its product/service at scale?
  What are the key operational dependencies and constraints?
- Cover: delivery model (how the product/service is produced and delivered), key
  operational infrastructure, technology stack summary (non-technical — what systems
  the business runs on), supply chain or key supplier dependencies (if relevant),
  and scalability — what needs to be built or hired as the company grows.
- For software businesses: focus on infrastructure, data security, compliance, and
  development process.
- For service businesses: focus on delivery capacity, quality control, and how the
  model scales without proportional cost increases.
-->

### Delivery Model

[TODO: How does {{company_name}} deliver value to customers? What is the operational
model — automated, human-delivered, hybrid? What are the key capacity constraints?]

### Key Infrastructure and Systems

[TODO: What operational systems, platforms, and infrastructure underpin the business?
Keep this non-technical — focus on capability and reliability, not stack details.]

### Scalability

[TODO: What needs to happen operationally for the business to 2x, 5x, 10x? Where are
the scaling bottlenecks and how will they be addressed?]

---

## Management Team

<!--
WRITER INSTRUCTIONS:
- Length: Short-to-medium (1 paragraph per key person + table)
- This section must answer: Can this team execute this plan?
- For each key team member: name, role, specific relevant experience (not a CV —
  highlight what makes them the right person for their role), and any notable
  achievements that signal capability.
- Be honest about gaps. If the team is missing a critical capability (e.g., no CFO yet),
  name it and describe the plan to fill it.
- Advisors and board: mention if they add genuine credibility or expertise — not just
  as names to drop.
-->

### Leadership Team

#### [Full Name] — [Title]

[TODO: 2-3 sentences. What have they done that makes them the right person for this role?
Focus on specific, verifiable achievements, not generic experience.]

#### [Full Name] — [Title]

[TODO: 2-3 sentences.]

#### [Full Name] — [Title] *(if applicable)*

[TODO: 2-3 sentences.]

### Team Overview

| Name | Role | Key background |
|---|---|---|
| [Name] | [Role] | [Most relevant experience in 1 line] |
| [Name] | [Role] | |
| [Name] | [Role] | |

### Current Headcount

- **Total full-time employees:** [n]
- **Key open roles:** [Roles currently being recruited for]
- **Planned headcount at end of projection period:** [n]

### Gaps and Hiring Plan

[TODO: What critical capabilities does the team currently lack? What is the plan and
timeline to fill them? This builds credibility — acknowledging gaps honestly is better
than pretending they don't exist.]

---

## Financial Projections

<!--
WRITER INSTRUCTIONS:
- Length: Medium (narrative + tables)
- Projection period: {{projection_years}} years
- This section must answer: What does the financial future look like? Is the business
  viable and fundable?
- Include: Revenue projections (broken down by product/segment if multiple), cost
  structure, gross margin, operating expenses, EBITDA, and cash flow summary.
- Key assumptions: State the assumptions driving the projections. What customer growth
  rate is assumed? What Average Contract Value (ACV)? What churn rate? What headcount
  growth? Assumptions must be specific and defensible.
- Sensitivity: Note what the biggest variable is and how the projections change if it
  is wrong. (e.g., "If Year 2 new customer acquisition is 30% below target, the company
  reaches breakeven 6 months later.")
- For funding documents: Show funding requirement clearly — how much is needed, when,
  and what it will be used for.
-->

### Revenue Projections

| | Year 1 | Year 2 | Year 3 | [Year 4] | [Year 5] |
|---|---|---|---|---|---|
| Revenue | | | | | |
| Revenue growth (%) | — | | | | |
| Gross profit | | | | | |
| Gross margin (%) | | | | | |
| Operating expenses | | | | | |
| EBITDA | | | | | |
| EBITDA margin (%) | | | | | |
| Cash position (end of year) | | | | | |

*All figures in [£/$/€]. [Fiscal year definition if non-standard.]*

### Key Assumptions

| Assumption | Year 1 | Year 2 | Year 3 | Basis |
|---|---|---|---|---|
| New customers acquired | | | | [How derived] |
| Average contract value (ACV) | | | | [How derived] |
| Annual churn rate | | | | [How derived] |
| Gross margin | | | | [How derived] |
| Headcount growth | | | | [How derived] |

### Narrative

[TODO: 2-3 paragraphs explaining the financial trajectory. What drives Year 1-2 growth?
When does the business reach breakeven? What is the key inflection point? What does
the cost structure look like as it scales?]

### Sensitivity Analysis

[TODO: What is the biggest risk to the financial projections? How do they change in
a downside scenario? What levers does management have to respond?]

---

## Funding Requirements

<!--
WRITER INSTRUCTIONS:
- Include this section only if {{funding_amount}} is specified (i.e., the company is
  seeking external funding). If not seeking funding, replace with an "Investment
  Highlights" or "Capital Efficiency" section summarising how the business funds
  its own growth.
- This section must answer: How much is being raised, at what stage, for what purpose,
  and what will it achieve?
- Use of proceeds: Be specific. Not "sales and marketing" — "hiring 4 enterprise account
  executives in H1 and building outbound infrastructure." Investors want to know their
  money is going to high-leverage activities.
- Milestones: What will this funding round enable the company to achieve? What does
  the next raise look like?
-->

### Funding Ask

- **Amount sought:** {{funding_amount}}
- **Instrument:** [e.g., Equity / Convertible note / Revenue-based financing / Term loan]
- **Use of proceeds:**

| Category | Amount | % of raise | Purpose |
|---|---|---|---|
| [e.g., Product development] | [£X] | [X%] | [Specific activities] |
| [e.g., Sales & marketing] | [£X] | [X%] | [Specific activities] |
| [e.g., Operations & infrastructure] | [£X] | [X%] | [Specific activities] |
| [e.g., Working capital / buffer] | [£X] | [X%] | [Specific activities] |

### Milestones This Funding Enables

[TODO: What will the business look like at the end of this funding runway? Specific,
measurable milestones — revenue targets, customer counts, product capabilities, team size.
What does this position the company for in its next financing round?]

### Previous Funding

| Round | Date | Amount | Investors |
|---|---|---|---|
| [e.g., Pre-seed] | [Date] | [Amount] | [Investors] |
| [e.g., Seed] | [Date] | [Amount] | [Investors] |

---

## Risk Analysis

<!--
WRITER INSTRUCTIONS:
- Length: Short-to-medium (table + brief narrative)
- This section must answer: What could go wrong, and what is management doing about it?
- Including risk analysis builds credibility. Readers who know the space will see risks
  anyway — better to name them and show you've thought about them.
- Cover the 4-6 most significant risks. Categories to consider: market risk (demand
  doesn't materialise), competitive risk (well-funded entrant), execution risk (team
  can't deliver), financial risk (runs out of cash), regulatory/legal risk, technology
  risk (product doesn't work as expected).
- For each risk: describe it specifically (not just "competition"), rate likelihood and
  impact, and describe the mitigation. Mitigations must be real — not "we will monitor
  the situation."
-->

### Risk Register

| Risk | Description | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| [e.g., Market adoption slower than projected] | [1-2 sentence description] | High / Med / Low | High / Med / Low | [Specific mitigation] |
| [e.g., Key person dependency] | | | | |
| [e.g., Competitive response from incumbent] | | | | |
| [e.g., Regulatory change] | | | | |
| [e.g., Technology scalability] | | | | |
| [e.g., Funding gap if projections missed] | | | | |

[TODO: 1 paragraph of narrative. What is the highest-priority risk and why is management
confident it can be managed? What early warning signals will the team monitor?]

---

## Appendices

<!-- Include as needed. Common appendices for a business plan: -->

### Appendix A — Detailed Financial Model

[Link to or attach the full financial model spreadsheet]

### Appendix B — Market Research Sources

[Citations for all market size and growth figures used in the Market Analysis section]

### Appendix C — Customer Evidence

[Customer testimonials, case studies, Net Promoter Score (NPS) data, or pilot results
that support claims made in the main document]

### Appendix D — Team CVs / Biographies

[Full biographies for key team members if required by the audience]

### Appendix E — Technical Documentation

[For technology businesses: architecture overview, security certifications, compliance
status — if required by the audience]

### Appendix F — Legal and Corporate

[Cap table, corporate structure, IP (Intellectual Property) ownership, material contracts
— if required by the audience]
