# Red Team Attack Framework for VC Deals

## When to Use

- Every deal that reaches full committee evaluation (not quick screen)
- When the committee is leaning positive and needs adversarial pressure
- When a deal has obvious strengths that may be masking hidden risks
- When the deal sponsor is highly enthusiastic (enthusiasm correlates with blind spots)

## Six-Angle Attack Framework

Attack the investment thesis from each of these six independent angles. Each angle should produce at least one concrete vulnerability.

### Angle 1: Market Risk

**Attack question:** What if the market isn't what we think it is?

- Is the TAM (Total Addressable Market) inflated? What happens if the real market is 5x smaller?
- Is the market growing because of a temporary tailwind (stimulus, pandemic behavior, regulatory gap) that will reverse?
- Is there a market timing problem — too early (market doesn't exist yet) or too late (incumbents have locked it up)?
- Are we confusing "industry size" with "addressable spend on this type of solution"?
- Is the market winner-take-all, and if so, is this company positioned to be the winner?

**Kill shot example:** "The $50B TAM assumes every hospital in the US buys this software. But only 200 hospital systems make independent purchasing decisions, average contract value is $200K, and sales cycles are 18 months. The real SOM is $40M over 5 years."

### Angle 2: Execution Risk

**Attack question:** What if this team can't execute this plan?

- Has this team built and scaled anything similar before? If not, what's the learning curve cost?
- What's the hardest thing they need to do in the next 18 months, and what evidence suggests they can do it?
- Is there a single point of failure on the team (one technical founder, one sales relationship, one domain expert)?
- What happens to the company if the CEO (Chief Executive Officer) leaves? The CTO? The head of sales?
- Is the team building the right organization for the next stage, or are they still operating like the last stage?

**Kill shot example:** "The entire sales pipeline flows through the CEO's personal network. There's no repeatable sales process, no sales playbook, and no VP Sales hire planned. This company's growth is the CEO's rolodex, not a scalable go-to-market."

### Angle 3: Financial Risk

**Attack question:** What if the economics don't work?

- What's the actual path to profitability? Not the pitch deck path — the realistic path.
- How much capital is needed to reach cash-flow breakeven? Is that amount realistic given current fundraising dynamics?
- What's the burn rate sensitivity? If revenue grows 50% slower than projected, when does the company run out of cash?
- Are the unit economics real or are they subsidized by unsustainable customer acquisition channels?
- Does the return math work at this valuation? What exit multiple is needed to return the fund?

**Kill shot example:** "At $30M pre-money and our $5M check, we own 14%. To return 3x the fund ($300M), this company needs to exit at $2.1B. Companies in this sector have a median exit of $180M. We need an outlier outcome just to break even on a fund-level basis."

### Angle 4: Timing Risk

**Attack question:** What if now is the wrong time?

- Is the technology mature enough? Or are we funding R&D (Research and Development) risk disguised as a growth company?
- Is the market ready for this product? Is there evidence of organic demand or is the company creating demand from scratch?
- Are we in a funding bubble for this sector that will correct, making follow-on capital harder to raise?
- Is there a regulatory window that could close?
- Is the company raising at the right stage — too early (burning capital before product-market fit) or too late (valuation already reflects the upside)?

**Kill shot example:** "This company is building AI infrastructure for enterprises. But enterprise AI adoption is still in the experimentation phase — less than 8% of Fortune 500 companies have production AI workloads. They're 3 years early, and they'll burn through their runway educating the market."

### Angle 5: Competitive Risk

**Attack question:** What if someone else wins?

- Who are the direct competitors, and what's their relative positioning?
- Which well-funded companies could enter this space in 12 months if the opportunity proves real?
- What's the incumbent's response? Will they build, buy, or ignore?
- Is the competitive moat real or is it just a head start? How long does the head start last?
- Is this a "one of many" market or a "winner take most" market?

**Kill shot example:** "Google launched a competing product last quarter with a free tier that undercuts this company's pricing by 80%. Google has distribution to every enterprise buyer. The only defense is 'we're more specialized' — but Google's product is 'good enough' for 90% of use cases."

### Angle 6: Black Swan Risk

**Attack question:** What low-probability, high-impact events could destroy this investment?

- Regulatory: Could a new law or enforcement action make the business model illegal or uneconomic?
- Technology: Could a breakthrough (or failure) in underlying technology obsolete the product?
- Macro: Could a recession, credit crunch, or capital market shift cut off funding or customer spend?
- Geopolitical: Could trade restrictions, sanctions, or political instability affect the market?
- Legal: Could a patent troll, IP claim, or class action lawsuit threaten the company?

**Kill shot example:** "This company processes health data across state lines. HIPAA enforcement is tightening, and three state attorneys general have filed actions against similar data practices in the last 6 months. One adverse ruling could make their entire data pipeline illegal."

## Vulnerability Documentation

For each vulnerability found, document:

| Field | Description |
|---|---|
| **Attack angle** | Which of the six angles |
| **Vulnerability** | One-sentence description |
| **Severity** | Fund-threatening / Deal-threatening / Manageable |
| **Probability** | High / Medium / Low |
| **Detectability** | Would we see this coming? What early warning signal? |
| **Mitigation** | Can we structure terms to protect? Can the company act to reduce this risk? |
| **Score** | Severity × Probability ranking for prioritization |

## Pre-Mortem Protocol

### When to Run

After the committee has leaned toward a positive investment decision, before issuing a term sheet.

### Protocol

1. **Frame:** "It's 2031. We wrote down our entire investment in [Company] to zero. What happened?" Not "what could go wrong" — what *did* go wrong. Past tense forces specificity.

2. **Independent narratives:** Each agent writes a 3-5 sentence failure story independently. No anchoring on others' stories.

3. **Categorize failures:**
   - Market: The market didn't materialize, shrank, or was captured by an adjacent player
   - Execution: The team couldn't build, sell, or scale
   - Financial: Ran out of money, couldn't raise follow-on, unit economics never worked
   - Competitive: A better-funded or better-positioned competitor won
   - Team: Founders split, key hires left, culture collapsed
   - External: Regulation, recession, technology shift, black swan

4. **Find convergence:** If 3+ agents independently wrote the same failure mode, it's a high-confidence risk. If only one agent found it, it's either a niche concern or a blind spot the others missed — investigate.

5. **Convert to protections:**
   - **Deal terms:** Information rights, board seat, protective provisions, milestone tranching
   - **Monitoring triggers:** What metric, if it deteriorates by X%, triggers a portfolio review?
   - **Intervention plan:** If the failure mode starts emerging, what do we do? Follow-on? Bridge? Recruit a new executive? Force a pivot?

### Output

Deliver as: "The three most likely paths to zero are [1], [2], [3]. For each, here is the early warning signal, the protection we can build into the deal, and the intervention plan if it starts to happen."
