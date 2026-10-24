---
name: legal-due-diligence
description: >
  Examines startup legal exposure including cap table cleanliness, IP ownership, litigation,
  employment agreements, regulatory compliance, and open-source license risk. Surfaces issues
  that kill deals in late diligence early enough to factor into the investment decision.
  Used primarily by the Legal & IP Due Diligence agent.
---

# Legal Due Diligence Skill

## When to Use

On every deal where legal risk is material: IP-heavy deals, healthtech, fintech, any regulatory-sensitive sector, and any deal with a complex cap table history. Lighter-touch for clean SaaS with straightforward structures.

---

## Legal Due Diligence Protocol

### Step 1 — Cap Table Audit

**What to verify:**

| Item | Check For | Red Flag |
|---|---|---|
| **Equity ownership** | Clean records, proper documentation, all grants properly issued | Missing paperwork, verbal agreements, undocumented equity promises |
| **Outstanding convertibles** | All SAFEs, notes, and warrants documented with clear conversion terms | Multiple SAFEs at different caps creating cap table confusion |
| **Option pool** | Adequate for next 18-24 months of hiring (~10-15% post-round) | Pool nearly depleted, or no pool established |
| **409A valuation** | Current (within 12 months). Required for option grants. | Expired 409A, no 409A ever done, options granted without one |
| **Founder vesting** | Standard 4-year vesting with 1-year cliff. Ideally with acceleration provisions. | No vesting (founders fully vested from day one — misaligned incentives) |
| **Dead equity** | Departed founders/employees holding significant equity with no vesting | >10% of equity held by people no longer contributing |
| **Previous investors** | Clean terms, no unusual rights, no blocking provisions | Prior investors with veto rights over new fundraising or exits |

### Step 2 — IP Ownership Chain

**Critical questions:**

1. **Assignment agreements:** Has every founder, employee, and contractor signed an IP assignment agreement that assigns all work product to the company?
2. **Prior employer IP:** Did any founder develop core technology while employed elsewhere? Could a prior employer claim ownership?
3. **University IP:** Was the technology developed at a university? Is there a license agreement? Is it exclusive?
4. **Open-source contamination:** Does the product use copyleft-licensed open-source software (GPL, AGPL) that could require the product itself to be open-sourced? Review the open-source bill of materials.
5. **Patent landscape:** Has a freedom-to-operate (FTO) search been conducted? Are there existing patents that could block the company?

### Step 3 — Litigation and Claims Review

- Active lawsuits (any party — plaintiff or defendant)
- Threatened litigation (cease-and-desist letters, demand letters)
- Regulatory investigations or inquiries
- Patent infringement claims or risks
- Employment disputes (wrongful termination, discrimination, wage claims)
- Customer disputes or contract breaches

**The clean room test:** If an acquirer's legal team reviewed this company tomorrow, what would they find?

### Step 4 — Employment and Contractor Review

| Item | Check For |
|---|---|
| **Employee classification** | Are all workers properly classified (employee vs. contractor)? Misclassification creates tax and legal liability. |
| **Non-competes** | Do founders or key employees have non-compete agreements from prior employers that could restrict the business? |
| **Invention assignment** | Do all employees and contractors have invention assignment agreements? |
| **Key person dependency** | Are there key employees whose departure would create legal or operational risk? |
| **International workers** | If hiring internationally, are employment laws in each jurisdiction being followed? |

### Step 5 — Regulatory Compliance Scan

| Sector | Key Regulations | What to Verify |
|---|---|---|
| **Healthtech** | HIPAA, FDA, state medical practice laws | BAAs (Business Associate Agreements) in place, FDA pathway identified, data handling compliant |
| **Fintech** | State money transmitter, AML/KYC, SEC/FINRA | Licenses obtained or in process, compliance program documented, legal opinion on regulatory status |
| **Data/AI** | GDPR, CCPA, AI-specific regulation, biometric data laws | Privacy policy current, data processing agreements in place, consent mechanisms working |
| **Edtech** | FERPA (Family Educational Rights and Privacy Act), COPPA, state student privacy laws | Student data handling compliant, parental consent where required |
| **Any sector** | SOC 2, data breach notification laws | Security practices documented, incident response plan exists |

### Step 6 — Corporate Formation Review

- Proper incorporation (Delaware C-Corp is standard for VC-backed companies)
- Board properly constituted with documented resolutions
- Bylaws current and not unusual
- All prior fundraising properly authorized and documented
- Good standing in all jurisdictions where the company operates

---

## Severity Assessment

| Finding | Severity | Action |
|---|---|---|
| Missing IP assignment from founder | **Deal-threatening** | Must be resolved before investment |
| Outstanding litigation from prior employer | **Deal-threatening** | Legal opinion required on risk |
| Missing 409A | **Manageable** | Condition of closing |
| Expired HIPAA BAA | **Manageable** | Fix post-investment, document in side letter |
| Minor cap table cleanup needed | **Manageable** | Fix as condition of closing |
| Active patent infringement claim | **Potentially deal-threatening** | Legal opinion on merits and exposure |

---

## References & Templates

| File | Content |
|---|---|
| `references/legal-checklist.md` | Comprehensive legal DD checklist by category |
| `references/regulatory-landscape.md` | Sector-specific regulatory requirements |
| `templates/legal-assessment.md` | Legal DD output template |
