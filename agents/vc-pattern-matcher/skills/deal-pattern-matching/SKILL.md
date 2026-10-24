---
name: deal-pattern-matching
description: >
  Detects structural patterns between current deals and historical startup trajectories, both
  successful and failed. Identifies trajectory archetypes, failure mode signatures, and cross-domain
  structural isomorphisms. Used primarily by the Pattern Matcher agent.
---

# Deal Pattern Matching Skill

Adapted from the consulting structural-isomorphism skill for venture capital. Instead of matching problem structures across domains, this skill matches startup trajectories against known patterns — identifying both success archetypes and failure signatures.

## When to Use

On every deal — pattern recognition is always informative, even when the pattern is "this doesn't match anything we've seen."

---

## Pattern Matching Protocol

### Step 1 — Extract the Deal Shape

Strip the specifics and identify the abstract structure:

- **Growth pattern:** Linear, exponential, step-function, plateau, hockey-stick
- **Business model structure:** Marketplace (two-sided), platform (ecosystem), SaaS (subscription), transactional, hardware+software
- **Market entry strategy:** Bottom-up (PLG (Product-Led Growth)), top-down (enterprise sales), niche-first (vertical), broad-first (horizontal)
- **Competitive position:** First mover, fast follower, category creator, incumbent disruptor, adjacent expander
- **Funding pattern:** Capital-efficient, capital-intensive, blitzscale, bootstrapped-then-funded

### Step 2 — Match Against Trajectory Archetypes

**Success archetypes:**

| Archetype | Pattern | Historical Examples |
|---|---|---|
| **The Compounding Machine** | Steady 2-3x annual growth, improving margins, expanding customer base. Boring but unstoppable. | Veeva, ServiceNow, Atlassian |
| **The Network Effect Flywheel** | Slow start, then explosive growth as network effects kick in. Winner-take-most dynamics. | Uber, Airbnb, LinkedIn |
| **The Land-and-Expand** | Small initial contract, then expands within the customer. NRR >130%. | Slack, Datadog, Snowflake |
| **The Category Creator** | Defines a new category. Educates the market. Becomes the default. | Salesforce (CRM SaaS), HubSpot (inbound marketing) |
| **The Platform Shift** | Rides a major technology transition. Old world → new world. | AWS (on-premise → cloud), Shopify (retail → e-commerce) |
| **The Vertical Dominator** | Owns a single vertical completely. Deep product, high switching costs, limited TAM but dominant share. | Toast (restaurants), Procore (construction) |

**Failure archetypes:**

| Archetype | Pattern | Warning Signs |
|---|---|---|
| **Premature Scaling** | Raised too much, hired too fast, before product-market fit. Burn rate exceeds value creation. | Burn multiple >3x, rapid hiring without revenue acceleration, multiple pivots |
| **The Fundraising Treadmill** | Raises round after round without reaching sustainability. Each round at higher valuation but no closer to profit. | Declining capital efficiency, valuation inflation without metric improvement |
| **Co-Founder Breakup** | Team splits at a critical moment. Company loses key capabilities or enters leadership vacuum. | Equity disputes, divergent visions, one founder doing all the work |
| **The Market That Wasn't** | The problem is real but the market won't pay enough to build a venture-scale business. | Small ACV, long sales cycles, low willingness to pay, "nice to have" not "must have" |
| **The Feature, Not a Product** | What looks like a product is actually a feature that a platform will absorb. | Large platform (Google, AWS, Salesforce) ships comparable feature for free |
| **Channel Dependency Death** | Growth depends on a single channel (Google SEO, App Store, Facebook ads) that changes its rules. | >70% of acquisition from one channel, platform algorithm changes |

### Step 3 — Verify Pattern Match

For each candidate pattern match, verify at three levels:

1. **Entity mapping:** Do the key elements correspond? (Customers, product, go-to-market, competitive set)
2. **Dynamics mapping:** Are the growth/decline dynamics similar? (Growth rate, retention, competitive response)
3. **Conditions mapping:** Are the enabling conditions similar? (Market maturity, technology readiness, regulatory environment)

If all three hold, the pattern match is strong. If only entity mapping holds, it's a surface analogy.

### Step 4 — Extract Actionable Implications

For success pattern matches: What did the successful companies do at this stage that the current startup should emulate? What decisions were critical?

For failure pattern matches: What early signals preceded the failure? Are those signals present in the current deal? What could be done differently?

### Step 5 — Cross-Domain Structural Analysis

Apply the full structural isomorphism protocol from the consulting framework when the deal's dynamics map to patterns from non-startup domains:

- Cold-start problem = epidemiological spread pattern
- Customer concentration risk = ecological monoculture vulnerability
- Platform dependency = tributary river system (one dam blocks everything)
- Network effects = critical mass physics (phase transition)

---

## References & Templates

| File | Content |
|---|---|
| `references/trajectory-archetypes.md` | Detailed success and failure archetypes with case studies |
| `references/failure-mode-catalog.md` | Comprehensive catalog of startup failure modes with early warning signals |
| `templates/pattern-analysis.md` | Pattern matching output template |
