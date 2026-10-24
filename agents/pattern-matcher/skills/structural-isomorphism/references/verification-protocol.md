# Isomorphism Verification Protocol

A systematic process for determining whether a proposed cross-domain match is a genuine structural isomorphism, a useful analogy, or a superficial metaphor.

---

## The Three-Level Hierarchy

| Level | What it checks | Verdict if only this level holds |
|-------|---------------|----------------------------------|
| Level 1: Entity Mapping | Do the key players/components correspond? | **Metaphor** — surface similarity only |
| Level 2: Relationship Mapping | Do the connections and interactions correspond? | **Analogy** — structural similarity without dynamic equivalence |
| Level 3: Dynamics Mapping | Do the systems evolve, respond, and fail in the same ways? | **Isomorphism** — full structural equivalence |

All three levels must hold for a match to be called an isomorphism. The distinction matters because only isomorphisms reliably transfer solutions.

---

## Level 1: Entity Mapping

**Question:** Do the key entities in the source domain have clear functional equivalents in the target domain?

**Protocol:**

1. List the 4–6 most important entities in the source domain's problem.
2. For each, identify the proposed equivalent in the target domain.
3. Check functional equivalence — do the entities play the same *role* in their respective systems?

**Evaluation criteria:**

| Rating | Description |
|--------|-------------|
| **Strong** | Every key entity has a clear, non-forced equivalent. The mapping feels natural once stated. |
| **Moderate** | Most entities map, but 1–2 require awkward stretching or have no clear equivalent. |
| **Weak** | Only 2–3 entities map. Others are forced or absent. |

**Red flags:** Ambiguous mapping (one-to-many), incomplete mapping (missing entity), forced mapping (only works if you squint).

**Example — Strong entity mapping:**

| Source (Cardiovascular) | Target (Supply Chain) | Role |
|------------------------|-----------------------|------|
| Heart | Central distribution hub | Pump / origin of flow |
| Arteries | Primary transportation routes | High-capacity flow channels |
| Capillaries | Last-mile delivery networks | Low-capacity, high-reach distribution |
| Blood | Goods/inventory | The thing that flows |
| Blockage (plaque) | Bottleneck (capacity constraint) | Impedance to flow |

**Example — Weak entity mapping:**

| Source (Immune System) | Target (Customer Support) | Role |
|-----------------------|--------------------------|------|
| Pathogen | Customer complaint | Trigger |
| T-cell | Support agent | Responder |
| Antibody | ??? | Memory / fast response to known threats |
| Inflammation | ??? | Costly but necessary protective response |

Breaks down because the immune system's most interesting mechanisms (adaptive memory, self/non-self distinction) have no equivalents.

---

## Level 2: Relationship Mapping

**Question:** Do the relationships between entities in the source domain have equivalents in the target domain?

**Protocol:**

1. Map the key relationships in the source domain (who affects whom, how, in what direction).
2. Check whether the same relationship topology exists in the target domain.
3. Pay special attention to: directionality (one-way vs. two-way), multiplicity (one-to-one vs. one-to-many), and coupling strength (tight vs. loose).

**Evaluation criteria:**

| Rating | Description |
|--------|-------------|
| **Strong** | The relationship topology is identical. Same direction, similar coupling. |
| **Moderate** | Most relationships map, but some important interaction pathways don't exist in the target. |
| **Weak** | Entities might map, but they're connected differently. The network structure is different. |

**What to check:** Topology (hub-spoke vs. mesh vs. chain vs. tree), directionality, coupling strength (tight vs. loose), hierarchy, dependencies.

**Red flags:** Critical feedback loop absent in target, fundamentally different topology, tight vs. loose coupling mismatch.

---

## Level 3: Dynamics Mapping

**Question:** Do the two systems *behave* the same way over time?

This is the hardest level and where most promising matches fail. It's also the most important — solutions transfer only when the dynamics match.

**Protocol:**

1. Identify the 3–4 most important dynamic behaviors in the source domain:
   - How does the system respond to increased load/pressure?
   - What happens when a component fails?
   - Does the system have equilibrium states? How many? Are they stable?
   - What feedback loops drive behavior?
   - What triggers phase transitions or qualitative changes?

2. Check whether each dynamic behavior has an equivalent in the target domain.

3. Pay special attention to **timescales** — the same dynamics on different timescales may produce qualitatively different behavior.

**Evaluation criteria:**

| Rating | Description |
|--------|-------------|
| **Strong** | Same responses to perturbations. Same feedback loops. Failure modes structurally identical. Equilibria map. |
| **Moderate** | Qualitative behavior similar but quantitative dynamics differ significantly. Same patterns at different timescales or sensitivities. |
| **Weak** | Systems respond fundamentally differently to key perturbations. Different feedback loops dominate. |

**Red flags:** Positive vs. negative feedback swap, timescales differ by orders of magnitude, source has phase transition but target degrades gradually (or vice versa).

---

## Verdict Matrix

| Level 1 | Level 2 | Level 3 | Verdict | Solution transfer confidence |
|---------|---------|---------|---------|------------------------------|
| Strong | Strong | Strong | **Isomorphism** | High |
| Strong | Strong | Moderate | **Strong analogy** | Moderate |
| Strong | Strong | Weak | **Analogy** | Low |
| Strong | Moderate/Weak | Any | **Surface analogy** | Very low |
| Moderate/Weak | Any | Any | **Metaphor** | None for solution transfer |

---

## Documenting a Verification

```
### [Source Domain] → [Target Domain]

**Entity mapping:** [Strong/Moderate/Weak]
| Source entity | Target entity | Role | Mapping quality |
|...|...|...|...|

**Relationship mapping:** [Strong/Moderate/Weak]
- Key relationships that map: [list]
- Key relationships that don't map: [list]
- Topology match: [same/different, with explanation]

**Dynamics mapping:** [Strong/Moderate/Weak]
- Matching dynamics: [list]
- Non-matching dynamics: [list]
- Critical difference: [the most important dynamic gap]

**Verdict:** [Isomorphism / Strong analogy / Analogy / Surface analogy / Metaphor]
**Solution transfer confidence:** [High / Moderate / Low / None]
**Where the match breaks:** [specific point of failure, even for strong matches]
```

---

## Common Traps

1. **The elegance trap.** A match that sounds beautiful isn't necessarily structural. "Organizations are like living organisms" fails at Level 2 and Level 3.

2. **The vocabulary trap.** Same words in different domains don't make entities equivalent. "Network" in computer science and "network" in social science have fundamentally different dynamics.

3. **The cherry-picking trap.** Focusing on the 3 dynamics that match while ignoring the 5 that don't. Always report *where the match breaks*.

4. **The timescale trap.** A dynamics match at one timescale may fail at another. Evolution and market competition have structural similarities at the generational timescale, but evolution has no equivalent to a quarterly earnings call.

5. **The one-directional trap.** The mapping works source→target but not target→source. True isomorphisms work in both directions.
