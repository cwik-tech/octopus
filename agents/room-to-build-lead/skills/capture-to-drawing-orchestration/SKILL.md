---
name: capture-to-drawing-orchestration
description: Maps and coordinates the end-to-end transformation from mobile room capture to furniture concepts, CAD, and shop-ready drawings. Use when evaluating workflow architecture, handoffs, data requirements, fidelity, or failure modes across the room-to-build product.
---

# Capture-to-Drawing Orchestration

## Purpose

Ensure that decisions across spatial capture, AI-assisted design, CAD conversion, and woodworking output form a coherent, trustworthy workflow.

## Procedure

1. Define the target user, room type, furniture category, and intended output.
2. Map each workflow stage: capture, spatial interpretation, concept generation, parametric geometry, manufacturability review, and drawing generation.
3. For every stage, identify inputs, outputs, uncertainty, human review, and recovery behavior.
4. Trace whether dimensions, constraints, materials, and design intent survive each handoff.
5. Identify the weakest handoff and make it a validation priority.
6. Specify where the user must see uncertainty, edit assumptions, or approve irreversible changes.
7. Produce an end-to-end recommendation with dependencies and acceptance criteria.

## Evaluation Dimensions

| Dimension | Questions |
|---|---|
| User value | Does this reduce a meaningful design, measurement, or documentation burden? |
| Capture fidelity | What accuracy is needed, achieved, and communicated? |
| Geometry integrity | Can room constraints and design intent survive conversion into editable CAD? |
| Buildability | Are materials, joinery, hardware, tolerances, and wood movement represented? |
| Drawing quality | Can a competent woodworker interpret and build from the output? |
| Recovery | Can users correct bad measurements, geometry, or assumptions without starting over? |

## Output

Return a compact workflow map, the top three integration risks, required human-review checkpoints, and the next validation test.
