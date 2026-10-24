---
name: crypto-social-signal-scouting
description: >
  Structured scan of named crypto social and launch sources (Crypto Twitter/X, Reddit crypto subs, Farcaster, Discord and Telegram community summaries, DEX launch and trending trackers, GitHub) to extract early-stage token candidates with links, timestamps, traction indicators, and a four-axis score. Use when asked what is hot, to find early tokens, what people are talking about in crypto, or when running a scheduled discovery scan for the speculative sleeve.
---

# Crypto Social Signal Scouting

A repeatable scan that turns social noise into a short, evidence-linked candidate list. The output of this skill is always unverified and must pass `shill-and-bot-detection` before it is scored or handed on.

## When this skill triggers

- The brief says 'what is hot', 'find early tokens', 'what are people talking about', 'anything new on-chain', or names a narrative and asks what is emerging inside it.
- A scheduled discovery scan is requested.
- A single named token is presented and the board wants to know whether its traction is real.

## Named source list and scan order

Scan in this order so that on-chain and developer signal is captured before social volume biases judgement.

| Order | Source type | What to extract | Signal strength |
| --- | --- | --- | --- |
| 1 | GitHub and public repos | Substantive changes, repository origin, contributor identity, releases, deployments, forks vs original code | Useful only after checking that activity is substantive and tied to the claimed product |
| 2 | DEX launch and trending trackers | New pairs, liquidity depth, holder count trend, age of pair, tracker ranking | Medium — volume can be bought |
| 3 | Farcaster channels | Builder discussion, technical questions, unaffiliated mentions | Potentially useful; independence still requires evidence |
| 4 | Reddit crypto subs | Organic threads, critical comments, mod-flagged promotion | Medium — moderated but brigadable |
| 5 | Crypto Twitter/X | Who is posting, account age and tenure, independence of posters, ratio of critique to hype | Weak alone, strong when independent |
| 6 | Discord and Telegram community summaries | Substance of discussion, presence of criticism, dev responsiveness | Weak — member counts are meaningless |

If a source type could not be reached, note the gap once in the report. Do not fill the gap with assumptions.

## Inclusion rule

As a board screening policy, a token becomes a candidate only if it shows traction on **at least two independent source types**, and at least one is a public repository, on-chain or DEX evidence, or a technically substantive community. This threshold narrows the scouting queue; it does not establish legitimacy, quality, or investability. Social-only traction is recorded but does not qualify without corroboration.

## Candidate extraction record

Capture every field. Missing fields are reported as missing, not guessed.

```markdown
### [TICKER] — UNVERIFIED
- **Chain / contract:** [chain], [address or 'not found']
- **What it is:** [one plain-language sentence]
- **First observed traction:** [date] via [source] — [link]
- **Traction indicators (claimed):**
  - [indicator] — [source] — [timestamp] — [link]
  - ...
- **Developer activity:** [commit cadence, contributors, last release] — [link]
- **Community texture:** [criticism present? technical questions? dev responses?]
- **Narrative fit:** [which live narrative, and whether the project delivers on it or borrows vocabulary]
- **Supply and liquidity picture (claimed):** [top-holder concentration, liquidity lock status, pair age]
```

## Four-axis scoring

Score each axis 0–5. Report axes separately; a combined score is for ranking only. Manipulation risk from `shill-and-bot-detection` is reported alongside, never folded into these axes.

| Axis | 0 | 3 | 5 |
| --- | --- | --- | --- |
| Organic buzz | Mentions only from new or affiliated accounts | Mixed, some independent long-tenured voices | Many independent, long-tenured, unaffiliated voices across source types |
| Developer activity | No repo or dormant for 30+ days | Active but single contributor or forked with light changes | Multi-contributor, sustained cadence, original code, recent releases |
| Community quality | Only price talk, no criticism tolerated | Some technical discussion, moderate critique | Substantive debate, criticism answered by devs, users describing real usage |
| Narrative fit | No live narrative or vocabulary-only borrowing | Fits a live narrative partially | Fits a live narrative and demonstrably delivers on it |

## Shortlist rule

Deliver three to five candidates. If fewer than three survive screening, deliver fewer and say so. Never pad with candidates that failed the inclusion rule.

## Handoff routing

For each candidate state explicitly:

- **For crypto-token-diligence-analyst:** the contract, liquidity, team, and holder items that need the checklist audit.
- **For crypto-risk-compliance-analyst:** the link, identity, permission, custody, scam, and jurisdiction questions that need the mandatory safety screen.
- **For web-researcher:** each claimed indicator that needs dated verification (prices, volumes, holder counts, launch dates, team identities).
- **For contrarian:** the narrative assumption most likely to be attacked.

## Anti-patterns

- Ranking by mention count.
- Treating trending-tracker placement as traction.
- Reporting member counts for Discord or Telegram.
- Presenting any claimed number without a link and timestamp.
- Treating an unavailable repository or on-chain source as a pass instead of recording the coverage gap.
