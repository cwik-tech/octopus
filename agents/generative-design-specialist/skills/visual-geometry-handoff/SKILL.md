---
name: visual-geometry-handoff
description: Defines safe handoffs from room captures and generated visuals to parametric geometry, CAD review, and shop documentation. Use when converting images into dimensions, meshes, furniture models, drawings, cut lists, or manufacturability claims.
---

# Visual-to-Geometry Handoff

## Objective

Specify a traceable, gated path from room imagery and generated furniture concepts to geometry and manufacturing artifacts, preventing false precision and unsupported CAD-ready claims.

## Handoff Rule

A visual artifact can suggest geometry; it cannot certify geometry. Every transition must state its input sources, uncertainty, transformation method, validation status, and responsible reviewer.

## Required Artifact Record

Attach the following to every visual-to-geometry handoff:

| Field | Requirement |
|---|---|
| Source assets | Identify room capture, reference image, generated concept, and user edits |
| Provenance | Mark values as measured, inferred, estimated, generated, or verified |
| Spatial confidence | State capture quality, scale basis, occlusions, and uncertain boundaries |
| Constraint version | Preserve the exact active design constraints and overrides |
| Geometry method | State whether geometry is manually modeled, parameterized, reconstructed, or AI-proposed |
| Validation status | List completed checks and unresolved checks |
| Ownership | Name the next responsible specialist or user approval step |

## Gated Pipeline

1. **Capture qualification:** Assess scale references, coverage, occlusion, distortion, and measurement confidence.
2. **Room model creation:** Produce a room envelope with confidence annotations, not unqualified exactness.
3. **Concept anchoring:** Position visual concepts within the qualified room model; preserve clearances and reference assumptions.
4. **Geometry proposal:** Translate selected dimensions and features into editable parametric geometry. Mark any inferred geometry.
5. **Feasibility validation:** Check fit, accessibility, material thickness, structural plausibility, assembly sequence, wood movement, and machine limits.
6. **CAD approval:** Permit a CAD-ready label only after the defined geometric and construction checks pass.
7. **Documentation release:** Permit drawings and cut lists only when the CAD model, materials, joinery, tolerances, and revision status are reviewed.

## Validation Gates

### Gate A: Spatial Validity

- Room dimensions have stated confidence.
- The furniture envelope does not violate required clearances.
- Doors, windows, outlets, obstructions, and access paths are accounted for.
- Any unresolved room geometry blocks shop-ready output.

### Gate B: Geometric Validity

- Major dimensions are parameterized or sourced.
- Parts, interfaces, and thicknesses are internally consistent.
- The model distinguishes decorative visual detail from production geometry.
- No hidden or occluded feature is claimed as known without verification.

### Gate C: Manufacturability

- Joinery, loads, wood movement, assembly sequence, and hardware requirements receive appropriate specialist review.
- Material and machine constraints are checked.
- Cut-list quantities and dimensions derive from approved geometry, not image interpretation.

## User Communication

Use direct labels:

- “Visual concept — dimensions require confirmation.”
- “Geometry candidate — pending manufacturability review.”
- “Validated CAD — ready for drawing preparation.”
- “Shop-ready package — reviewed for the stated materials and constraints.”

Avoid “accurate,” “build-ready,” “manufacturable,” or “CAD-ready” unless the corresponding gate is complete.

## Failure Handling

If a required input is uncertain, offer one of these paths:

1. Request a targeted recapture or manual measurement.
2. Continue with parameterized ranges and label the output as provisional.
3. Simplify the concept to reduce dependency on uncertain geometry.
4. Stop progression to drawings or cut lists until validation is complete.

## Report Format

Return: current artifact state, provenance summary, passed and blocked gates, required next validation, downstream owner, and user-visible confidence warning.
