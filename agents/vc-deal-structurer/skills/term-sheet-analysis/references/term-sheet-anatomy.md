# Term Sheet Anatomy

## Purpose

Detailed explanation of every major clause in a venture capital term sheet, with investor-favorable vs. founder-favorable positions and market-standard terms.

---

## Economic Terms

### Valuation

**Pre-money valuation:** The company's value before the investment. The investor's ownership percentage = Investment / (Pre-money + Investment).

**Post-money valuation:** Pre-money + Investment. More intuitive for calculating ownership.

**Option pool shuffle:** When the option pool is included in the pre-money valuation, it effectively reduces the founder's price per share while the investor pays the post-money price. A 15% option pool in a $10M pre-money means founders are effectively valued at $8.5M.

| Position | Founder-Favorable | Standard | Investor-Favorable |
|---|---|---|---|
| Option pool | Post-money inclusion | Pre-money, 10% | Pre-money, 15-20% |

### Liquidation Preference

Controls who gets paid first when the company is sold.

**1x non-participating:** Investor gets back 1x their investment OR converts to common (whichever is greater). This is standard and fair — the investor is protected from downside while sharing upside.

**1x participating ("double dip"):** Investor gets back 1x their investment AND participates in remaining proceeds as common. Significantly more investor-favorable — reduces common shareholder returns at all exit values.

**Multiple (2x, 3x) preference:** Investor gets back 2x or 3x their investment before common shareholders see anything. Extremely aggressive; typically only seen in down rounds or distressed situations.

| Position | Founder-Favorable | Standard | Investor-Favorable |
|---|---|---|---|
| Preference | 1x non-participating | 1x non-participating | 1x+ participating |

**Participation cap:** A compromise — participating preferred with a cap (e.g., 3x). After the cap, the investor must convert to common.

### Anti-Dilution Protection

Protects investors if the company raises a future round at a lower valuation (a "down round").

**Broad-based weighted average (BBWA):** Adjusts the conversion price based on the size and price of the down round relative to all outstanding shares. Standard and fair.

**Narrow-based weighted average (NBWA):** Same calculation but uses a smaller denominator, resulting in more aggressive adjustment. More investor-favorable.

**Full ratchet:** Adjusts the conversion price to the new lower price regardless of the size of the down round. Extremely punitive to founders and early investors. Rarely used except in distressed situations.

| Position | Founder-Favorable | Standard | Investor-Favorable |
|---|---|---|---|
| Anti-dilution | None (rare) | BBWA | Full ratchet |

### Dividends

**Non-cumulative:** Dividends only when declared by the board. Standard for VC — rarely declared.

**Cumulative:** Dividends accrue whether or not declared. Effectively increases the liquidation preference over time (typically 6-8% annually). More common in later-stage or PE-style deals.

---

## Governance Terms

### Board Composition

**Common structures:**
- 2 founders + 1 investor + 0-2 independent = founder-controlled
- 2 founders + 2 investors + 1 independent = balanced
- 1 founder + 2 investors + 2 independent = investor-influenced

**Board observer rights:** Investors without a board seat may request observer status (attend meetings, receive materials, but no vote). Standard.

### Protective Provisions

Actions requiring investor approval (typically majority of preferred shareholders):
- Issuing new equity or creating new share classes
- Selling or merging the company
- Taking on debt above a threshold
- Changing the certificate of incorporation
- Increasing the option pool
- Paying dividends
- Changing board size

**Standard scope:** Major structural decisions. **Overreach:** Requiring approval for operating decisions (hiring, spending, pricing).

### Drag-Along Rights

Allows a specified majority to force all shareholders to approve a sale. Prevents minority shareholders from blocking an acquisition.

**Standard threshold:** Majority of preferred + majority of common, or a supermajority (66-75%) of all shares.

---

## Investor Rights

### Pro-Rata Rights

Right to invest in future rounds to maintain ownership percentage. Critical for early-stage investors — without pro-rata, ownership is diluted with each round.

**Super pro-rata:** Right to invest more than their pro-rata share. Aggressive but sometimes negotiated by high-conviction investors.

### Information Rights

Standard package: monthly financials, annual budget, annual audited financials, board meeting materials. Larger investors may request weekly metrics dashboards.

### Registration Rights

**Demand registration:** Investors can force the company to file for IPO registration (after a certain period, typically 3-5 years post-investment).

**Piggyback registration:** If the company files for an IPO, investors can include their shares. Standard.

**S-3 registration:** Simplified registration after the company is public. Standard.

---

## SAFE (Simple Agreement for Future Equity) Terms

### Post-Money SAFE (Y Combinator standard)

The valuation cap is a post-money cap, meaning the ownership is calculable immediately: Ownership = Investment / Valuation Cap. Simpler but can create confusion when multiple SAFEs stack.

### Pre-Money SAFE

Less common since YC switched to post-money. Ownership depends on how much total capital is raised, making it unpredictable.

### Key SAFE Terms

**Valuation cap:** Maximum price at which the SAFE converts. Lower cap = more investor-friendly.

**Discount:** Percentage discount to the next round's price. Typically 15-25%.

**MFN (Most Favored Nation):** If the company issues SAFEs with better terms later, earlier SAFE holders automatically get those better terms. Protects early SAFE investors.

**Pro-rata side letter:** Grants SAFE holders the right to invest pro-rata in the priced round. Increasingly standard.

---

## Convertible Note Terms

### Interest Rate

Convertible notes accrue interest (typically 4-8%), which increases the principal amount that converts into equity. Higher interest = more investor-friendly.

### Maturity Date

Date by which the note must convert or be repaid (typically 18-24 months). If the company hasn't raised a priced round by maturity, the investor can technically demand repayment — but this rarely happens in practice because the company doesn't have the cash.

### Conversion Triggers

**Qualified financing:** The note automatically converts when the company raises a priced round above a specified threshold (typically $1M+).

**Change of control:** If the company is acquired before conversion, the note converts at the cap or is repaid at 1-2x the principal.

**Maturity conversion:** If the note matures without a qualified financing, it typically converts at the cap (or a negotiated discount).
