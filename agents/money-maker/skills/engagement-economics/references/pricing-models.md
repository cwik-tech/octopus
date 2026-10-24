# Consulting Pricing Models Reference

## Fixed Price

**When to use:** Scope is well-defined, complexity is moderate, and you have historical data on similar work.

**How it works:** Quote a total project price. Client pays the same amount regardless of actual hours spent. You keep margin if you deliver efficiently; you lose margin if scope expands or estimates miss.

**Risks:** Scope creep erodes margin. Missing estimates kills profitability. Unclear requirements lead to disputes.

**How to structure:**
- Define deliverables precisely. Each deliverable is testable.
- Build in contingency (15–25%) for unknowns.
- Use change control: any scope change = change order and price adjustment.
- Include acceptance criteria for each deliverable.

**Worked example:** Client wants a CRM implementation (setup, customization, data migration, user training).
- Deliverables: System configured (40h), Integrations built (30h), Data validated (20h), Team trained (10h). Total: 100h.
- Your blended rate: $150/h. Cost estimate: $15,000. Add 20% contingency: $18,000.
- Propose fixed price: $25,000. Margin: 40%.
- Scope locked: any custom field beyond the 5 agreed = change order.

---

## Time & Materials (T&M)

**When to use:** Scope is uncertain, discovery is required, or the client wants flexibility to pivot.

**How it works:** Bill hourly or daily rates. Client pays for hours worked, plus materials/expenses. No price cap; costs scale with actual effort.

**Risks:** Unbounded cost scares clients. Encourages inefficiency if not managed. Requires trust and transparency.

**How to structure:**
- Quote an hourly or daily rate (e.g., $200/h for senior consultant, $120/h for mid-level).
- Set a monthly or weekly cap if desired (e.g., "not to exceed $50k/month").
- Bill weekly or monthly with detailed timesheets.
- Include daily standups or check-ins so client sees progress.

**Worked example:** Client needs data strategy but doesn't know what it includes yet.
- Rate: $180/h, fully loaded.
- Phase 1 (discovery): 40 hours, ~$7,200. Deliverable: data audit, current-state assessment, recommendations.
- If recommendations are adopted, Phase 2: 60–80 hours for implementation, $10,800–$14,400.
- Client controls scope by deciding whether to proceed and how deep to go.

---

## Retainer

**When to use:** Ongoing support, advisory, or standby capacity is needed. Client wants predictable costs.

**How it works:** Client commits to a fixed monthly fee (e.g., 40 hours/month at $150/h = $6,000/month). You allocate time as needed. Unused hours typically don't roll over.

**Risks:** If demand is lumpy, you either underutilize (leaving margin on the table) or overcommit (missing SLA). Retainer decay: over time, scope expectations grow without price adjustment.

**How to structure:**
- Define hours per month (e.g., 40 hours).
- List what's included: advisory, on-call support, bug fixes, optimization.
- List what's out: new features, major refactors (billed separately).
- Bill monthly upfront. Require 30-day notice to cancel.
- Track utilization and recalibrate quarterly.

**Worked example:** Client wants ongoing cloud infrastructure support.
- Retainer: 30 hours/month at $180/h = $5,400/month.
- Includes: monitoring, patching, capacity planning, incident response (up to 30 hours).
- Excludes: new environments, migrations (billed as T&M).
- Year 1 revenue: $64,800. Margin depends on actual utilization.

---

## Value-Based Pricing

**When to use:** Work drives measurable business outcomes (revenue increase, cost savings, risk reduction). Client understands and trusts the outcome.

**How it works:** Price based on the value delivered, not hours spent. Aligns incentives: you win if the client wins.

**Risks:** Requires confidence in outcome quantification. If results underperform, you face pressure to discount or redo work.

**How to structure:**
- Quantify the business outcome: e.g., "This integration will save $500k/year in manual processing" or "This dashboard will increase sales by 15%."
- Price at a percentage of the value (e.g., 10–30% of year-1 savings).
- Include success metrics and a validation window (e.g., "payback period is 6 months").
- Consider outcome-based incentives: e.g., 70% upfront, 30% if targets are hit.

**Worked example:** Client wants an AI-powered customer churn prediction model.
- Quantified outcome: Catching 20% of at-risk customers early = $2M/year in retained revenue.
- Value-based price: 15% of year-1 benefit = $300,000.
- Structure: $200k upfront (development), $100k at 6-month validation (if model achieves 18%+ accuracy).
- Your margin depends on build cost, but you're incentivized to deliver real value.

---

## Hybrid Models

**Retainer + T&M.** Base retainer covers ongoing support (e.g., 20 hours/month); additional hours beyond the retainer are billed at T&M rate (same or higher).

**Fixed + Variable.** Fixed base price for core deliverables; variable fee based on usage, outcome, or scope expansion. E.g., "Base implementation: $50k + $1k per additional integration."

**Phase-based fixed + T&M.** Phase 1 is fixed price (quick win, de-risk). Phases 2+ are T&M (flexibility post-Phase 1 completion).

Choose hybrid models when scope is partially clear, or you want to balance predictability with flexibility.

---

## Choosing Your Model

| Model | Scope Clarity | Margin Upside | Client Cost Certainty | Risk to You |
|-------|---|---|---|---|
| Fixed Price | High | Low | High | High (scope creep) |
| T&M | Low | High | Low | Low (cost capped at effort) |
| Retainer | Medium | Medium | High | Medium (underutilization) |
| Value-Based | Medium | Very High | Medium | High (outcome risk) |

Start with hybrid: Phase 1 fixed (quick win, prove value), Phases 2+ T&M or value-based (flexibility, upside capture).
