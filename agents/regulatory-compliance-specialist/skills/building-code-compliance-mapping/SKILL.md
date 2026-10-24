---
name: building-code-compliance-mapping
description: Maps modular wall designs to applicable building codes (IBC, NFPA, ADA, local amendments) and identifies compliance gaps by risk level. Use when analyzing a new design, assessing design changes, or entering a new target jurisdiction to surface which codes are most restrictive and what design constraints must be satisfied.
---

# Building Code Compliance Mapping

## Purpose

Translate building codes into design constraints. Modular interior walls must satisfy fire-rating, smoke development, flame-spread, load-bearing, seismic, ADA accessibility, and acoustic requirements depending on jurisdiction and building type. Your role is to identify which codes apply, which are most restrictive for this specific design, and where the design is non-compliant.

## Instructions

### How to Use This Skill

When a new modular wall design is presented (or an existing design is significantly modified), run a building-code compliance audit:

1. **Scope the applicable codes:** Determine the building type (museum, office, healthcare, education), the target jurisdiction (e.g., New York City, California), and whether the wall is load-bearing or non-load-bearing. The applicable codes are:
   - **IBC (International Building Code):** The baseline for most US jurisdictions. Check the latest cycle in your target jurisdiction.
   - **Local amendments:** Almost every jurisdiction adds stricter amendments to the IBC. These are often the real gate.
   - **NFPA standards:** NFPA 101 (Life Safety Code) sets fire-rating and egress rules; NFPA 252 and NFPA 286 define fire-testing protocols.
   - **ADA (Americans with Disabilities Act):** Accessibility requirements for door width, ramp slope, signage, and material texture.
   - **Seismic & wind:** California, Washington, and other seismic regions require lateral-load design. Coastal jurisdictions add wind-load rules.
   - **Acoustic standards:** Some jurisdictions (e.g., commercial offices) have sound-transmission-class (STC) minimums between office and open space.
   - **Local fire marshal or AHJ amendments:** Large jurisdictions like NYC or LA often have strict fire-rating and material-use amendments.

2. **Extract design-critical code sections:** Read the IBC, NFPA standards, and local amendments. For each applicable standard, extract the specific section that constrains your design. Example:
   - IBC Section 602 (Interior finish classification): Non-sprinklered buildings require Class A interior finish (flame-spread ≤ 25, smoke development ≤ 450) on walls.
   - NFPA 101 Section 8.3.4 (Egress capacity): Egress door width ≥ 32 inches clear width.
   - ADA Section 303 (Door width): Minimum 32 inches clear width for accessibility.

3. **Map design features to code requirements:** For each design feature (material, joint detail, thickness, anchoring method), identify which code sections it must satisfy. Example:
   - **Aluminum frame:** Must satisfy IBC Section 2211 (Aluminum structures) or be treated as a non-structural partition per Section 602.
   - **Drywall face:** Must be fire-rated and low-smoke; check IBC Section 602 flame-spread index and NFPA 252 fire-endurance rating.
   - **Joint between walls:** Must prevent flame and smoke passage; check NFPA 101 Section 8.3.4 (penetration sealing).
   - **Acoustic damping:** If office building, check local noise ordinance; typically requires STC ≥ 50 between private offices.

4. **Identify compliance gaps:** For each mapped requirement, assess whether the current design meets the code. Flag high-risk, medium-risk, and low-risk gaps.
   - **High-risk gaps** (fatal to market entry without redesign): Fire-rating failure, load-bearing capacity below code minimum, ADA non-compliance, non-seismic in a seismic zone.
   - **Medium-risk gaps** (require design change or test validation): Acoustic performance below specification, smoke-development index above limit, egress-width margin too thin.
   - **Low-risk gaps** (low-cost remediation): Signage typeface, minor accessibility adjustment, material documentation.

5. **Produce compliance gap matrix:** Document which codes apply, which gaps exist, the risk level of each gap, and a preliminary remediation strategy (design change, material substitution, or test validation). Example:

| Code Section | Requirement | Current Design | Status | Risk | Remediation |
|---|---|---|---|---|---|
| IBC 602 (Flame-spread) | Flame-spread index ≤ 25 | Untested drywall | Non-compliant | High | Test face material per ASTM E84 |
| NFPA 252 (Fire rating) | 1-hour fire rating at partition | Aluminum frame + untested assembly | Untested | High | Conduct NFPA 252 test on full assembly |
| ADA 303 (Door width) | 32 inches clear width | Design specifies 34 inches | Compliant | Low | ✓ Meets code |
| IBC 2211 (Aluminum) | Lateral bracing per code | Aluminum studs at 24" o.c. | Untested | Medium | Validate stud spacing per wind/seismic loads |
| NFPA 101 (Egress) | Sealed penetrations | Joint design not finalized | Untested | Medium | Detail joint sealing in final design |

6. **Identify jurisdiction-specific stricter requirements:** If the target jurisdiction has known stricter amendments, flag them. Example:
   - **NYC:** Requires additional fire-rating over IBC minimums in certain building types; no foam insulation in certain applications.
   - **California (seismic):** Requires lateral-bracing design for Seismic Design Category C and above.
   - **LA County (fire marshal):** Requires additional material screening; may restrict synthetic materials in certain assembly types.

7. **Recommend design validation sequence:** Suggest early testing or analysis to resolve high-risk gaps before full-scale prototyping. Example:
   - Conduct ASTM E84 flame-spread test on the face material (low-cost, fast turnaround, informs material choice).
   - Conduct NFPA 252 fire-rating test on a representative 8' × 8' assembly wall (cost $20K–40K, 8–12 week turnaround, critical for market entry).
   - Have a local structural engineer review seismic and wind load calculations (low-cost, provides design confidence for AHJ approval).

## Compliance Gap Decision Tree

```
Is the design compliant with the applicable code?
├─ YES → Mark as compliant, proceed
└─ NO → Is the gap fatal to market entry (fire rating, load bearing, ADA)?
   ├─ YES → Flag as High-risk. Recommend design change or critical-path test before prototype.
   └─ NO → Is the gap a material issue (acoustic, smoke, margin)?
      ├─ YES → Flag as Medium-risk. Recommend design adjustment or validation test.
      └─ NO → Flag as Low-risk. Remediation is low-cost or cosmetic.
```

## Code-Mapping Rules

1. **Always check local amendments.** The IBC is the baseline; local amendments are almost always stricter. Jurisdiction-specific rules trump the IBC.
2. **Fire-rating is usually critical-path.** If the design must be fire-rated (most commercial buildings), NFPA 252 testing is the gate. Plan everything around this test.
3. **Flame-spread index is material-dependent.** The face material (drywall, wood, composite) is the easiest lever to adjust early. Test material samples before committing to assembly design.
4. **Assembly performance differs from material performance.** A drywall product rated Class A when tested alone may fail in a composite assembly. Plan for full-assembly testing, not just component testing.
5. **ADA accessibility is a gate, not a nice-to-have.** If the wall is public-facing or in a commercial building with public use, ADA compliance is non-negotiable. Accessibility constraints (door width, ramp slope, clear floor space) may drive design.
6. **Seismic and wind load design is jurisdiction-specific.** California, Washington, and coastal zones require lateral-load calculations. Do not assume a design passes until calculations are done for the target jurisdiction.
7. **Standards update on regular cycles.** IBC updates every 3 years, NFPA standards annually. Check the edition applicable in your target jurisdiction; do not assume the latest edition is adopted yet.

## Output

For each design review, produce:
- A list of applicable codes by jurisdiction and building type
- A compliance gap matrix (code section, requirement, current design status, risk level, remediation strategy)
- A prioritized list of high-risk gaps that require design change or critical testing
- A recommended validation sequence (which tests to run first, in what order, and why)
- A summary of any jurisdiction-specific stricter requirements that shape design

## Common Traps

1. **Relying on material specs instead of assembly testing.** Drywall is Class A; therefore the wall is fire-rated. Reality: the assembly (frame + material + joints) is what's fire-rated, not the material alone.
2. **Assuming the latest code is in force.** IBC 2021 is the latest, but your jurisdiction may still enforce IBC 2018 or 2015. Check your jurisdiction's adopted code edition.
3. **Ignoring local amendments.** NYC has 100+ amendments to the IBC; California adds seismic requirements. Local rules are the real gate.
4. **Underestimating flame-spread testing timeline.** ASTM E84 is a 4-week turnaround; NFPA 252 is 8–12 weeks. Budget these into your project timeline early.
5. **Treating ADA as optional.** If the building is public or commercial, ADA compliance is required by law. Do not design around it; design with it from the start.
