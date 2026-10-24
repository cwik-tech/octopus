---
name: shill-and-bot-detection
description: >
  Detect coordinated promotion, paid influencer campaigns, fake volume, recycled or farmed account patterns, and pump-and-dump setups behind a crypto token's apparent traction, and assign a manipulation-risk grade. Use on every scouting output before scoring is final, whenever a token's buzz appears suddenly or seems too uniform, or when the board asks whether hype around a token is organic.
---

# Shill and Bot Detection

A mandatory screen that runs on every candidate produced by `crypto-social-signal-scouting`. Its job is to separate attention that was earned from attention that was bought, and to grade the risk so the board never sees a candidate without it.

## When this skill triggers

- Every scouting output, without exception, before any four-axis score is final.
- Any candidate whose mention volume rose sharply inside the review window; 48 hours is a useful short-window comparison, not a universal cutoff.
- Any request to judge whether a token's hype is real, whether a campaign is paid, or whether a setup looks like a pump.

## Manipulation pattern catalogue

Check each pattern. Record which are present with evidence links.

| Pattern | What it looks like | Tell-tale evidence |
| --- | --- | --- |
| Coordinated posting | Many accounts posting near-identical phrasing, hashtags, or images within a short window | Shared templates, synchronized timestamps, identical link shorteners |
| Paid influencer campaign | Mid-to-large accounts endorsing without disclosure, often in a cluster | Same accounts promoting prior tokens that collapsed; sudden interest with no prior domain engagement; deleted posts after price moves |
| Recycled or farmed accounts | Accounts with recent creation dates, low tenure, follow-for-follow graphs, or histories of promoting serial launches | Account age, handle changes, prior promoted tickers, engagement-to-follower ratios |
| Fake volume | Volume far exceeding liquidity depth, wash-trading loops, round-number trades, bot-like cadence | Volume-to-liquidity ratio, repeated wallet pairs, trades at fixed intervals |
| Engineered scarcity or urgency | 'Last chance', countdowns, presale FOMO, whitelist pressure | Language patterns, unsourced supply claims |
| Pump-and-dump setup | Concentrated supply, unlocked liquidity, team wallets positioned to exit, promo spike timed to unlock or listing | Top-holder concentration, liquidity lock status, unlock schedule, promo timing |
| Astroturfed community | Discord or Telegram with high member counts but shallow discussion, banned critics, dev silence | Ratio of substantive to price messages, moderation behaviour, unanswered technical questions |
| Narrative hijack | Project adopts a hot narrative's vocabulary with no matching product or code | Repo contents vs marketing claims, timing of rebrand relative to narrative surge |

## Independence test

For the accounts driving attention, ask:

1. Do they share creation windows, follower graphs, or prior promoted tickers?
2. Did they engage with this domain before this token appeared?
3. Do they disclose affiliation, allocation, or payment?
4. Do they post criticism of anything, ever?

If most driving accounts fail two or more of these, treat the buzz as non-organic regardless of volume.

## Manipulation-risk grade

| Grade | Criteria | Action |
| --- | --- | --- |
| LOW | No catalogue patterns beyond incidental noise; driving accounts pass the independence test; volume consistent with liquidity | Score normally; hand to diligence |
| MEDIUM | One or two patterns present, or independence test mixed; organic root still identifiable | Score normally; flag the specific patterns for `crypto-token-diligence-analyst` and `contrarian` |
| HIGH | Three or more patterns, or a pump-and-dump setup, or no organic root identifiable | Exclude from the shortlist; record in the exclusions section with evidence |

A manipulation grade is a screening assessment, not proof of coordination or fraud. A HIGH grade is not overridden by developer activity or narrative fit. An excluded candidate may be re-scouted later if its evidence changes.

## Output block

Attach to every candidate card:

```markdown
**Manipulation risk:** [LOW / MEDIUM / HIGH]
- Patterns present: [list, or 'none detected']
- Evidence: [link — what it shows — timestamp]
- Independence test: [pass / mixed / fail] — [one line why]
- Note for diligence and contrarian: [what to attack or verify first]
```

## Anti-patterns

- Grading LOW because the poster is famous.
- Grading LOW because the code is real; real code can still be pumped.
- Skipping the screen on a candidate the board already likes.
- Treating absence of evidence as absence of manipulation when a source type was unreachable — state the gap and grade conservatively.
- Presenting the grade as a verdict on the project rather than on its current attention.
