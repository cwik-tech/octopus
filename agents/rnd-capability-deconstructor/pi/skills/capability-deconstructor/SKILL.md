---
name: capability-deconstructor
description: Reduce a technology, product, or method to its irreducible capabilities and restate them as domain-agnostic functional statements that describe what it does independent of how it does it. Use at the start of the R&D research pipeline, when a technology looks domain-locked but may port elsewhere, or when comparing technologies that perform the same function under different names.
---

# Capability Deconstructor

A systematic protocol for stripping technologies, products, and methods down to their irreducible capabilities, then abstracting those capabilities into domain-agnostic functional statements. This skill transforms specific implementations into portable abstractions that reveal what a technology *does* independent of how it does it or what domain it operates within.

## When to Use

- At the start of a research pipeline, to create a foundation of abstracted capabilities that can be mapped across domains
- When a technology appears domain-specific but may have applications elsewhere — deconstruction reveals the portable core
- When comparing technologies that seem unrelated but may perform similar functions under different names
- When a proposed solution feels limited to one context — abstraction reveals where else those capabilities could be deployed
- When building the initial briefing document for the Application Domain Scanner (Stage 2 of the Research Pipeline)

## Core Protocol: Five Steps

### Step 1 — Technology Breakdown

Identify all the concrete functions the technology performs. Strip away marketing language, domain jargon, and implementation details. List what the technology *does*, not how it does it.

**Breakdown questions:**

1. What *inputs* does the technology accept? (Materials, information, energy, signals)
2. What *transformation* does it perform on those inputs?
3. What *outputs* does it produce?
4. What *constraints* operate on the transformation? (Speed, precision, scale, cost, accessibility)
5. What *side effects* or secondary functions emerge from the core operation?

**Output:** A list of 5–10 concrete functions in the technology's native domain language. Each function is a one-sentence statement of what the technology does.

**Example:**
- Technology: Magnetic Resonance Imaging (MRI) scanner
- Concrete functions:
  1. Aligns hydrogen nuclei in biological tissue to a strong magnetic field
  2. Applies radiofrequency pulses to excite those nuclei
  3. Measures the electromagnetic signal emitted as nuclei return to baseline
  4. Constructs a 3D spatial map from signal measurements
  5. Differentiates tissue types by relaxation time properties
  6. Produces high-contrast images of soft tissue without ionizing radiation

### Step 2 — Primitive Capability Extraction

From the concrete functions, extract the *primitive capabilities* — the irreducible, domain-independent operations that the technology performs. Each primitive capability should be expressible without reference to the technology's native domain.

**Extraction rules:**

- Identify 5–10 primitive capabilities per technology.
- Each capability must be expressible in terms of functional outcomes, not implementation.
- Eliminate capabilities that are secondary to the core function.
- Flag capabilities that require domain knowledge to understand; those need abstraction in Step 3.

**Output:** A list of primitive capabilities, each stated as "[Verb] [entity/property]" without domain terms.

**Example (from MRI):**
1. Align particles in a field
2. Excite particles with targeted energy
3. Measure emission from excited particles
4. Construct spatial maps from point measurements
5. Differentiate materials by response properties
6. Produce images without destructive interaction

### Step 3 — Abstraction Ladder Construction

For each primitive capability, build a three-level abstraction ladder: concrete → functional → abstract.

**Ladder rules:**

- **Level 1 (Concrete):** The capability in the technology's native domain. Includes domain terminology. Example: "Measure relaxation time properties of hydrogen nuclei in tissue."
- **Level 2 (Functional):** The capability stated as a domain-agnostic function. Removes domain nouns but keeps the operation structure. Example: "Measure relaxation time of particles in a medium."
- **Level 3 (Abstract):** The capability as a pure operation on properties, independent of physical substrate. Example: "Measure response differential of entities under perturbation."

**Output:** For each primitive capability, a three-level ladder with one sentence per level.

### Step 4 — Affordance Mapping

For each abstracted capability, map the affordances — what is possible, and at what cost. This reveals where the capability might transfer.

**Affordance dimensions:**

- **Possibility:** What can be done? What is excluded?
- **Cost:** What resources or time does it require? (In abstract terms: energy, signal loss, delay, material consumption)
- **Speed:** How fast can the operation execute?
- **Scale:** How large or small can it operate?
- **Precision:** How finely can it discriminate?
- **Accessibility:** What prerequisites or specialized knowledge does it require?

**Output:** For each abstracted capability, a five-dimensional affordance profile.

**Example (from MRI capability: "Measure response differential"):**
- **Possibility:** Can measure differences in response under perturbation; cannot measure absolute properties without baseline
- **Cost:** Requires generation of perturbation; generates noise during measurement
- **Speed:** Measurement delay equals response time of the entity (~seconds to hours depending on entity)
- **Scale:** Effective range depends on perturbation strength and entity response sensitivity
- **Precision:** Limited by signal-to-noise ratio and measurement apparatus precision
- **Accessibility:** Requires understanding of what perturbation to apply; requires calibration for each entity type

### Step 5 — Domain Anchoring Test and Capability Profile

Run the domain anchoring test: Can a marine biologist (someone with deep expertise in an unrelated domain) understand this capability without additional domain education? If not, return to Step 3 and raise the abstraction level.

Assemble the capability profile: a structured document containing the technology's primitive capabilities, abstraction ladders, affordance maps, and cross-domain application notes.

**Test criteria:**

- The marine biologist should understand what the capability *does* (the functional outcome).
- The marine biologist should not need to understand implementation details or domain-specific constraints.
- If the capability passes the test, flag promising application domains based on the affordance profile.

**Output:** A complete capability profile document (see `templates/capability-profile.md`) containing all five steps organized for transfer to Stage 2 (Application Domain Scanner).

## Output Format

After running the protocol, deliver the capability analysis in this format:

```
## Capability Analysis

### Technology Overview
[2–3 sentences describing the technology, its primary domain, and its value proposition.]

### Concrete Functions
[List of 5–10 concrete functions the technology performs in its native domain.]

### Primitive Capabilities

#### Capability 1: [Name]
- **Level 1 (Concrete):** [One sentence in domain language]
- **Level 2 (Functional):** [One sentence in domain-agnostic language]
- **Level 3 (Abstract):** [One sentence as pure operation on properties]

**Affordances:**
- **Possibility:** [What can be done; what is excluded]
- **Cost:** [Resources, time, or signal requirements in abstract terms]
- **Speed:** [Execution speed or response time]
- **Scale:** [Effective range or magnitude]
- **Precision:** [Discrimination capability]
- **Accessibility:** [Prerequisites and specialist knowledge required]

#### Capability 2: ...

### Domain Anchoring Assessment
[Pass/Fail for each capability. If any capability fails, note where the abstraction remains domain-specific.]

### Cross-Domain Application Notes
[For each capability that passes the domain anchoring test, list 2–3 domains where that capability could potentially be deployed.]

### Structural Recommendation
[1–2 sentences: What does the deconstruction reveal about where this technology's capabilities could be applied that is not obvious from its original domain?]
```

## Key Principles

1. **Implementation-independence is the goal.** A capability expressed in domain language is not yet a capability — it is a domain application. Push abstraction until the marine biologist test passes.

2. **Primitive capabilities are not building blocks.** Don't try to combine them into larger functions. The goal is to identify the irreducible operations the technology performs, not to engineer new functions from components.

3. **Affordances reveal transfer barriers.** When a capability fails to transfer to a new domain, the failure is usually rooted in an affordance constraint — the cost is unacceptable, the scale is wrong, or accessibility requirements don't exist in the target domain. Mapping affordances *before* attempting transfer saves time.

4. **Five capabilities is the minimum.** If you have fewer, either the technology is simpler than it appears (legitimate, move forward) or you have not fully deconstructed it (go back to Step 1).

5. **The domain anchoring test is non-negotiable.** Do not advance a capability to the profile if it fails this test. Capabilities that require domain knowledge are not yet abstracted enough to serve Stage 2.

6. **Secondary functions matter.** If the technology produces side effects (e.g., heat generation, electromagnetic noise, material waste), extract them as capabilities. Secondary functions often reveal unexpected application domains.

7. **Multi-capability convergence signals opportunity.** If three unrelated technologies produce the same primitive capability (expressed in different domain language), that capability is robust across contexts and likely to transfer successfully.
