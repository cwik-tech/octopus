---
name: measurement-confidence-design
description: Designs confidence, tolerance, provenance, and verification rules for dimensions derived from mobile room capture. Use when room geometry will inform furniture fit, CAD constraints, drawings, or any decision where measurement error has consequences.
---

# Measurement Confidence Design

## Objective

Prevent uncertain spatial-capture outputs from becoming falsely precise downstream geometry. Build a dimension contract that preserves what was observed, how reliable it is, and what must be verified.

## Dimension Contract

For every consequential dimension, record:

| Field | Meaning |
|---|---|
| Dimension | Named measurement and endpoints |
| Source | Scan-observed, reconstructed, user-entered, or manually verified |
| Estimate | Value and unit |
| Tolerance | Expected error range or uncertainty band |
| Confidence | High, medium, or low based on capture evidence |
| Verification state | Unverified, user-confirmed, or physically measured |
| Downstream permission | Ideation only, layout only, CAD provisional, or fabrication eligible |

## Procedure

1. **Classify consequence.** Identify whether an error affects visual plausibility, clearances, material quantities, joinery, installation, or safety.
2. **Classify evidence.** Mark each value as directly sensed, reconstructed from images, inferred from planes or priors, user-entered, or physically measured.
3. **Set tolerance bands.** Use task-specific tolerance requirements rather than one global accuracy claim. A room-scale concept can accept more uncertainty than a wall-to-wall fitted component.
4. **Set downstream gates.**
   - Ideation may use provisional values with visible uncertainty.
   - Layout recommendations may use bounded estimates and request confirmation for tight clearances.
   - CAD may use provisional constraints only when flagged and editable.
   - Shop-ready drawings require relevant dimensions to be physically measured or explicitly verified by the user.
5. **Design confirmation prompts.** Ask for the fewest high-consequence dimensions, show endpoints and units, explain why confirmation matters, and offer a simple physical-measurement method.
6. **Handle contradictions.** When user-entered or verified values conflict with the scan, preserve both sources, prioritize the verified value, and flag geometry requiring re-fit.
7. **Expose uncertainty honestly.** Never round a low-confidence estimate into an apparently exact fabrication dimension.

## Decision Rules

- If an estimate controls fit against walls, doors, windows, outlets, or permanent obstacles, require verification before fabrication output.
- If a surface is occluded, reflective, transparent, or insufficiently tracked, downgrade confidence rather than extrapolating silently.
- If repeated captures disagree beyond the allowed tolerance, treat the dimension as unverified and request a manual measurement.
- If device capability is unknown, use the conservative baseline confidence model.

## Report Format

Provide:

1. **Dimension-risk table** with source, tolerance, confidence, verification, and downstream permission.
2. **Required user confirmations** ordered by consequence.
3. **Blocked outputs** that must not be produced until verification occurs.
4. **Fallback workflow** for incomplete or low-confidence captures.

## Guardrails

- Never call a scan-derived value exact unless its method and tolerance support that claim.
- Never permit unverified site geometry to silently flow into a cut list or shop-ready drawing.
- Never hide uncertainty merely to reduce user friction.
