# Dependency-Aware Sequencing

## Why Raw Scores Aren't Enough

Priority scores assume each item is independent. In reality:
- Item A might block Item B (can't build the dashboard until the data pipeline exists).
- Item C might be a "force multiplier" (building the testing framework makes everything faster).
- Item D might have a deadline that overrides its priority score.

Sequencing adds dependency awareness and capacity constraints to produce an executable plan.

## Dependency Mapping

### Step 1: Identify Dependencies

For each item, ask:
- **"What must exist before this can start?"** (Hard dependency — no workaround.)
- **"What would make this significantly easier?"** (Soft dependency — could work around, but costly.)
- **"What does this enable?"** (Downstream value — solving this unblocks other work.)

### Step 2: Build the Dependency Graph

Use notation: A → B means "A must be completed before B can start."

Example:
```
Data Pipeline → Dashboard → Executive Reporting
Data Pipeline → API v2
Auth Service → API v2 → Mobile App
Design System → Dashboard
Design System → Mobile App
```

### Step 3: Identify Critical Path

The critical path is the longest chain of dependent items. It determines the minimum total duration.

From the example above:
- Path 1: Data Pipeline → Dashboard → Executive Reporting (3 items)
- Path 2: Data Pipeline → API v2 → Mobile App (3 items)
- Path 3: Auth Service → API v2 → Mobile App (3 items)
- Path 4: Design System → Dashboard → Executive Reporting (3 items)
- Path 5: Design System → Mobile App (2 items)

Critical path depends on duration estimates. The longest-duration path is critical.

### Step 4: Identify Force Multipliers

Items that unblock many downstream items should be elevated:

| Item | Downstream Items Unblocked | Priority Boost |
|---|---|---|
| Data Pipeline | Dashboard, API v2, Executive Reporting, Mobile App | HIGH — unblocks 4 items |
| Design System | Dashboard, Mobile App, Executive Reporting | HIGH — unblocks 3 items |
| Auth Service | API v2, Mobile App | MEDIUM — unblocks 2 items |

**Rule:** If an item's standalone priority score is moderate but it unblocks 3+ higher-priority items, elevate it to match the highest item it unblocks.

## Sequencing Strategies

### Strategy 1: Priority-First (Default)

Execute in priority-score order, respecting dependencies:
1. Start with the highest-priority item that has no unmet dependencies.
2. When it's complete, start the next highest-priority item with no unmet dependencies.
3. If the next high-priority item is blocked, either work on its blocker or take the next unblocked item.

**Pros:** Simple, keeps focus on highest-value work.
**Cons:** May leave high-priority items waiting if their blockers are low-priority.

### Strategy 2: Critical Path First

Prioritize items on the critical path to minimize total duration:
1. Always work on critical path items first.
2. Fill remaining capacity with non-critical items.
3. Re-evaluate the critical path as items complete (it can shift).

**Pros:** Minimizes total project duration.
**Cons:** May not optimize for value delivery — the critical path might contain low-value items.

### Strategy 3: Quick Wins First (Momentum)

Start with high-impact, low-effort items to build momentum and demonstrate progress:
1. Execute all "quick wins" (high impact, low effort) first.
2. Then switch to priority-first ordering for remaining items.
3. Use quick wins to build stakeholder confidence before tackling hard items.

**Pros:** Early value delivery, stakeholder buy-in, team morale.
**Cons:** May delay critical path items, extending total duration.

### Strategy 4: Risk-First

Address highest-risk items first to reduce uncertainty:
1. Identify items with highest technical or market uncertainty.
2. Execute these first (or run spikes/experiments) to reduce unknowns.
3. Then sequence remaining items with better estimates.

**Pros:** Reduces estimation error, prevents late-stage surprises.
**Cons:** May frontload difficult work, slowing early progress.

### Choosing a Strategy

| Situation | Recommended Strategy |
|---|---|
| Stakeholders need to see progress fast | Quick Wins First |
| Total timeline is the binding constraint | Critical Path First |
| Many items with similar priority | Priority-First with dependency respect |
| High uncertainty about feasibility | Risk-First |
| Mixed constraints | Quick Wins First → Critical Path → Priority-First |

## Capacity-Aware Scheduling

### Parallel Execution

If you have multiple teams or resources:
1. Identify items that can run in parallel (no shared dependencies).
2. Assign parallel streams to different teams.
3. Synchronize at dependency points.

### Capacity Constraints

- **Bottleneck identification:** If one team or skill is required by most items, that's the bottleneck. Sequence to keep the bottleneck busy.
- **Context switching cost:** Each switch between items costs ~20% productivity. Minimize by batching similar work.
- **Buffer allocation:** Add 20% buffer to critical path items. If they finish early, pull forward the next item. If they slip, the buffer absorbs it.

## For AI Agents

- **Always map dependencies before sequencing.** A priority list without dependencies is a wishlist, not a plan.
- **Elevate force multipliers.** Items that unblock many others are more valuable than their standalone score suggests.
- **Make the sequencing strategy explicit.** State which strategy you're using and why. Different stakeholders may prefer different strategies.
- **Present the sequence, not just the ranking.** A ranked list says what matters most. A sequence says what to do in what order. Stakeholders need the sequence.
- **Revisit when items complete.** Finishing an item may unblock new work, shift the critical path, or change priorities. Re-sequence regularly.
