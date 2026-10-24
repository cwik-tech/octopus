---
name: engagement-economics
description: >
  Scope, price, and structure profitable consulting engagements. Optimize for cash flow,
  profitability, and early revenue realization. Used by Money Maker and Pragmatist agents.
  Use when estimating the economics and delivery cost of a consulting engagement.
---

# Engagement Economics Skill

Use this skill to convert consulting opportunities into profitable, invoiceable work structures. Focus on identifying the smallest viable first deliverable, maximizing cash flow velocity, and pricing for profitability and risk.

## Engagement Scoping Protocol

Estimate effort and identify deliverables:

1. **Define scope boundaries.** Ask: What's included? What's explicitly out? Does the client need ongoing support or one-time delivery?
2. **Decompose into deliverables.** List discrete outputs: reports, code, analyses, training, documentation. Each deliverable is independently testable and valuable.
3. **Estimate effort per deliverable.** Use best case, likely case, worst case. Account for discovery, iteration, and knowledge gaps.
4. **Identify dependencies.** Which deliverables block others? Which can run in parallel? This shapes milestone sequencing.
5. **Flag unknowns.** What could derail estimates? Client responsiveness? Technical uncertainty? Integration complexity? These inform risk pricing (see below).

## Pricing Models: When to Use Each

**Fixed Price.** Use when scope is locked, complexity is moderate, and you have historical data. Best for predictable work (implementation, migration, defined integrations). Risk: scope creep eats margins. Mitigate with change control and clear deliverables definition.

**Time & Materials (T&M).** Use when scope is uncertain, discovery is required, or client wants flexibility. Bill hourly or daily rates. Best for advisory, exploration, augmentation. Upside: protect margin from surprises. Downside: client hesitates on cost.

**Retainer.** Use for ongoing support, advisory, or standby capacity. Commit hours per month, billed upfront. Best for long-term relationships and predictable demand. Upside: cash certainty. Downside: if demand is lumpy, you leave margin on the table.

**Value-Based Pricing.** Price based on business outcome, not effort. Requires confidence in the value delivered. Best for transformative work where ROI is clear (revenue increase, cost savings, risk reduction). Upside: align incentives, high margins. Downside: requires outcome certainty and client trust.

See `references/pricing-models.md` for detailed models and worked examples.

## Milestone Structuring

Break engagements into invoiceable phases. Apply the **quick win first** principle: identify the smallest deliverable that proves value and can be invoiced within 2-4 weeks.

**Milestone sizing:** Aim for 2-4 week cycles. Each milestone ends with a testable deliverable. Bill at milestone completion, not commencement.

**Phase sequencing:** Order milestones to maximize:
- Early revenue (quick wins first)
- Dependency satisfaction (block dependencies are done before dependent work)
- Risk reduction (reduce unknowns early)

**Dependency management:** If Milestone B depends on Milestone A's output, sequence them sequentially. If they're independent, run in parallel to compress timeline.

**Contract structure:** Each milestone is a separate line item. When Phase 1 is complete and invoiced, client has the option to proceed. This creates natural exit ramps and protects you from scope creep.

See `references/milestone-structuring.md` for worked examples.

## Profitability Analysis

Calculate after setting milestones and pricing:

1. **Revenue per hour.** Total price / total effort hours. Benchmark against your target blended rate.
2. **Utilization rate.** Actual billable hours / available hours in the engagement period. Factor in non-billable time (sales, admin, rework).
3. **Cost of delay.** If delivery extends, what's the impact? Late milestone = delayed revenue and potential penalty fees.
4. **Gross margin.** (Price - Cost) / Price. Include both direct labor and indirect costs (overhead, support, risk buffer).

If revenue per hour is below target or margin is thin, reconsider scope, pricing, or risk profile.

## Phase 1 Extraction Protocol

Given a large engagement, isolate the smallest valuable first deliverable:

1. **Start with client's primary pain point.** What's the biggest blocker they face?
2. **Define the minimum that addresses it.** Don't solve the whole problem; solve the first part.
3. **Choose a 2-4 week timeline.** If it takes longer, it's not Phase 1; decompose further.
4. **Ensure it's independently valuable.** Can the client use it and see value even if the engagement stops?
5. **Price to win.** Phase 1 is your foot in the door. Make it attractive. Margins come from Phases 2+.

Example: Large data migration project. Phase 1 = assess source systems, document schema, create test dataset, deliver a migration plan and risk assessment (4 weeks, $25k). Phases 2-4 = actual migration, testing, validation. This way, client sees a plan, you've reduced technical risk, and you're positioned for the rest.

## Risk Pricing

Adjust pricing to account for uncertainty:

- **Scope creep risk.** If scope is fuzzy, add 20–30% contingency or use T&M pricing.
- **Technical uncertainty.** Unknown tech stack, legacy system complexity, integration unknowns? Add 15–25% buffer.
- **Client responsiveness risk.** Slow feedback, decision lag, unclear requirements? Add 10–20% and build longer timelines.
- **Regulatory/compliance risk.** If work touches regulated domains (HIPAA, PCI, SOC 2), add 20–40% for audit, documentation, and review cycles.

Price the risk into the bid. Don't absorb it; pass it to the client. Be transparent: "Given the legacy system complexity, we're building 15% contingency into our estimate."

## Outputs and Templates

Use `templates/engagement-scope.md` to document every engagement economics decision. Include deliverables, pricing, milestones, cash flow, and profitability metrics. This becomes the contract foundation and your execution roadmap.

### Quick Checklist

- [ ] Scope defined (inclusions and exclusions listed)
- [ ] Deliverables decomposed and estimated
- [ ] Pricing model selected and justified
- [ ] Milestones sequenced (quick wins first)
- [ ] Phase 1 identified (2-4 weeks, independently valuable)
- [ ] Risk pricing applied
- [ ] Revenue per hour meets target
- [ ] Profitability acceptable
- [ ] Engagement scope document completed
