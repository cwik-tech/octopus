---
name: woodworking-cad-manufacturing
description: Convert furniture concepts into constrained parametric woodworking geometry, manufacturable specifications, cut lists, hardware schedules, and dimensioned 2D drawing requirements. Use when creating or reviewing shop-ready furniture plans, CAD outputs, material assumptions, joinery-aware dimensions, or fabrication packages.
---

# Woodworking CAD Manufacturing

## Purpose

Turn a furniture concept into a coherent manufacturing definition that can support parametric CAD, reliable drawings, cut lists, and shop execution.

## Operating Protocol

### 1. Establish the production basis

Declare before dimensioning:

- Units and datum convention
- Intended use, load case, and target user
- Shop type: hobby, professional custom shop, or repeatable small batch
- Available fabrication processes and tool constraints
- Material type, species or panel product, nominal versus actual thickness, and stock availability
- Hardware manufacturer or equivalent specification, including required clearances and hole patterns
- Finish system where it changes clearances or dimensions

If an input is absent, label it as an assumption. Do not convert uncertainty into exact dimensions.

### 2. Build a parameter hierarchy

Use three levels:

| Level | Examples | Rule |
|---|---|---|
| Global | Overall width, height, depth, mattress size, room clearance, material thickness | Changeable by user or room capture |
| Assembly | Cabinet opening, rail length, drawer-box size, leg spacing | Derived from global parameters |
| Part | Tenon length, panel size, shelf length, bore location | Derived from assembly parameters |

For every critical parameter, document the dependency. Example: `shelf length = interior width - 2 × shelf clearance`.

### 3. Define component geometry

Assign every part:

- Unique ID and plain-language name
- Quantity
- Finished dimensions: length × width × thickness
- Rough dimensions, including machining and trim allowance
- Material and grain direction
- Edge treatment and visible faces
- Machining features: dados, rabbets, mortises, drilling, grooves, or profiles
- Mating components and joint type

Dimension assemblies from functional datums, not arbitrary outer edges. Maintain closed dimensional chains: calculated overall dimensions must equal the sum of all parts, gaps, and joinery offsets.

### 4. Apply woodworking manufacturing rules

- Allow solid wood to move across the grain; do not trap wide solid-wood panels in rigid cross-grain assemblies.
- Identify grain direction on all structural and visible solid-wood parts.
- Distinguish nominal stock thickness from finished thickness.
- Preserve tool access, clamping access, and assembly access for every joint.
- Make hardware interfaces follow the hardware specification rather than generic assumed offsets.
- Use explicit reveal, overlay, and clearance dimensions for doors, drawers, and moving parts.
- Treat finish buildup as a clearance input where parts slide, nest, or close.
- Specify tolerances only where function requires them. Provide adjustment paths for field-variable relationships.
- Include machining allowances in rough stock, but do not include them in finished dimensions.

### 5. Generate the fabrication package

A complete package contains:

1. **Assembly drawing:** overall dimensions, key clearances, section views, and labeled components.
2. **Part drawings:** finished dimensions, feature locations, joint geometry, edge treatment, and grain orientation.
3. **Cut list:** part ID, quantity, finished size, rough size, material, grain, and notes.
4. **Bill of materials:** lumber or sheet goods, hardware, fasteners, adhesives, and finish-sensitive items.
5. **Hardware schedule:** manufacturer or specification, quantity, mounting pattern, and required clearances.
6. **Operation plan:** machining order, reference faces, dry-fit checkpoint, glue-up order, and inspection checks.

### 6. Reconcile before reporting

Perform these checks:

- Every drawing label appears exactly once in the cut list.
- Every cut-list part has a location in an assembly or part drawing.
- Overall dimensions reconcile to component dimensions and gaps.
- Hardware count and mounting locations reconcile to assemblies.
- Material quantities include practical yield, grain matching, defects, and machining allowance where applicable.
- All moving parts have stated clearance and adjustment requirements.
- All unknown dimensions are marked as assumptions or validation items.

## Output Template

```markdown
## Manufacturing Assumptions

| Item | Decision | Status |
|---|---|---|
| Units | mm or inches | Declared |
| Material | species or panel product; finished thickness | Declared / Assumed |
| Shop capability | key tools and process limits | Declared / Assumed |
| Hardware | item and mounting constraints | Declared / Pending |

## Parametric Geometry

| Parameter | Value or Formula | Controls | Constraint |
|---|---|---|---|

## Component and Cut List

| ID | Part | Qty | Finished L × W × T | Rough Size | Material | Grain | Notes |
|---|---:|---:|---|---|---|---|---|

## Hardware Schedule

| Item | Qty | Mounting Requirement | Clearance / Adjustment |
|---|---:|---|---|

## Drawing Set

- Assembly elevation, plan, and section: [required dimensions]
- Exploded assembly: [part labels and joinery]
- Part details: [critical machining and bore locations]

## Buildability Review

**Status:** Buildable | Buildable with revisions | Not yet buildable

- **Verified:** ...
- **Assumptions:** ...
- **Blockers:** ...
- **Next validation:** ...
```

## Failure Modes to Flag

- Render-derived geometry that lacks a material or construction model
- Dimensions that do not reconcile across views or with the cut list
- Cross-grain restraint, unsupported spans, or inaccessible joinery
- Hardware selected after geometry is fixed
- Missing rough-stock allowance, grain direction, or part identification
- Drawer, door, or nesting clearances omitted or left to interpretation
- Apparent precision unsupported by capture accuracy or shop process capability
