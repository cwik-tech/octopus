# FAST and TRIZ: Technical References for Capability Deconstruction

This document provides detailed technical guidance on two complementary methodologies—FAST (Functional Analysis System Technique) and TRIZ (Theory of Inventive Problem Solving)—that underpin the Capability Deconstructor protocol.

## Part 1: FAST (Functional Analysis System Technique)

FAST is a structured methodology for analyzing systems by decomposing them into their functional components. It is particularly valuable for the first two steps of the Capability Deconstructor protocol: Technology Breakdown and Primitive Capability Extraction.

### Core Principles of FAST

FAST operates on the principle that any technology, product, or process can be understood as a hierarchy of functions, each of which transforms inputs into outputs. The methodology strips away implementation details and domain language to reveal the underlying functional architecture.

**Key insight:** A function is not what something *is*; it is what something *does*. A knife's function is not "a blade of steel"; it is "cut material." This distinction is the entire point of FAST.

### The How/Why Logic Framework

FAST uses a two-directional questioning technique called how/why logic to map function hierarchies:

- **Why questions** move upward in abstraction: "Why does the technology do X?" The answer points to a higher-order function that X serves.
- **How questions** move downward into implementation: "How does the technology accomplish X?" The answer points to lower-level functions or mechanisms that enable X.

#### Example: The MRI Scanner

```
Why does it excite nuclei?
  ↑
  To measure relaxation properties
    ↑ Why?
    To create a map of tissue composition
      ↑ Why?
      To produce high-contrast soft-tissue images
        ↑ Why?
        To enable diagnosis without ionizing radiation

How does it excite nuclei?
  ↓
  By applying radiofrequency pulses at the Larmor frequency
    ↓ How?
    By generating an oscillating electromagnetic field
      ↓ How?
      By running alternating current through a coil
```

The upward chain reveals why each function is performed (its purpose within the technology's goal). The downward chain reveals how each function is implemented (what lower-level mechanisms enable it).

### Function Hierarchy Levels

FAST defines a standard five-level function hierarchy:

1. **Primary function:** The core value the technology delivers. For MRI: "Produce diagnostic images."
2. **Secondary functions:** Supporting functions that enable the primary function. For MRI: "Excite nuclei," "Measure emissions," "Construct spatial maps."
3. **Tertiary functions:** Mechanisms that enable secondary functions. For MRI: "Apply radiofrequency pulses," "Amplify weak signals," "Perform spatial localization."
4. **Enabling functions:** Functions that make the system operational but don't directly contribute to the primary function. For MRI: "Maintain magnetic field stability," "Cool superconducting coils," "Control patient positioning."
5. **Aesthetic or contextual functions:** Functions related to user experience, safety, or regulatory compliance. For MRI: "Display images to operator," "Ensure patient safety," "Log operation records."

### Verb Selection in FAST

FAST uses a controlled vocabulary of function verbs. These verbs describe transformations without reference to domain:

**Transformation verbs:** Convert, change, reduce, increase, mix, separate, move, absorb, emit, transmit, receive, store, release, open, close, join, divide, guide, support, protect, contain, position, control, regulate, sense, measure.

**Constraint verbs:** Limit, prevent, restrict, enable, allow, facilitate.

**Meta verbs:** Combine, integrate, synchronize, sequence.

The rule: A function statement must use a verb from this set, never domain-specific verbs like "diagnose" or "scan."

**Example corrections:**
- Bad: "Scan tissue with radio waves." (Uses domain verb "scan"; is not truly a primitive function.)
- Better: "Measure electromagnetic response to perturbation." (Uses transformation verb; is domain-agnostic.)

### Building a Function Breakdown Structure

A FAST function breakdown is typically represented as a visual tree (though it can be documented textually). The structure flows horizontally from left to right, with:

- **Leftmost column:** Primary function (single box)
- **Middle columns:** Secondary, tertiary, enabling, and aesthetic functions, arranged by dependency
- **Relationships:** Drawn as arrows showing how/why dependencies

The structure is read left-to-right (why chain: moving toward abstraction) and right-to-left (how chain: moving toward implementation).

#### Constraints in FAST

FAST also identifies constraints—limitations that operate on the functions:

- **Physical constraints:** Laws of physics, material properties (e.g., MRI requires a strong magnetic field; the field strength is a constraint on precision)
- **Economic constraints:** Cost per unit, production speed, scalability (e.g., MRI requires expensive superconducting coils; cost is a constraint on accessibility)
- **Temporal constraints:** Time required to perform the function (e.g., nuclear relaxation time determines how fast MRI can measure; response time is a constraint on speed)
- **Information constraints:** Knowledge or signal quality required (e.g., MRI requires knowledge of the Larmor frequency for the nuclei being imaged; domain knowledge is a constraint on accessibility)

Constraints are not failures of the technology; they are inherent limits on the technology's affordances. FAST captures them explicitly so they can be carried forward during capability abstraction.

### Applying FAST to Step 1: Technology Breakdown

When using FAST for Step 1 of the Capability Deconstructor protocol:

1. **Start with the primary function.** Why does this technology exist? What does it do at the highest level?
2. **Decompose into secondary functions.** What sub-functions must occur for the primary function to be achieved?
3. **Identify constraints at each level.** For each function, what limitations apply? What does the technology *not* do?
4. **Extract the affordance profile for each function.** How fast? At what cost? At what scale? With what precision?

The output is a function hierarchy that serves as the input to Step 2 (Primitive Capability Extraction).

---

## Part 2: TRIZ (Theory of Inventive Problem Solving)

TRIZ is a systematic methodology for solving technical problems by identifying structural contradictions and applying inventive principles that have proven effective across multiple domains. It is particularly valuable for Steps 2 and 3 of the Capability Deconstructor protocol: Primitive Capability Extraction and Abstraction Ladder Construction.

TRIZ was developed by Genrich Altshuller, a Soviet engineer who analyzed thousands of patents to identify recurring patterns in how inventive problems are solved. The core insight: many different technical problems share the same underlying structure, and solutions that work in one domain often transfer to another.

### Core Principles of TRIZ

1. **Engineering problems are not unique.** Most "new" technical problems are instances of a recurring structural pattern. If you can identify the pattern, you can apply known solutions.
2. **Contradictions drive innovation.** Every inventive solution involves solving a contradiction—improving one property without degrading another, or achieving a benefit without an unacceptable cost.
3. **Principles are domain-agnostic.** Solutions that work in one industry (e.g., chemistry) often apply in another (e.g., software) because the underlying principle is the same.
4. **Systems evolve through predictable stages.** Technologies don't improve randomly; they follow an S-curve of increasing performance until they hit an inherent limit, then a new technology displaces them.

### The Contradiction Matrix

TRIZ's most famous tool is the Contradiction Matrix—a 39 x 39 table that maps contradictions between technical parameters to suggested inventive principles.

A technical contradiction occurs when improving one parameter (speed, precision, cost, etc.) seems to degrade another:

- "I want faster processing (speed) but need lower power consumption (energy)."
- "I want higher precision but need lower cost."
- "I want greater durability but need lighter weight."

The Contradiction Matrix identifies which of 40 inventive principles are most likely to resolve each specific contradiction.

#### Example: MRI Precision vs. Speed

**Contradiction:** MRI achieves high precision in tissue differentiation (secondary function: "Measure response differential") but requires long measurement times for nuclei to return to baseline (tertiary function: "Wait for relaxation").

**Parameters in conflict:**
- Parameter to improve: Speed (how fast can measurement complete?)
- Parameter that degrades: Measurement reliability/precision (faster measurement means fewer signal averages, lower signal-to-noise ratio)

**TRIZ Contradiction Matrix lookup:** Improving speed (parameter 9) while maintaining reliability (parameter 30) suggests principles: 35 (Parameter change), 2 (Taking out), 6 (Universality), 13 (The Other Way Round).

**What these principles suggest:**
- **Parameter change:** Change the measurement method (e.g., use different nuclear spins with faster relaxation times)
- **Taking out:** Remove the constraint that forces long wait times (e.g., use faster pulse sequences)
- **Universality:** Add a function (measure multiple nuclei simultaneously)
- **The Other Way Round:** Reverse the measurement direction (measure excitation rather than relaxation)

These suggestions are not specific to MRI; they are patterns that work across domains because they address the structural contradiction between speed and precision.

### The 40 Inventive Principles

TRIZ identifies 40 principles that have been used repeatedly to solve technical contradictions:

1. **Segmentation:** Divide into parts; make separable; increase degree of segmentation.
2. **Taking out:** Remove the problematic component; extract the problematic property.
3. **Local quality:** Change the object's property or state to be non-uniform; make properties different in different locations.
4. **Asymmetry:** Break symmetry; make the system asymmetrical.
5. **Merging:** Combine in time or space; bring closer together; merge into one.
6. **Universality:** Make a system multi-functional; design to perform multiple roles.
7. **Nesting:** Place one object inside another; make concentric or nested.
8. **Counterweight:** Compensate for weight or tendency with another force.
9. **Preliminary action:** Pre-arrange objects so they can act with minimal delay.
10. **Preliminary counter-action:** Create counter-stress or counter-tension in advance.
11. **Beforehand cushioning:** Prepare emergency solutions; pre-arrange protective measures.
12. **Equipotentiality:** Equalize potential; neutralize harmful effects.
13. **The Other Way Round:** Reverse the action; do the opposite.
14. **Spheroidality:** Use curved forms; increase use of spheres; transition from linear to curved.
15. **Dynamism:** Make rigid objects flexible or adaptive; allow motion or vibration.
16. **Partial or excessive action:** If it is difficult to achieve 100% of a required effect, achieve significantly more or significantly less.
17. **Transition to a new dimension:** Move to a higher dimension; add a dimension.
18. **Use of mechanical vibration:** Introduce oscillation or vibration; increase its frequency; use ultrasonic frequencies.
19. **Periodic action:** Replace continuous action with periodic action; use pulses.
20. **Continuity of useful action:** Make an action continuous with no idle time; eliminate idle time.
21. **Rushing through:** Move quickly through a danger zone; perform the harmful action at high speed.
22. **Convert harm into benefit:** Turn harmful factors into useful ones; eliminate the primary harmful effect by amplifying it.
23. **Feedback:** Introduce feedback; reinforce useful feedback; reduce or eliminate harmful feedback.
24. **Intermediate:** Introduce an intermediary; use an intermediate substance or carrier.
25. **Self-service:** Make an object self-service by using its own waste or discarded energy; make it self-adjusting.
26. **Copying:** Replace an expensive or fragile object with a simpler, cheaper copy; use mechanical copies instead of optical.
27. **Cheap, short-lived objects:** Replace an expensive, durable object with many cheap, short-lived ones; optimize for lifecycle cost.
28. **Replacement of mechanical systems:** Replace mechanical devices with electrical, magnetic, or field-based solutions; transition to smart materials.
29. **Pneumatics and hydraulics:** Use gas or liquid instead of solid parts; use flexible shells or thin membranes.
30. **Flexible shells and membranes:** Use flexible shells or thin films; transition from rigid to flexible geometry.
31. **Porous materials:** Make an object porous or add porous elements; use capillarity.
32. **Color changes:** Change the color or opacity of an object; use color to convey information.
33. **Homogeneity:** Make objects of the same material; use materials with compatible properties.
34. **Discarding and recovering:** Make an object or its part discard and recover; discard after use; recover discarded material.
35. **Parameter changes:** Change an object's physical state, concentration, density, elasticity, or temperature; transition between states.
36. **Phase transition:** Use phase transitions (solid ↔ liquid ↔ gas) to solve the problem.
37. **Thermal expansion:** Use thermal expansion or contraction; exploit temperature sensitivity.
38. **Strong oxidizers:** Replace normal air with oxygen-enriched air; use ozone; use free radicals.
39. **Inert atmospheres:** Use inert or noble gases; change from normal atmosphere.
40. **Composite materials:** Move from homogeneous to composite materials; use multi-material structures.

### Substance-Field Analysis (Su-Field)

Su-Field analysis is TRIZ's method for modeling systems in their most abstract form: as interactions between substances and fields.

A substance-field model reduces any system to three elements:

- **Substance 1 (S1):** The primary object being transformed
- **Substance 2 (S2):** The secondary object or tool interacting with S1
- **Field (F):** The mediating force or energy enabling the interaction

Visually:

```
S1 ← F → S2
```

#### Example: MRI as a Su-Field Model

- **S1:** Hydrogen nuclei (the substance being analyzed)
- **S2:** Radiofrequency waves (the measurement tool)
- **F:** Magnetic field (the mediating force that aligns nuclei and enables RF interaction)

Interactions:

```
Nuclei ← Magnetic Field → RF Waves
```

Su-Field analysis identifies eight standard interaction types and proposes solutions for each:

1. **Complete interaction:** S1 and S2 are both present, and the field is effective. Problem: unwanted effects. Solution: Add a third substance to neutralize them.
2. **No interaction:** S1 and S2 are present, but the field is ineffective. Solution: Change the field type; introduce an intermediate field.
3. **Incomplete interaction:** S1 and S2 are present, but the field is too weak. Solution: Amplify the field; change the field type.
4. **One substance missing:** Only one substance is present; the second is needed but absent. Solution: Introduce the missing substance; use the existing substance in a different form.
5. **One field missing:** S1 and S2 are present, but no field exists to mediate. Solution: Introduce the appropriate field; use one substance as the field source.
6. **Harmful field present:** An unwanted field is interfering. Solution: Introduce a counter-field; shield from the harmful field.
7. **Complex interaction:** Multiple substances or fields interact in non-linear ways. Solution: Separate; sequence; modulate fields.
8. **Unstable interaction:** The interaction is volatile or unpredictable. Solution: Add a stabilizing substance or field; introduce feedback control.

### Applying TRIZ to Step 2: Primitive Capability Extraction

When using TRIZ for Step 2 of the Capability Deconstructor protocol:

1. **Model the technology as a Su-Field.** What are the primary substance, secondary substance, and field? What interaction type is occurring?
2. **Identify the technical contradictions.** What properties are in tension? What improvements come at what costs?
3. **Apply the Contradiction Matrix.** For each contradiction, identify relevant inventive principles.
4. **Extract primitive capabilities from the principles.** Each principle suggests a capability that the technology exploits. For MRI: "Apply targeted energy to alter system state" (Principle 18: Periodic action), "Measure differential response" (Principle 23: Feedback).

The output is a set of primitive capabilities framed in terms of the inventive principles that enable them. This framing makes the capabilities more portable—they are no longer described in terms of "nuclei" and "RF waves" but in terms of abstract mechanisms like "periodic perturbation," "signal detection," and "response differentiation."

### Applying TRIZ to Step 3: Abstraction Ladder Construction

TRIZ supports abstraction by providing a vocabulary of domain-agnostic principles and mechanisms. When building the abstraction ladder:

- **Level 1 (Concrete):** Use FAST terminology and domain language
- **Level 2 (Functional):** Translate to TRIZ principle language (e.g., "Apply periodic RF pulses" becomes "Apply periodic perturbation")
- **Level 3 (Abstract):** Reduce to pure operation language (e.g., "Induce periodic perturbation and measure response differential")

---

## Integration: FAST and TRIZ Together

FAST provides the functional decomposition; TRIZ provides the principle-based abstraction. Together, they form a complete toolkit for Capability Deconstruction:

1. **FAST Step 1:** Build a function hierarchy using how/why logic. Identify constraints.
2. **TRIZ Step 1:** Model the system as a Su-Field. Identify contradictions.
3. **FAST Step 2:** Extract secondary and tertiary functions. Use FAST verb vocabulary.
4. **TRIZ Step 2:** Apply the Contradiction Matrix. Identify inventive principles. Reframe functions in terms of principles.
5. **TRIZ Step 3:** Use principle language as a bridge to abstraction. Each principle suggests a domain-agnostic formulation.
6. **Capability Deconstructor:** Assemble primitive capabilities, build abstraction ladders, and perform domain anchoring test.

The result is a set of capabilities that are maximally portable because they are grounded in both functional architecture (FAST) and cross-domain inventive principles (TRIZ).
