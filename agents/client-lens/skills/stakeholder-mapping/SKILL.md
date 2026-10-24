---
name: stakeholder-mapping
description: Identify, classify, and map decision-makers, influencers, blockers, budget holders, and hidden stakeholders with power/interest analysis and political dynamics mapping. Use when identifying stakeholders, their interests, and decision influence.
---

# Stakeholder Mapping Skill

## Purpose
Extract and analyze all stakeholders in a consulting engagement systematically. Surface decision-makers, financial gatekeepers, hidden blockers, and political dynamics that shape feasibility and adoption.

## Stakeholder Identification Protocol

**Step 1: Direct Extraction**
- Read the problem statement, brief, and any organizational context provided.
- List every person, role, department, or function explicitly mentioned.
- Note their stated involvement ("approves budget," "owns operations," "requested the engagement").

**Step 2: Role-Based Inference**
- Infer implicit stakeholders by organizational structure:
  - Who *owns* the problem domain? (Process owner, VP, C-suite sponsor)
  - Who *controls* the budget or resources needed to solve it?
  - Who *executes* the solution? (Operations, IT, line managers)
  - Who is *affected* by changes? (End users, adjacent teams, customers)
  - Who has *veto power*? (Risk, compliance, legal, finance)

**Step 3: Hidden Stakeholder Detection**
- Look for unstated dependencies: IT approval, legal review, union agreements, competing initiatives.
- Identify roles by function, not just names. If no CFO is named, the finance function is still a stakeholder.
- Ask: "Who could block this? Who makes the final call? Who controls the budget?"

## Classification System

Map each stakeholder to one or more types:

| Type | Definition | Engagement Priority |
|------|-----------|-------------------|
| **Decision Maker** | Final authority on problem scope, solution approach, and go/no-go | Critical |
| **Influencer** | Shapes decision maker's view without direct authority; trusted advisor | High |
| **Champion** | Internally advocates for the engagement and solution; removes obstacles | High |
| **Blocker** | Can veto or derail; may not support openly but has latent power | Critical |
| **Budget Holder** | Controls or approves financial resources; may be separate from decision maker | Critical |
| **End User** | Affected by the solution; impacts adoption and success metrics | Medium |

## Power/Interest Matrix Analysis

See `references/power-interest-matrix.md` for detailed methodology.

**Four Quadrants:**
- **High Power, High Interest** (Manage Closely): Decision makers, champions, primary blockers. Daily alignment needed.
- **High Power, Low Interest** (Keep Satisfied): Budget gatekeepers who don't engage deeply. Clear reporting, minimal friction.
- **Low Power, High Interest** (Keep Informed): End users, advocates. Involve in design, leverage for adoption.
- **Low Power, Low Interest** (Monitor): Secondary stakeholders. Track only for surprises.

Plot each stakeholder on the matrix. Assign engagement intensity accordingly.

## Mapping Political Dynamics

See `references/political-dynamics.md` for full framework.

**Key Actions:**
1. **Identify alliance networks**: Who works together? Who competes?
2. **Uncover hidden agendas**: Whose interests conflict? Who wins or loses if the solution succeeds?
3. **Detect formal vs. informal authority**: Org chart authority ≠ actual influence. Find the real decision-maker.
4. **Surface blockers disguised as supporters**: Look for rhetorical patterns ("I support this, but..."), slow approvals, or resource withholding.
5. **Map influence flows**: How does information reach decision-makers? Whose opinion matters most?

## Stakeholder Communication Preferences & Engagement

Tailor your approach by stakeholder type and power/interest quadrant:

- **Decision Makers & Champions**: Structured updates, business impact focus, decision-ready options.
- **Blockers**: Address concerns directly; understand incentives; propose win-win framing.
- **Budget Holders**: ROI metrics, risk-adjusted cost, approval timeline, financial dependencies.
- **End Users**: Implementation details, change impact, support availability, feedback loops.
- **Influencers**: Peer examples, peer recognition, opportunity to shape narrative.

## Output & Templates

Use `templates/stakeholder-map.md` to document:
- Stakeholder register (table: name, role, classification, power, interest, stance, incentive).
- Relationship map narrative (alliance networks and conflicts).
- Key risks (misalignment, hidden opposition, blocked resources).
- Engagement strategy (communication cadence, key messages, escalation triggers).
- Unknowns and gaps (missing information that could change strategy).

## Key References

- **Power/Interest Matrix**: `references/power-interest-matrix.md` — Mendelow framework, classification logic, worked example.
- **Political Dynamics**: `references/political-dynamics.md` — Alliance mapping, hidden agendas, formal vs. informal authority, blocker detection.
- **Output Template**: `templates/stakeholder-map.md` — Standardized format for stakeholder analysis delivery.

## Common Pitfalls to Avoid

1. **Org chart myopia**: Don't assume the VP owns the decision; check who actually influences it.
2. **Missing the quiet blocker**: Absence of objection ≠ support. Probe for reservations.
3. **Forgetting finance and risk**: Always surface finance/budget holders and compliance/risk stakeholders.
4. **Ignoring incentive misalignment**: A stakeholder may support the *engagement* but not the *solution*.
5. **Assuming static positions**: Stakeholder power and interest shift; revisit the map as engagement evolves.

## Integration with Consulting Crew

- **Client Lens Agent**: Runs this skill early to build engagement strategy and inform problem framing.
- **Money Maker Agent**: Uses the Budget Holder classification and Power/Interest matrix to identify and align financial gatekeepers.
- **Ongoing Reference**: Update the stakeholder map as new information emerges; use it to anticipate resistance and guide communication.
