# Pattern Taxonomy

A catalog of fundamental problem structures that recur across domains. Each entry defines the pattern's abstract structure, key variables, dynamics, known failure modes, canonical solution classes, and example domains.

---

## 1. Flow Problems

**Structure:** Something moves through a system and encounters impedance — getting stuck, slowed, misdirected, or lost.

**Key variables:** Throughput, capacity, bottleneck location, pressure differential, queue depth.

**Dynamics:** Bottlenecks propagate upstream (queues form), cascading failures occur when one bottleneck overloads adjacent nodes, and total throughput is determined by the weakest link (Goldratt's Theory of Constraints (TOC)).

**Known failure modes:** Single point of failure, cascading congestion, downstream starvation, thrashing (more resources managing the queue than processing flow).

**Canonical solutions:** Bottleneck elimination, bypass routing, load balancing, buffer management, demand shaping.

**Example domains:** Supply chain logistics, cardiovascular medicine, network engineering, traffic systems, manufacturing (lean/TOC), data pipelines, bureaucratic processes.

---

## 2. Coordination Problems

**Structure:** Multiple independent actors must align behavior without a central controller to achieve a collective outcome.

**Key variables:** Number of actors, communication bandwidth, incentive alignment, trust level, observability.

**Dynamics:** Coordination cost scales superlinearly with actor count. Misaligned incentives create defection temptation. Information asymmetry leads to suboptimal outcomes even when incentives align.

**Known failure modes:** Free riding, deadlock, Byzantine failure (contradictory signals), coordination collapse, consensus paralysis.

**Canonical solutions:** Mechanism design, Schelling focal points, consensus protocols (Byzantine Fault Tolerance (BFT), Paxos, Raft), hierarchical coordination, repeated game structures, commitment devices.

**Example domains:** Distributed computing, flock/swarm behavior, market coordination, team management, immune system response, international diplomacy, open-source governance.

---

## 3. Matching Problems

**Structure:** Two sets of entities need to be paired efficiently, often with preferences, constraints, or compatibility requirements on both sides.

**Key variables:** Market thickness, preference structure, information completeness, timing, match stability.

**Dynamics:** Thin markets suffer from poor matches. Thick markets suffer from coordination costs. Hidden preferences create information asymmetry. Unstable matches unravel.

**Known failure modes:** Market unraveling (matching too early), congestion, mismatch persistence (switching costs), strategic misrepresentation, thin market failure.

**Canonical solutions:** Deferred acceptance (Gale-Shapley), auction mechanisms (Vickrey, combinatorial), clearinghouses, market design, two-sided reputation systems.

**Example domains:** Job markets, organ donation (kidney exchange), ad targeting, college admissions, enzyme-substrate binding, dating platforms, spectrum allocation.

---

## 4. Tragedy of the Commons

**Structure:** A shared resource is available to multiple actors. Individual exploitation benefits each actor, but collective exploitation depletes or degrades the resource for everyone.

**Key variables:** Resource regeneration rate, number of users, excludability, observability, time horizon.

**Dynamics:** Individually rational behavior produces collectively irrational outcomes. Resource degrades gradually then suddenly collapses (tipping point). Actors who restrain themselves lose to those who don't.

**Known failure modes:** Resource collapse, race to the bottom, regulatory capture, measurement failure (depletion invisible until irreversible).

**Canonical solutions:** Ostrom's eight principles (boundary definition, proportional costs/benefits, collective choice, monitoring, graduated sanctions, conflict resolution, right to organize, nested governance), privatization, regulation, quota systems, norm-based governance.

**Example domains:** Fisheries, atmospheric carbon, antibiotic resistance, technical debt accumulation, shared infrastructure, attention economy, groundwater, open-source maintainer burnout.

---

## 5. Principal-Agent Problems

**Structure:** One entity (the principal) delegates action to another (the agent) whose interests don't perfectly align and whose actions can't be fully observed.

**Key variables:** Information asymmetry, observability, incentive gap, outside options, contract completeness.

**Dynamics:** Moral hazard (agent takes risks because principal bears costs). Adverse selection (agent misrepresents capabilities). Shirking. Gold-plating (over-invest in visible work, neglect invisible work). Goodhart's Law — measurement proxies distort behavior.

**Known failure modes:** Moral hazard, adverse selection, agency costs (monitoring + bonding + residual loss), perverse incentives, multi-principal conflicts.

**Canonical solutions:** Incentive alignment (performance-based compensation), monitoring systems, bonding (agent puts up collateral), screening, reputation markets, mechanism design.

**Example domains:** Management-employee, investor-founder, voter-politician, doctor-patient, lawyer-client, contractor-client, insurance markets, wealth management.

---

## 6. Network Effects and Tipping Points

**Structure:** System value increases (or decreases) nonlinearly with participation. Below critical mass, the system fails to sustain itself; above it, growth is self-reinforcing.

**Key variables:** Critical mass threshold, network density, adoption rate, switching costs, cross-side effects (in two-sided markets).

**Dynamics:** S-curve adoption. Winner-take-all/most dynamics. Chicken-and-egg problem for two-sided platforms. Positive feedback: more users → more value → more users. Negative feedback at scale: congestion, signal-to-noise degradation.

**Known failure modes:** Failure to reach critical mass, winner's curse (too large to govern), platform decay (growth over quality), lock-in dystopia, sudden collapse (bank run dynamics).

**Canonical solutions:** Subsidize the scarce side, seed with single-player value, sequential rollout (density in one niche first), interoperability, two-sided pricing.

**Example domains:** Social platforms, telecommunications, financial markets, epidemiology (Susceptible, Infected, Recovered (SIR) models), social movements, technology adoption (Rogers diffusion), cryptocurrencies, language adoption.

---

## 7. Phase Transitions

**Structure:** A system appears stable under gradual parameter changes, then undergoes a sudden qualitative shift at a critical threshold. Often irreversible or reversible only at a different threshold (hysteresis).

**Key variables:** Order parameter, control parameter, critical point, hysteresis, early warning signals (critical slowing down, increased variance, flickering).

**Dynamics:** System looks stable right up until it isn't. Small perturbations near the critical point produce disproportionately large effects. Critical slowing down — system takes longer to recover from perturbations as it approaches the transition.

**Known failure modes:** Surprise collapse (early signals ignored), irreversibility, gradual normalization ("boiling frog"), false stability (hasn't been pushed to threshold yet).

**Canonical solutions:** Early warning monitoring (variance, autocorrelation, skewness), buffer zones, stress testing, reversibility design, modular isolation.

**Example domains:** Materials science, financial market crashes, climate tipping points, organizational culture shifts, paradigm changes (Kuhn), ecosystem regime shifts, political revolutions, technology S-curves.

---

## 8. Feedback Loops

**Structure:** The output of a system feeds back into its input, creating either reinforcing (positive) or balancing (negative) cycles.

**Key variables:** Loop polarity, loop delay, loop gain, number of loops, dominance (which loop currently controls behavior).

**Dynamics:** Reinforcing loops produce exponential growth or collapse. Balancing loops produce oscillation or equilibrium. Long delays cause overshoot and oscillation. Loop dominance can shift suddenly — system behavior changes qualitatively.

**Known failure modes:** Runaway reinforcing loop (no balancing mechanism), overshoot (delayed feedback), oscillation (boom-bust), policy resistance (interventions trigger neutralizing feedback), fixes that fail (short-term fix weakens long-term capacity).

**Canonical solutions:** Shorten feedback delays, add balancing loops, leverage points (Meadows' 12 leverage points), system dynamics modeling, circuit breakers.

**Example domains:** Arms races, thermostat control, compound interest, addiction, predator-prey oscillations, bullwhip effect (inventory management), social media algorithms, monetary policy, team morale spirals.

---

## 9. Search Problems

**Structure:** Finding a good or optimal solution in a large, poorly understood space where evaluation is expensive and the landscape is unknown in advance.

**Key variables:** Search space size, evaluation cost, landscape ruggedness, dimensionality, time pressure.

**Dynamics:** Fundamental tradeoff: exploration (new areas) vs. exploitation (refine known good areas). Smooth landscapes reward gradient-based exploitation; rugged landscapes reward random exploration. Local optima trap exploitative strategies.

**Known failure modes:** Local optima trap, premature convergence, exhaustion (space too large), overfitting, analysis paralysis.

**Canonical solutions:** Multi-armed bandit strategies (epsilon-greedy, Upper Confidence Bound (UCB), Thompson sampling), simulated annealing, evolutionary algorithms, Bayesian optimization, portfolio strategies.

**Example domains:** Drug discovery, algorithm design, hiring, market exploration, oil exploration, hyperparameter tuning, evolutionary adaptation, startup pivot strategy, scientific hypothesis generation.

---

## 10. Scaling Problems

**Structure:** What works at one scale breaks at another. Properties that function well at small scale produce qualitatively different behavior at large scale.

**Key variables:** Current scale, target scale, scaling exponent (linear, sublinear, superlinear), breaking points, infrastructure requirements.

**Dynamics:** Most properties scale sublinearly (diminishing returns) or superlinearly (increasing costs). Different components have different scaling exponents — the worst becomes the bottleneck. Organizational complexity tends to scale superlinearly with headcount.

**Known failure modes:** Premature scaling, scaling cliff, complexity explosion, loss of identity (what worked was a property of smallness), infrastructure lag.

**Canonical solutions:** Modular architecture, hierarchical decomposition, self-similar design, infrastructure ahead (build for 10x before needed), scaling audits, shedding (deliberately lose properties that don't scale).

**Example domains:** Startup growth, biological scaling laws (Kleiber's law), urban scaling (Bettencourt/West), distributed computing, military organization, educational systems, franchise operations, open-source governance.

---

## 11. Lock-in and Path Dependence

**Structure:** Early decisions constrain future options disproportionately. Once a path is chosen, switching becomes increasingly costly, even if the original choice was arbitrary or suboptimal.

**Key variables:** Switching costs, increasing returns, sunk costs, alternative availability, lock-in depth (layers of dependency).

**Dynamics:** Each additional investment increases switching cost. Increasing returns make the chosen path look better than it is (alternatives haven't received equal investment). Sunk cost fallacy keeps actors committed. Eventually, alternatives are technically possible but practically impossible.

**Known failure modes:** Inferior lock-in (QWERTY, VHS over Betamax), zombie technologies, innovation stifling, organizational lock-in (processes/culture/hiring all optimized for current path).

**Canonical solutions:** Modularity, option preservation, standards and interoperability, sunset planning, clean-sheet design, bridging strategies (gradual migration paths).

**Example domains:** Technology standards (QWERTY, USB, TCP/IP (Transmission Control Protocol/Internet Protocol)), programming language adoption, organizational culture, urban planning, legal precedent, career paths, platform ecosystems.

---

## 12. Emergence

**Structure:** System-level behavior arises from component interactions in ways that cannot be predicted from components alone. The whole is qualitatively different from the sum of its parts.

**Key variables:** Component count, interaction rules, interaction density, feedback presence, observation level.

**Dynamics:** Simple rules at component level produce complex behavior at system level. Analysis (breaking into parts) destroys the emergent property — it exists only in interactions. Emergent properties are often robust (persist despite component changes) and surprising (not designed or intended). Downward causation — emergent patterns constrain component behavior.

**Known failure modes:** Reductionist blindness (analyzing components, missing emergent properties), unintended emergence, control illusion (component control ≠ system control), emergence suppression (over-structuring kills beneficial emergence too).

**Canonical solutions:** Agent-based modeling, intervention at interaction level (not component level), boundary conditions (constrain space without dictating outcome), observation infrastructure, adaptive governance.

**Example domains:** Consciousness (neurons → mind), market prices (trades → price), traffic jams (drivers → congestion), ant colony intelligence, flocking/swarming, organizational culture, immune adaptation, language evolution, Wikipedia quality.

---

## Usage Notes

- Most real-world problems involve 2–3 interacting patterns. A startup scaling challenge might be a Scaling Problem (primary) with Network Effects (secondary) and a Coordination Problem (tertiary).
- When patterns interact, one can amplify or suppress another. Network Effects can create Lock-in. Feedback Loops can trigger Phase Transitions. Coordination Problems can produce Tragedy of the Commons.
- The taxonomy is not exhaustive. New patterns should be added when a structural shape appears in 3+ unrelated domains.
