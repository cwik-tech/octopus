---
name: mobile-room-capture-assessment
description: Evaluates iOS and Android room-scanning approaches across sensors, reconstruction quality, user workflow, failure modes, and privacy. Use when selecting mobile spatial capture technology, defining device support, or assessing whether captured geometry is usable downstream.
---

# Mobile Room Capture Assessment

## Objective

Turn a proposed room-capture experience into a realistic capability assessment. Evaluate the full chain: device sensing, tracking, reconstruction, user capture behavior, geometry output, data handling, and downstream use.

## Assessment Procedure

1. **State the downstream job.** Classify the intended use as concept inspiration, furniture placement, dimensional layout, CAD constraint input, or fabrication documentation. Record the tolerance and consequence of error.
2. **Define supported-device tiers.** Separate:
   - baseline RGB-camera devices;
   - devices with AR tracking support;
   - devices with dedicated depth sensing;
   - optional premium-enhancement paths.
   Do not let a premium tier become an unstated dependency of the baseline product.
3. **Compare capture modalities.** Consider RGB photogrammetry, monocular depth estimation, AR plane detection, dedicated depth sensing, and hybrid workflows. For each, assess completeness, scale reliability, robustness, capture time, compute cost, and user burden.
4. **Map failure conditions.** Test or explicitly flag poor lighting, low texture, reflective or transparent surfaces, repetitive patterns, narrow rooms, clutter, moving people or pets, dark corners, occluded walls, mirrors, and tracking loss.
5. **Assess workflow recoverability.** Define what the user sees when capture quality is poor, how recapture works, and which missing dimensions can be requested manually without collapsing task completion.
6. **Review privacy.** Identify raw imagery, video, depth maps, AR anchors, meshes, room labels, and derived dimensions. Specify minimum collection, consent language, on-device versus cloud processing, access controls, retention, and deletion.
7. **Return a recommendation.** Name the recommended baseline, enhancement path, excluded claims, key unknowns, and validation test.

## Output Format

| Area | Finding | Confidence | Product implication |
|---|---|---:|---|
| Device baseline | | High/Medium/Low | |
| Capture modality | | High/Medium/Low | |
| Reconstruction limits | | High/Medium/Low | |
| Capture UX | | High/Medium/Low | |
| Privacy | | High/Medium/Low | |

Then provide:

- **Recommended workflow**
- **Unsupported or qualified claims**
- **Top failure modes and mitigations**
- **Minimum validation experiment**

## Guardrails

- Do not equate visual plausibility with metric accuracy.
- Do not assume platform capabilities are identical across iOS and Android.
- Do not claim coverage of a device class without checking its sensor and API constraints.
- Treat privacy as a product constraint, not post-launch compliance work.
