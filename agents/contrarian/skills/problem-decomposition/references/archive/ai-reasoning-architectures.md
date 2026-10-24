# AI Reasoning Architectures: Inference-Time Decomposition Topologies

**When to use:** After identifying the problem structure via traditional decomposition methods, select the inference-time reasoning architecture that best matches your problem's computational and reasoning demands. Use this to decide how the AI agent should *internally structure* its thinking—linear, branching, cyclical, or multi-agent.

**Why this matters:** Problem decomposition and reasoning architecture are orthogonal. You might decompose a problem into 5 logical steps, but the AI agent's reasoning can follow different topologies to solve those steps. Choosing the right topology improves solution quality, reduces hallucination, and manages computational cost.

## Reasoning Architectures at a Glance

| Architecture | Topology | Best For | Cost | Confidence |
|---|---|---|---|---|
| **Chain of Thought (CoT)** | Linear sequence | Simple decompositions, straightforward reasoning | Low | Medium |
| **Tree of Thoughts (ToT)** | Branching tree | Decisions with multiple valid paths, multi-step reasoning | Medium | Higher |
| **Graph of Thoughts (GoT)** | Directed graph (DAG) | Complex interdependencies, circular reasoning needs | High | Highest |
| **Adaptive Graph of Thoughts (AGoT)** | Dynamic graph | Problems where reasoning path emerges during solving | Very High | Highest + adaptive |
| **ReAct** | Linear + interleaved acting | Real-world interaction, feedback loops, tool use | Medium | Medium-High |
| **Multi-Agent Decomposition** | Multi-process DAG | Large problems, role-based reasoning, specialization | Very High | Highest (if coordinated) |

## Architecture Details

### Chain of Thought (CoT)
**Topology:** Linear sequence. Step 1 → Step 2 → Step 3 → Output.

**How it works:** The AI reasons through a problem one step at a time, making each step explicit. Each step builds on previous outputs.

**Best for:**
- Well-decomposed problems with a clear logical sequence.
- Problems where reasoning is mostly straightforward.
- Time-sensitive or resource-constrained scenarios.

**Advantages:**
- Low computational cost.
- Transparent; easy to verify each step.
- Works well with fine-tuned or smaller models.

**Limitations:**
- Commits to early choices; can't backtrack.
- Misses alternative paths or parallel reasoning.
- Fails if the optimal path isn't the first discovered.

**Decomposition use:** Pair with CoT when your problem decomposes into a strict sequence with no branching.

**Example:** "Calculate the cost of a multi-step manufacturing process." Steps: material cost → labor → overhead → delivery → profit margin. Linear, no backtracking.

---

### Tree of Thoughts (ToT)
**Topology:** Branching tree. At each node, explore multiple next steps. Evaluate branches; pursue promising ones.

**How it works:** Instead of committing to one path, the AI explores multiple continuations at each step. Branches are scored (via heuristics or evaluators). High-scoring branches are expanded; low-scoring ones are pruned.

**Best for:**
- Problems with multiple valid decomposition paths.
- Decisions where you must compare alternatives.
- Reasoning where step N can branch into 2–4 plausible step N+1s.

**Advantages:**
- Explores multiple paths; avoids early mistakes.
- Higher solution quality than CoT for complex decisions.
- Backtracking is implicit; tree search handles it.

**Limitations:**
- Higher computational cost (exponential in tree depth).
- Requires a good scoring function to prune effectively.
- Can get stuck if all branches are low-quality.

**Decomposition use:** Pair with ToT when decomposition identifies choice points—moments where multiple valid sub-decompositions exist.

**Example:** "Design a cost-reduction strategy." Decomposition yields 3 approaches: automate, outsource, or eliminate waste. ToT explores each branch; at each level, multiple sub-strategies. Prune branches that violate constraints (e.g., "doesn't maintain quality").

---

### Graph of Thoughts (GoT)
**Topology:** Directed Acyclic Graph (DAG). Nodes are reasoning states. Edges are reasoning operations. Multiple paths to the same state.

**How it works:** Like ToT, but allows nodes to be reached from multiple predecessors. Instead of tree expansion, build a graph where:
- Node merging: Different reasoning paths that converge are merged.
- Shortcutting: Later reasoning can reference earlier non-adjacent nodes.
- Cycles (in reasoning, not in graph): Earlier insights can inform later reasoning via reference.

**Best for:**
- Problems where sub-problems overlap (solving component A informs component B).
- Reasoning that naturally reuses intermediate results.
- Complex decompositions with interdependencies.

**Advantages:**
- Avoids redundant reasoning (unlike tree, which repeats).
- Captures overlapping structure naturally.
- Higher quality solutions for interconnected problems.

**Limitations:**
- Much higher computational cost.
- Requires explicit dependency management.
- Cycle detection and DAG construction add overhead.

**Decomposition use:** Pair with GoT when decomposition reveals interdependencies—components that share sub-problems or inform each other.

**Example:** "Improve a supply chain." Decompose into: sourcing, logistics, warehouse, last-mile delivery. ToT would explore each separately (waste). GoT recognizes that "cost per unit" influences multiple components; compute it once, reference it across nodes.

---

### Adaptive Graph of Thoughts (AGoT)
**Topology:** Graph that evolves dynamically. The AI agent builds the graph during reasoning; structure emerges based on problem characteristics discovered in-flight.

**How it works:** Unlike GoT (static structure), AGoT:
- Starts with a minimal graph.
- Dynamically adds nodes and edges as reasoning progresses.
- Reroutes if better paths are discovered.
- Can merge or split nodes based on emerging insights.

**Best for:**
- Novel or unfamiliar problems where structure isn't known upfront.
- Problems that change during solving (new constraints, data).
- Reasoning where the decomposition itself is uncertain.

**Advantages:**
- Maximally flexible; adapts to problem as understood.
- Avoids pre-committing to incorrect structure.
- Highest quality solutions (if well-implemented).

**Limitations:**
- Extremely high computational cost.
- Requires sophisticated monitoring to detect when to restructure.
- Risk of infinite loops if adaptation logic is poor.

**Decomposition use:** Use AGoT when the problem's decomposition is partly unknown. The agent discovers structure during reasoning.

**Example:** "Diagnose a rare medical condition." You decompose into: symptom analysis, lab tests, imaging, differential diagnosis. But as results come in, decomposition shifts. AGoT handles this by dynamically reorganizing reasoning.

---

### ReAct (Reasoning + Acting)
**Topology:** Linear with interleaved feedback loops. Reason → Act → Observe → Reason → Act...

**How it works:** Alternates between thinking and taking actions (tool use, external queries). Each action returns observation that informs next thought. This loop continues until goal is reached.

**Best for:**
- Problems involving tool use or external information.
- Real-world scenarios where you can't reason in isolation.
- Iterative refinement based on feedback.

**Advantages:**
- Grounds reasoning in reality; reduces hallucination.
- Handles dynamic environments naturally.
- Good for long-horizon tasks (multiple interactions).

**Limitations:**
- Depends on availability and quality of tools/feedback.
- Slower than pure reasoning (tool latency).
- Tool errors can compound.

**Decomposition use:** Pair with ReAct when decomposition includes external actions—API calls, human queries, sensor reads, etc.

**Example:** "Research a market opportunity." Decompose into: find data, analyze competitors, estimate market size, assess fit. ReAct interleaves reasoning ("What data do I need?") with acting ("Query industry database; search competitor websites; compute TAM"). Observations inform next reasoning step.

---

### Multi-Agent Decomposition
**Topology:** Multiple agents, each owning one or more components. Agents communicate via shared state, message passing, or hierarchical coordination.

**How it works:**
- Decompose the problem into roles/specialists.
- Assign each agent a role (specialist in component X).
- Agents reason independently over their domain.
- Coordination layer synthesizes results.

**Variants:**
- **Hierarchical:** One coordinator, multiple workers.
- **Peer-to-peer:** Agents negotiate without a coordinator.
- **Sequential:** Agents operate in order; each feeds output to next.
- **Parallel:** Agents work simultaneously; coordinator merges results.

**Best for:**
- Very large problems that exceed single-agent capacity.
- Problems with clear role specialization (finance analyst, engineer, designer).
- Scenarios where different agents have different expertise.

**Advantages:**
- Scales to complex decompositions.
- Each agent can use optimized reasoning (one uses CoT, another uses ReAct).
- Specialization can improve accuracy.

**Limitations:**
- Highest computational cost.
- Coordination overhead; agents must communicate.
- Risk of inconsistency if agents disagree.

**Decomposition use:** Use multi-agent when decomposition yields 4+ components, each with distinct reasoning patterns.

**Example:** "Build a business plan." Agent 1 (Market): analyzes TAM, competition. Agent 2 (Product): defines roadmap, specs. Agent 3 (Finance): budgets and forecasts. Agent 4 (Coordinator): synthesizes into a coherent plan. Each agent uses domain-specific reasoning; coordinator resolves conflicts.

## Selecting the Right Architecture

**Decision tree:**

1. **Is the problem straightforward, well-decomposed, no branching?** → **CoT**
2. **Does decomposition have 2–4 key decision points?** → **ToT**
3. **Does decomposition have overlapping sub-problems or interdependencies?** → **GoT**
4. **Is the decomposition itself uncertain and must be discovered in-flight?** → **AGoT**
5. **Must the agent interact with external tools or world in a loop?** → **ReAct** (pair with CoT, ToT, or GoT as base)
6. **Is the problem very large, multi-domain, or requires specialization?** → **Multi-Agent**

## For AI Agents

When given a decomposed problem:
- **Identify the decomposition's structure:**
  - Linear sequence? → CoT
  - Tree of choices? → ToT
  - Interconnected components? → GoT
  - Unknown structure? → AGoT
  - External interactions required? → ReAct
  - Too large or multi-specialist? → Multi-Agent

- **Match reasoning to topology.** Don't force a problem into CoT if the decomposition is a DAG. Pick the architecture that respects the problem's structure.

- **Layer architectures.** Use ReAct as a meta-layer over CoT/ToT/GoT. Use Multi-Agent to decompose very large problems, with each agent using appropriate reasoning internally.

- **Budget computational cost.** CoT is cheapest; AGoT is most expensive. Match budget to problem stakes: low-stakes decisions can use CoT; high-stakes can justify AGoT or Multi-Agent.

- **Document the choice.** State: "This problem decomposes as [X]. Selected reasoning architecture: [Y] because [reason]."

**Outcome:** Reasoning that respects the problem's structure, optimizes compute, and improves solution quality.
