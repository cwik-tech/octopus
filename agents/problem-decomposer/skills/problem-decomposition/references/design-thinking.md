# Design Thinking, Double Diamond, and TRIZ

## Overview

Three complementary frameworks for structured innovation and problem-solving:

1. **Design Thinking** (IDEO/Stanford d.school): A human-centered, iterative approach to reframing and solving problems
2. **Double Diamond** (British Design Council): A two-phase (Discover & Define → Develop & Deliver) decomposition for innovation projects
3. **TRIZ** (Theory of Inventive Problem Solving, Altshuller): A systematic method for resolving technical contradictions using 40 inventive principles

Use Design Thinking and Double Diamond for ill-structured or human-centric problems; use TRIZ for technical contradictions where conventional approaches create trade-offs.

## When to Use Each Framework

| Framework | Best For | Domain |
|-----------|----------|--------|
| **Design Thinking** | Reframing problems from user perspective, rapid iteration, stakeholder buy-in | Human/organizational (Soft Systems) |
| **Double Diamond** | Managing uncertainty in complex projects, documenting diverge/converge cycles | Project management, product development |
| **TRIZ** | Eliminating trade-offs, technical contradictions, inventive solutions | Engineering, technical design (Complicated) |

## Design Thinking: Five Phases

Design Thinking is iterative and non-linear. Phases often overlap or cycle.

### Phase 1: Empathize

**Goal:** Deeply understand the user and their context; uncover latent needs and frustrations.

**Activities:**
- Conduct ethnographic research or shadowing (observe, don't interview)
- Interview users in their actual context (not a focus group)
- Map user journeys and pain points
- Create personas or user profiles
- Identify unmet needs (what users don't say but show through behavior)

**Key insight:** Problems are best reframed through deep empathy, not stakeholder opinions.

**Example:**
- Assumption: "Users want faster checkout."
- Empathy research: Observe that users often abandon checkouts midway.
- Discovery: Users aren't frustrated by speed; they're unsure if the site is trustworthy. They want social proof (reviews, guarantees).
- Reframe: Problem is not speed; it's trust.

**Questions to ask:**
- "What does the user actually do, vs. what do they say they do?"
- "What frustrates them? What delights them?"
- "What do they assume they must accept as a constraint?" (These are often solvable.)

### Phase 2: Define

**Goal:** Synthesize empathy research into a clear, user-centric problem statement.

**Activities:**
- Identify themes and patterns from empathy research
- Write a "How Might We" (HMW) problem statement
- Prioritize HMW statements by impact and feasibility
- Align stakeholders on the reframed problem

**HMW Structure:** "How might we [action] so that [user] can [outcome]?"

**Examples:**
- Bad: "Make checkout faster"
- Good: "How might we build trust quickly so that first-time users complete their purchase?"
- Good: "How might we reduce decision fatigue so that busy professionals save time selecting products?"

**Key:** The reframed problem often suggests solutions naturally.

### Phase 3: Ideate

**Goal:** Generate many ideas without judgment; diverge widely, then narrow.

**Activities:**
- Brainstorm with diverse team (include non-experts)
- Use techniques: Brainwriting, Reverse Brainstorming, Worst-Possible-Idea
- Encourage wild ideas; quantity over quality
- Document all ideas; defer evaluation
- Build on others' ideas (yes, and...)
- Identify 3–5 promising ideas to prototype

**Key technique: "Worst Possible Idea"**
- Ask: "What's the absolute worst way to solve this?"
- Invert the worst idea; often yields fresh solutions
- Example: "Worst way to build trust: Use bright colors, no contact info, auto-play videos, lots of ads." → Invert: Clean design, prominent contact, no auto-play, minimal ads.

### Phase 4: Prototype

**Goal:** Build low-fidelity, quick prototypes to test ideas and learn.

**Activities:**
- Build prototypes fast (1–3 days per prototype)
- Use available materials (paper, cardboard, simple mockups)
- Accept that prototypes are rough and will be discarded
- Test multiple concepts in parallel
- Fail fast; learn quickly

**Fidelity levels:**
- **Rough (Paper sketch):** Test concept viability and user mental model
- **Medium (Wireframe):** Test interaction flow and information hierarchy
- **High (Working prototype):** Test with real context and data

**Key:** The prototype is a question ("Does this approach resonate?"), not a solution.

### Phase 5: Test

**Goal:** Gather user feedback on prototypes and refine the solution.

**Activities:**
- Show prototypes to real users in their context
- Observe reactions; note surprise and confusion
- Ask open-ended questions ("What would you expect here?")
- Iterate prototypes based on feedback
- Cycle back to earlier phases if fundamental reframes are needed

**Key:** Testing is not validation; it's learning. Expect 50%+ of assumptions to be wrong.

**Output:** Refined solution; clear backlog of next iterations.

## Double Diamond: Discover–Define–Develop–Deliver

The Double Diamond (British Design Council, 2005) visualizes the diverge–converge pattern of problem-solving.

### Diagram Structure

```
      Discover Phase              Define Phase
         (Diverge)                 (Converge)
              │                         │
        Research                  Problem
        Interviews              Synthesis
        Brainstorm                  HMW
              │                         │
           ╱─┴─╲                    ╱─┴─╲
          ╱     ╲                  ╱     ╲
         ╱       ╲                ╱       ╲
        ╱ DISCOVER╲──DEFINE────╱ DEVELOP ╲─DELIVER
                 ╱       ╲          ╲       ╱
                ╱         ╲          ╲     ╱
               ╱           ╲          ╲   ╱
              ╱             ╲          ╱─┴─╲
             │               │           │
        Insights          Solution    Launch
        Themes            Direction   Handoff
        Personas          Roadmap     Success
```

### Diamond 1: Discover (Diverge) → Define (Converge)

**Discover (Diverge):** Cast a wide net. Gather data, perspectives, and possibilities from diverse sources.

**Activities:**
- User research (interviews, observations, surveys)
- Market research (trends, competitive analysis)
- Stakeholder interviews
- Data analysis
- Synthesize into themes and insights

**Output:** Rich understanding of the problem landscape; multiple perspectives; data-backed insights.

**Define (Converge):** Narrow focus. Synthesize to a clear problem statement and direction.

**Activities:**
- Identify 3–5 key themes from Discover
- Create personas or user profiles
- Write HMW statements
- Prioritize by impact and alignment
- Align stakeholders on the chosen direction

**Output:** Shared problem statement; clear HMW; prioritized solution direction.

### Diamond 2: Develop (Diverge) → Deliver (Converge)

**Develop (Diverge):** Generate many solution concepts. Prototype and test multiple approaches.

**Activities:**
- Ideation and brainstorming
- Create 3–5 concept prototypes
- Test each concept with users
- Gather feedback; synthesize learnings

**Output:** Multiple validated concepts; user feedback; clear winners and losers.

**Deliver (Converge):** Build and launch. Narrow to the strongest solution; polish and scale.

**Activities:**
- Select the strongest concept (or hybrid)
- Build production version
- Final testing and refinement
- Launch and monitor

**Output:** Shipped product; user feedback loop; success metrics.

## TRIZ: Theory of Inventive Problem Solving

### Overview

TRIZ (Теория Решения Изобретательских Задач, Russian) is a systematic framework for solving technical contradictions without trade-offs. Developed by Genrich Altshuller in the 1950s by analyzing thousands of patents, TRIZ asserts that most problems follow patterns and can be solved using known inventive principles.

### Core Insight

When you face a contradiction ("I need A, but that forces trade-off B"), TRIZ says: "Your problem has been solved before. Find and apply the known principle."

**Example Contradiction:**
- "I need strong material (thick steel) for durability."
- "But thick steel is heavy, expensive, and slow to manufacture."
- Solution: Apply **Principle 40 (Composite Materials)** — Use layers (composite) instead of solid material.

### The 40 Inventive Principles (Top 10 Most Applicable)

| # | Principle | Description | Example |
|---|-----------|-------------|---------|
| **1** | **Segmentation** | Divide object, system, or action into parts; increase granularity. | Break a large chip into smaller cells (allows parallel processing). Segment user interfaces by task. |
| **2** | **Extraction/Removal** | Remove the problematic part or property; extract the "essence." | Remove friction element instead of adding lubricant. In software, remove the feature causing complexity instead of adding flags. |
| **4** | **Asymmetry** | Break symmetry; make non-uniform what was uniform. | Asymmetric tire tread patterns (wet/dry sides) improve grip. Asymmetric user interfaces (primary nav left, secondary right). |
| **6** | **Universality** | Design components to handle multiple functions or contexts. | Multi-tool device instead of separate tools. Modular API that handles multiple use cases. |
| **10** | **Prior Action** | Perform required action(s) before problem arises; prepare in advance. | Pre-load data instead of waiting for request (caching). Pre-train model instead of training on-the-fly. |
| **13** | **Inversion** | Reverse roles; turn problem on its head; do the opposite. | Instead of heating water, cool air (evaporative cooling). Instead of increasing capacity, reduce demand. |
| **14** | **Spheroidality** | Replace flat/linear with curved; use spherical forms instead of angular. | Spherical tanks are stronger than cubic (pressure distributes evenly). Rounded UI corners feel friendlier than sharp. |
| **19** | **Periodic Action** | Replace continuous action with periodic (pulsed) action; vary the action. | Vibration (periodic force) breaks up sediment better than steady force. Flickering/strobing draws attention (periodic light). |
| **28** | **Mechanism Replacement** | Replace physical mechanism with field (magnetic, electric, thermal, acoustic). | Replace mechanical pump with electromagnetic pump. Replace physical buttons with touch/gesture (field-based). |
| **40** | **Composite Materials** | Use composite materials to gain properties of both without pure downsides. | Carbon fiber composite (strong and light). Layered app architecture (scales and is maintainable). |

### Applying TRIZ: A Four-Step Process

**Step 1: Define the Contradiction**

State the trade-off clearly:
"I want [Property A] to improve, but that requires sacrificing [Property B]."

**Example contradictions:**
- "I want API response time to decrease, but that requires increasing infrastructure cost."
- "I want the product to be robust, but that requires complex configuration (harder to use)."
- "I want the material to be stronger, but that increases weight."

**Step 2: Map to TRIZ Parameters**

TRIZ uses 39 standard parameters (e.g., Speed, Weight, Strength, Complexity). Map your contradiction:

**Common parameters:**
- **Energy consumed / Operating cost** (parameter 20)
- **Complexity** (parameter 36)
- **Control / Reliability** (parameter 28)
- **Speed** (parameter 9)
- **Strength** (parameter 14)
- **Weight** (parameter 1)

**Example mapping:**
- "Stronger but lighter" → Improve parameter 14 (Strength) without worsening parameter 1 (Weight)

**Step 3: Use the Contradiction Matrix**

TRIZ provides a 39×39 matrix where rows are "parameters you want to improve" and columns are "parameters you're worried about worsening." The matrix cell contains the top 3–4 inventive principles that historically solve that contradiction.

*(Note: For simplicity, consult a TRIZ reference or web tool; a full matrix is large.)*

**Example lookup:**
- Row: Strength (want to improve)
- Column: Weight (worried about worsening)
- Cell result: Principles 40 (Composite Materials), 28 (Mechanism Replacement), 6 (Universality)

**Step 4: Apply the Suggested Principles**

Use the top-ranked principles to brainstorm solutions.

**Example: "Stronger without heavier"**

- **Principle 40 (Composite Materials):** Use carbon fiber (strong fibers in weak resin matrix) instead of solid aluminum. Result: Stronger AND lighter.
- **Principle 28 (Mechanism Replacement):** Replace physical structure with electromagnetic forces (e.g., magnetic levitation). Result: Can remove weight while maintaining strength via field.

### Worked Example: API Latency vs. Infrastructure Cost

**Contradiction:** "We want API response time < 100ms (improve speed), but caching and replication require more servers (worsen cost)."

**TRIZ mapping:**
- Improve: Speed (parameter 9)
- Worsen: Operating cost (parameter 20)

**Principles (from hypothetical matrix):** 10 (Prior Action), 2 (Extraction), 19 (Periodic Action)

**Application:**

- **Principle 10 (Prior Action):** Pre-compute and cache results instead of computing on-demand.
  - Example: Pre-generate homepage, top 100 products before traffic peaks.
  - Cost: Small compute cost upfront; cache hit rates 70%+; net savings.

- **Principle 2 (Extraction):** Remove expensive computations; compute only what users need.
  - Example: Lazy-load images; don't compute expensive analytics unless user explicitly requests.
  - Cost: Reduced server utilization; net savings.

- **Principle 19 (Periodic Action):** Recompute results at low-traffic times instead of continuously.
  - Example: Run heavy batch jobs at night; cache results for daytime queries.
  - Cost: Shift compute to off-peak (cheaper rates); net savings.

**Result:** 100ms latency at *lower* cost, not higher.

### When TRIZ Works Best

- **Technical contradictions are clear.** (Strength vs. Weight; Speed vs. Cost)
- **Multiple design variables exist.** (Material choice, architecture, algorithm)
- **Historical patents or solutions exist** for similar contradictions
- **You want to avoid incremental trade-offs.** ("Can we get both good speed AND low cost?")

### When TRIZ is Limited

- **The problem is human/organizational.** (TRIZ is for technical systems; Soft Systems Methodology is better)
- **The contradiction is false.** (Not all "contradictions" are real; may be a framing issue)
- **Your domain is novel.** (TRIZ draws on historical patterns; if your domain is brand new, fewer patterns apply)

## Tips for AI Agents

1. **Use Design Thinking for reframing.** When the problem statement feels off or stakeholders disagree, empathy and HMW reframing clarifies.
2. **Use Double Diamond for project structure.** When managing complex projects, the diverge–converge pattern prevents premature narrowing.
3. **Use TRIZ for technical contradictions.** When trade-offs feel inevitable ("stronger requires heavier"), TRIZ often reveals a way out.
4. **Combine them:** Use Design Thinking to reframe → Use Double Diamond to structure the project → Use TRIZ to solve technical contradictions within Develop phase.
5. **Prototype early and often.** Design Thinking and Double Diamond thrive on iteration; failing fast teaches more than analysis.

## Common Pitfalls

| Pitfall | What Happens | How to Fix |
|---------|--------------|-----------|
| **Skipping Empathize** | Solutions are elegant but users don't want them. | Talk to real users in real contexts; observe, don't survey. |
| **Converging too early (Double Diamond)** | Discover finds 10 opportunities; Define narrows to 1; miss better options. | Resist pressure to narrow; diverge longer; test multiple HMW statements. |
| **Iterating forever** | Design Thinking cycles endlessly; never ships. | Set a time box: "5 prototypes, 2 weeks, then decide." Honor the deadline. |
| **Forcing TRIZ onto non-technical problems** | Contradiction matrix doesn't fit human/social problems. | Use TRIZ only for technical contradictions. For soft problems, use Soft Systems Methodology. |
| **Applying wrong principle** | Looked up contradiction, got principle, applied it, didn't work. | Principles are starting points, not solutions. Brainstorm multiple ways to apply each principle. |
| **Misdefining the contradiction** | Stated: "Speed vs. Cost." Actual: "Speed vs. team skill." Wasted effort. | Validate contradiction with stakeholders before applying TRIZ. Ask "Is this the real trade-off?" |

## References

- IDEO. (2012). *The Design of Everyday Things*. Revised and Expanded Edition. Basic Books.
- Norman, D. A. (2013). *The Design of Everyday Things: Revised and Expanded Edition*.
- Design Council (UK). (2005). "The Double Diamond: A Universally Accepted Evolution of the Design Process in Industry." *Design Council Publications*.
- Altshuller, G. (1984). *Creativity as an Exact Science*. Gordon and Breach.
- Orloff, M. A. (2006). *Inventive Thinking Through TRIZ*. Springer.
- TRIZ Journal: https://trizjournal.com/
