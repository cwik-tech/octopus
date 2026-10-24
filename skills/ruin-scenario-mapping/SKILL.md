---
name: ruin-scenario-mapping
description: Apply the Taleb discipline of identifying, for every real estate deal, the specific chain of events that produces ruin — permanent, unrecoverable capital loss — and verifying that no single such chain has non-trivial probability. Deals with any plausible ruin path must be restructured or abandoned. Use when sizing leverage, testing refinancing, covenant, and liquidity risk, or checking whether any single failure chain can permanently wipe out the position.
---

# Ruin Scenario Mapping

## Purpose

Most real estate risk frameworks compute expected returns and call it a day. Taleb's discipline is that expected value is meaningless in the presence of ruin: a single unrecoverable loss terminates the compounding game. This skill forces the crew to enumerate ruin paths before committing capital.

## Protocol

### Step 1: Define Ruin for This Position

State precisely what "ruin" means for this deal, in dollars and in consequences:

- Equity wipeout (100% loss of invested equity)
- Loss exceeding a named fraction of the firm's equity capital (>X% of total fund or family net worth)
- Recourse personal liability triggered
- Reputational event that impairs the ability to raise future capital
- Regulatory or legal action that constrains future operations

Ruin is not just losing money on this deal. It is the loss that damages the ability to play the next round.

### Step 2: Enumerate the Ruin Paths

List every plausible chain of events that leads from today to ruin. Use specific mechanisms, not adjectives. For each path, write:

- The triggering event (rate spike, tenant default, natural disaster, fraud discovery, regulatory change, construction failure)
- The propagation mechanism (covenant breach → forced sale → deficiency → recourse)
- The terminal state (the specific dollar loss and its consequences)

Typical real estate ruin paths to check:

1. Refinance fails at maturity in a rate-up regime
2. Anchor tenant defaults in a thin market with no replacement
3. Construction delay + cost overrun in a tight-margin development
4. Environmental or title discovery that cannot be insured around
5. Fraud or misrepresentation in the sponsor or seller
6. Natural disaster where insurance proves inadequate
7. Correlated portfolio failure across multiple assets sharing a single risk factor

### Step 3: Check for the Barbell

For each identified risk, state whether the exposure is structured as a barbell (mostly safe, small asymmetric upside) or a bullet (concentrated around a single scenario). Bullets invite ruin. Barbells do not.

### Step 4: Verify Antifragility Where Possible

Antifragility is exposure that benefits from volatility rather than merely tolerating it. Ask: are there parts of this deal that actually become more valuable in bad scenarios? (Example: owning the land under a failing building — you benefit from the building's obsolescence.) If no component is antifragile, at minimum ensure no component is actively fragile to volatility.

### Step 5: Apply the "Never" Rule

For each ruin path, the acceptable probability is zero in the relevant sense: the path must be structurally impossible, not merely unlikely, OR the consequences must be capped below ruin by structure (non-recourse debt, ring-fenced entity, capped insurance losses).

If any ruin path exists with non-trivial probability AND uncapped consequences, the deal must be restructured.

### Step 6: List the Restructure Options

For each unacceptable ruin path, name the structural change that removes it:

- Lower leverage
- Longer debt term that eliminates refinance risk
- Non-recourse with carve-outs clearly enumerated
- Insurance with named coverage limits
- Smaller position sizing
- Walk

### Step 7: Write the Ruin Verdict

> "Ruin defined as [X]. Ruin paths identified: [list]. Worst uncapped path: [path]. Structural cap: [yes/no — structure]. Antifragile components: [list or none]. [Proceed at size / reduce to size / restructure / walk]."

## When to Apply

Every deal. Especially any deal with leverage, any deal where total capital at risk exceeds a meaningful fraction of the firm's net worth, and any deal with recourse or personal guarantees.

## When Not to Apply

Truly small, all-cash, diversified positions where no plausible outcome threatens the firm's ability to continue operating. These are rare and must be explicitly justified.

## Integration With Other Skills

This skill maps tail-event survivability. Combine with Dalio's four-quadrant test (which regimes trigger the ruin paths), Buffett's replacement cost test (sets the asset-level floor), and Drucker's enterprise audit (operational ruin paths like management blowup).
