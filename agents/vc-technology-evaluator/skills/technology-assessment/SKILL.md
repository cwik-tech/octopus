---
name: technology-assessment
description: >
  Evaluates startup technology, product maturity, IP defensibility, and technical risk. Assesses
  moat depth, replication difficulty, architecture quality, and technical team strength. Used
  primarily by the Technology & Product Evaluator agent.
---

# Technology Assessment Skill

## When to Use

On every deal where technology is a core differentiator. Mandatory for Deep Tech, Infrastructure, and any IP-heavy deal. Selective for Consumer, Marketplace, and SaaS where the moat is distribution or network effects rather than technology.

---

## Assessment Protocol

### Step 1 — Product Maturity Classification

| Level | Description | Investment Implication |
|---|---|---|
| **Concept** | Idea or whitepaper only. No code. | Pure science/team bet. Very high risk. |
| **Prototype** | Working demo, not production-ready. | Validates technical feasibility, not market. |
| **MVP** | Functional product with real users. Rough. | Validates core value proposition. |
| **Product** | Stable, scalable, paid customers. | Product-market fit testable. |
| **Platform** | Core product + extensibility, integrations, ecosystem. | Defensibility through breadth. |

**Mismatch warning:** If the startup claims to be at "Product" level but the product crashes during demo, reclassify.

### Step 2 — Technology Differentiation Assessment

**Core question:** Is the technology genuinely differentiated, or is this a well-executed application of existing technology?

| Differentiation Level | Description | Examples |
|---|---|---|
| **Novel technology** | New algorithm, process, or scientific approach | Breakthrough ML model, new materials science, novel biomarker |
| **Novel architecture** | Existing technology combined in a new way | Unique data pipeline, novel system design, proprietary integration approach |
| **Novel application** | Existing technology applied to a new domain | GPT applied to legal contracts, computer vision for agriculture |
| **Execution advantage** | Same technology, better execution | Better UX, faster performance, cleaner code |

**Investment implication:** Novel technology creates the deepest moat but carries the highest risk. Execution advantage creates the shallowest moat but is the most predictable.

### Step 3 — Moat Depth Assessment

Apply the moat taxonomy to the specific technology:

**The $100M Test:** If a well-funded competitor ($100M+) decided to replicate this technology, how long would it take?

| Moat Source | Replication Time | Strength |
|---|---|---|
| Proprietary data that improves with usage | 2-5 years | Very strong (data network effects compound) |
| Granted patents on core technology | 3-7 years (patent life) | Strong (legal protection) |
| Network effects (more users = better product) | 2-4 years | Strong (but requires critical mass) |
| Deep domain expertise encoded in product | 1-3 years | Moderate (knowledge is transferable) |
| Integration depth with customer systems | 1-2 years | Moderate (creates switching costs) |
| First-mover advantage alone | 6-18 months | Weak (not a real moat) |
| Better UX / design alone | 3-6 months | Very weak (easily replicated) |

### Step 4 — Technical Risk Assessment

| Risk Category | Questions to Ask |
|---|---|
| **Science risk** | Does the underlying technology work? Has it been validated? (Highest risk — if the science doesn't work, everything else is moot.) |
| **Engineering risk** | Can the technology be built into a production-quality product? (Lower risk if the science is proven, but still significant for complex systems.) |
| **Scale risk** | Does the technology work at 100x current load? (Many systems that work at demo scale fail at production scale.) |
| **Integration risk** | Can the product integrate with customer systems? (Enterprise products must play well with existing infrastructure.) |
| **Talent risk** | Can the team hire the specialized talent needed? (ML engineers, hardware engineers, domain-specific scientists.) |
| **Platform risk** | Does the product depend on a platform that could change (API changes, pricing changes, competing features)? |

### Step 5 — Technical Team Evaluation

| Signal | Positive | Negative |
|---|---|---|
| **CTO/Tech lead** | Built and scaled similar systems before | First time building at this complexity level |
| **Team depth** | Multiple senior engineers with relevant experience | Single genius with no supporting team |
| **Architecture decisions** | Evidence of thinking about scale, security, maintainability | "We'll fix that later" approach to technical debt |
| **Open source contributions** | Active contributors to relevant projects | No public technical presence |
| **Technical culture** | Code review, testing, documentation practices | "Move fast and break things" without the "fix things" part |

### Step 6 — IP Audit

- **Patents:** Filed? Granted? In which jurisdictions? Are they broad enough to prevent workarounds? Are they narrow enough to be enforceable?
- **Trade secrets:** Does the company have proprietary data, processes, or algorithms not captured in patents?
- **IP ownership:** Is all IP assigned to the company (not to individual founders or a university)?
- **Open-source risk:** Does the product use copyleft-licensed open-source code that could require the product to be open-sourced?
- **Prior art risk:** Could existing patents from other companies threaten the startup's freedom to operate?

---

## References & Templates

| File | Content |
|---|---|
| `references/moat-taxonomy.md` | Detailed moat types with evaluation criteria and examples |
| `references/technical-diligence-checklist.md` | Technical due diligence question bank |
| `templates/technology-assessment.md` | Technology evaluation output template |
