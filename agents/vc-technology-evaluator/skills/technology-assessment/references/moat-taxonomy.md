# Moat Taxonomy for Technology Companies

## Purpose

Detailed classification of technology moats with evaluation criteria, measurement methods, and examples. Used to assess the depth and durability of a startup's competitive defensibility.

---

## Moat Type 1 — Network Effects

### Definition
The product becomes more valuable as more people use it. Each new user adds value for all existing users.

### Subtypes

**Direct network effects:** Same-side — more users of the same type make the product better for all users of that type. Example: messaging apps (more people on WhatsApp = more useful), social networks.

**Indirect (cross-side) network effects:** Different sides — more users on one side attract more users on the other side. Example: marketplaces (more sellers attract more buyers, and vice versa), platforms (more developers create more apps, attracting more users).

**Data network effects:** More usage generates more data, which improves the product, which attracts more users. Example: recommendation engines, search engines, ML (Machine Learning) models that improve with training data.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Growth acceleration | Growth rate increases with scale | Growth rate is constant or decreasing |
| User value proposition | Users explicitly cite network as reason to stay | Users cite features, not network |
| Multi-homing cost | High — hard to use competing product simultaneously | Low — users easily use multiple products |
| Critical mass | Reached — network is self-sustaining | Not reached — still requires subsidies |

### Strength: Very Strong | Duration: Long (once critical mass is reached)

---

## Moat Type 2 — Switching Costs

### Definition
The cost (financial, time, effort, risk) a customer incurs when moving to a competitor. The higher the switching cost, the stickier the product.

### Subtypes

**Data lock-in:** Customer's data is deeply embedded in the product. Migration is expensive and risky. Example: CRM systems (years of customer data), ERP (Enterprise Resource Planning) systems.

**Workflow integration:** Product is embedded in daily workflows. Switching requires retraining. Example: Slack (team communication habits), Figma (design team workflows).

**API/integration dependency:** Other systems depend on the product's APIs. Switching breaks downstream systems. Example: Stripe (payment integrations), Twilio (communication APIs).

**Contractual lock-in:** Multi-year contracts with penalties for early termination. Example: enterprise software agreements.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Customer tenure | Average customer tenure >3 years | High annual churn |
| Integration depth | Product connects to 5+ other systems | Standalone product |
| Data volume | Customers store critical data in the product | Minimal data investment |
| Retraining cost | Switching requires significant team retraining | Product is simple enough to learn quickly |

### Strength: Strong | Duration: Long

---

## Moat Type 3 — Economies of Scale

### Definition
Unit costs decrease as volume increases, creating a cost advantage that smaller competitors cannot match.

### Subtypes

**Supply-side economies:** Manufacturing or infrastructure cost per unit decreases with volume. Example: cloud infrastructure (AWS), semiconductor manufacturing.

**Demand-side economies:** Customer acquisition cost decreases with brand awareness and word-of-mouth. Example: consumer brands with high organic traffic.

**Learning curve effects:** Cumulative production experience reduces costs. Example: Tesla's manufacturing efficiency improvements.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Gross margin trajectory | Improving with scale | Flat or declining |
| Unit cost curve | Clearly declining | Constant |
| Competitor cost comparison | Meaningful cost advantage | Marginal difference |
| Minimum efficient scale | High — requires significant volume to compete | Low — small competitors can match costs |

### Strength: Strong | Duration: Medium-Long

---

## Moat Type 4 — Intellectual Property

### Definition
Legal protection (patents, trade secrets, proprietary algorithms) that prevents direct replication.

### Subtypes

**Granted patents:** Legal monopoly on specific technology. Duration: 20 years from filing.

**Trade secrets:** Proprietary knowledge that isn't publicly disclosed. Duration: indefinite, but lost if disclosed.

**Proprietary algorithms:** Custom-built technology that would take significant time and expertise to replicate. Duration: until someone replicates it.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Patent breadth | Broad claims, hard to design around | Narrow claims, easy workarounds |
| Patent jurisdiction | Filed in all key markets | Filed only in one country |
| Trade secret protection | Formal NDA (Non-Disclosure Agreement) program, access controls | Informal knowledge management |
| Freedom to operate | Clean FTO (Freedom to Operate) search completed | Potential infringement risks |

### Strength: Medium | Duration: Medium (patents expire; trade secrets can leak)

---

## Moat Type 5 — Brand

### Definition
Customer recognition, trust, and preference that creates a pricing premium and reduces acquisition cost.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Unaided awareness | Customers name the product without prompting | Requires explanation |
| Pricing premium | Charges more than competitors for similar features | Competes on price |
| NPS (Net Promoter Score) | >50 | <20 |
| Word-of-mouth | Significant organic growth | Growth is primarily paid |
| Category association | "the X of Y" — default choice in category | One of many options |

### Strength: Medium | Duration: Medium (brands can erode)

---

## Moat Type 6 — Regulatory Capture

### Definition
Compliance with regulations creates a barrier that new entrants must invest significant time and capital to overcome.

### Examples
- Banking licenses (fintech)
- FDA (Food and Drug Administration) approval (healthtech)
- SOC 2 / HIPAA (Health Insurance Portability and Accountability Act) compliance (enterprise SaaS)
- Insurance licenses (insurtech)
- Telecom licenses (communications)

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| License/certification difficulty | Years to obtain, significant investment | Weeks to months |
| Regulatory complexity | Requires specialized compliance team | Self-service compliance |
| Enforcement risk | Active enforcement creates real barriers | Regulation exists but isn't enforced |
| Regulatory trajectory | Regulation is tightening (increasing barrier) | Regulation is loosening (decreasing barrier) |

### Strength: Strong | Duration: Long (as long as regulation persists)

---

## Moat Type 7 — Data Moat

### Definition
Proprietary data assets that improve the product and are difficult or impossible for competitors to replicate.

### Evaluation Criteria

| Signal | Strong | Weak |
|---|---|---|
| Data uniqueness | No other source for this data | Publicly available or purchasable |
| Data volume | Largest dataset in the domain | Similar size to competitors |
| Data freshness | Continuously generated by users | Static dataset |
| Data-to-product feedback | Data directly improves product quality | Data is stored but not leveraged |
| Data defensibility | Generated through proprietary user interactions | Scraped from public sources |

### Strength: Variable | Duration: Variable (depends on whether data compounds)

---

## Composite Moat Assessment

The strongest companies have multiple reinforcing moats. Score each moat 0-3 and sum:

| Moat Type | Score (0-3) | Evidence |
|---|---|---|
| Network effects | | |
| Switching costs | | |
| Economies of scale | | |
| IP / Patents | | |
| Brand | | |
| Regulatory capture | | |
| Data moat | | |
| **Composite score** | **/21** | |

**Interpretation:** 0-5 = Weak moat, 6-10 = Moderate moat, 11-15 = Strong moat, 16+ = Exceptional moat

**Key question:** Do the moats reinforce each other (e.g., more users → more data → better product → more users), or are they independent?
