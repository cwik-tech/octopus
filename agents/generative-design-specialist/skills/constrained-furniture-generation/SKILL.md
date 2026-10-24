---
name: constrained-furniture-generation
description: Designs constraint-led AI furniture concept generation with editable parameters, output states, and ranking rules. Use when creating room-aware design generation, reference-image workflows, configurable furniture concepts, or generation guardrails.
---

# Constrained Furniture Generation

## Objective

Turn user intent, room context, and furniture requirements into useful concept-generation behavior without treating a generative image as verified design documentation.

## Core Principle

A generated concept is only as trustworthy as its inputs and validation state. Preserve the distinction between measured facts, user requirements, inferred values, visual proposals, and verified geometry.

## Input Taxonomy

Classify every input before generating:

| Class | Examples | Treatment |
|---|---|---|
| Measured | Wall spans, openings, ceiling height, detected obstacles | Preserve source and confidence; enforce as hard constraints only when confidence is sufficient |
| User-specified | Intended use, capacity, preferred material, budget | Treat as editable requirements or preferences |
| Inferred | Likely style, unmeasured depth, lighting conditions | Display as assumptions; allow confirmation or override |
| Reference | Inspiration photos, saved styles, existing furniture | Use for visual direction, not dimensional or structural truth |
| Unknown | Load, wall construction, exact lumber stock, tool access | Flag; do not fabricate as settled facts |

## Constraint Model

Build a concept brief with these categories:

1. **Hard spatial constraints:** Envelope, clearance, door and drawer swing, access routes, window and outlet conflicts.
2. **Functional constraints:** Storage volume, seating count, desk use, display needs, cable management, accessibility.
3. **Human constraints:** Reach, seated height, ergonomic posture, child or pet safety, maintenance needs.
4. **Manufacturing constraints:** Material thickness, available stock, machine capacity, joinery capability, assembly access, transport limits.
5. **Aesthetic preferences:** Style, color family, silhouette, reference influence, visual weight, degree of originality.
6. **Economic constraints:** Target budget, labor tolerance, material waste, hardware class.

For every constraint, specify: source, confidence, hard or soft status, allowed range, default, owner, and user-editability.

## Generation Protocol

1. Create a visible constraint summary before generation.
2. Generate multiple materially and spatially distinct concepts rather than superficial image variants.
3. Rank concepts against declared constraints, not visual appeal alone.
4. Explain major tradeoffs: storage versus footprint, visual lightness versus stiffness, budget versus material, or style versus build complexity.
5. Let users edit critical parameters and regenerate only affected aspects where possible.
6. Preserve the exact constraint set and generation version with each chosen concept.

## Output States

Use these labels consistently:

| State | Meaning | May be used for |
|---|---|---|
| Inspiration | Style or layout suggestion with no dimensional commitment | Discovery and preference elicitation |
| Constrained concept | Visual proposal evaluated against stated inputs | User selection and refinement |
| Geometry candidate | Preliminary dimensional representation requiring validation | CAD review and feasibility analysis |
| Validated CAD | Parametric model that passed defined geometric and construction checks | Drawing preparation |
| Shop-ready package | Reviewed drawings, cut list, materials, and build notes | Fabrication |

Never skip labels or imply a later state from an earlier one.

## Quality Checks

Before recommending a concept, verify:

- The room envelope and clearance assumptions are disclosed.
- Required functions are visibly addressed.
- Dimensions are either sourced, parameterized, or marked unverified.
- Reference imagery has not been converted into unsupported construction claims.
- The concept identifies features needing CAD, joinery, or manufacturing review.
- Users can revise the constraints that materially affect the output.

## Report Format

Return: input confidence summary, constraint table, generation behavior, output-state label, ranked tradeoffs, validation dependencies, and user-facing warnings.
