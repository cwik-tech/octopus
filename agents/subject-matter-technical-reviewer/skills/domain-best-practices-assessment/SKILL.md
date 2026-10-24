---
name: domain-best-practices-assessment
description: >
  Evaluate whether examples, explanations, and guidance follow established best
  practices and conventions in the subject field. Use when reviewing code patterns,
  procedural workflows, terminology usage, tool recommendations, or domain-specific
  guidance to ensure they reflect current professional standards and will set
  learners up for success in the field.
---

# Domain Best Practices Assessment

## Purpose

Evaluate whether teaching examples and guidance align with current best practices in the field. This is different from accuracy (something can be correct but outdated, or correct but suboptimal). Best practices assessment ensures learners are set up to succeed with approaches and patterns that professionals use today.

## When to Use This Skill

Apply this skill when the manual includes **examples, code patterns, tools, terminology, methodologies, or normative guidance:**

- **Code style and patterns:** Does a Python example use PEP 8 conventions? Does a JavaScript example follow current idioms? Are design patterns appropriate for the learner level?
- **Tool selection:** Does the manual recommend current, well-maintained tools? Are deprecated tools still presented as standard?
- **Methodology:** Does a research or scientific procedure follow current best-practice workflows? Are there newer, more efficient approaches?
- **Terminology and naming conventions:** Are professional naming standards used? Are terms used as the field uses them?
- **Performance and optimization:** Are efficiency considerations aligned with current priorities?
- **Safety and security practices:** For domains that require it, are security best practices modeled correctly?

## Evaluation by Domain

### Programming and Software Development

- **Code style:** Does it follow the language's style guide (PEP 8 for Python, prettier for JavaScript, etc.)?
- **Design patterns:** Are patterns used appropriately for the learner level? Avoid teaching advanced patterns to beginners, and avoid teaching anti-patterns to any level.
- **Testing:** Is test-driven development or testing practices shown? Are unit tests written for examples?
- **Deprecation:** Are deprecated APIs or libraries highlighted as such? Does the manual recommend their modern replacements?
- **Performance:** Is optimization guidance realistic? Beginners should prioritize readability; advanced learners should understand trade-offs.
- **Error handling:** Are exceptions/errors handled properly, or are they glossed over?
- **Dependencies:** Are external libraries chosen wisely? Are lightweight alternatives noted where relevant?

### Scientific and Technical Procedures

- **Methodology:** Is the procedure the current gold standard, or is there a more efficient/accurate approach now?
- **Safety standards:** Do procedures follow current safety regulations and best practices?
- **Instrument calibration and validation:** Are best practices for setup and validation included?
- **Documentation:** Are results documented in a way that aligns with current field practice?
- **Reproducibility:** Could another practitioner replicate the procedure and get similar results?

### Writing and Communication Domains

- **Citation and sourcing:** Are modern citation standards used (APA, Chicago, MLA as appropriate)?
- **Inclusive language:** Does terminology align with current professional standards?
- **Structure and organization:** Do outlines and structures follow current best practices for the genre?

### Business and Professional Domains

- **Frameworks and methodologies:** Are recommended frameworks current? Are deprecated approaches flagged as historical?
- **Terminology:** Are terms used as the industry currently uses them?
- **Case studies and examples:** Are they recent enough to be relevant?

## Assessment Workflow

1. **Identify examples and normative statements** in the manual. What practices or patterns does it teach as "the right way"?
2. **Establish current best practice for each domain.** What do practitioners currently recommend? What has changed in the last 2-3 years?
3. **Compare manual guidance to current practice:**
   - **Aligned:** Example follows current best practice.
   - **Outdated:** Example follows previous-generation best practice. Still correct, but learners should know the newer approach exists.
   - **Suboptimal:** Example is correct but uses a less-efficient or less-maintainable pattern.
   - **Deprecated:** Example uses a tool, API, or approach that is no longer maintained or recommended.
   - **Advanced for level:** Example uses best practices for a more advanced level than the manual targets.
4. **Assess learner-level appropriateness.**
   - Beginners: Prioritize clarity and correctness. Advanced patterns can distract.
   - Intermediate: Can introduce patterns and trade-offs. Should know the "right" way exists even if simplified version is taught.
   - Advanced: Should learn current professional standards.
5. **Document findings:** What is taught, Current status, Recommendation.

## Common Best-Practices Issues

- **Teaching outdated tools or languages:** Python 2.7 idioms, jQuery as the standard approach, Flash in design manuals.
- **Skipping error handling:** Examples that don't show what happens when things go wrong.
- **Inefficient patterns:** Code that works but uses inefficient algorithms when better alternatives are standard.
- **Missing security considerations:** Examples that ignore authentication, data validation, or injection vulnerabilities.
- **Outdated terminology:** Using old names for concepts or tools that have been renamed.
- **Anti-patterns presented as normal:** Teaching singleton patterns when dependency injection is standard, mutable global state, tight coupling.
- **Learner-level misalignment:** Teaching advanced patterns to beginners, or oversimplifying concepts for advanced learners.

## Decision Rules

- **If a practice is current best practice:** Approve. Recommend highlighting why this approach is good.
- **If a practice is outdated but not wrong:** Flag as a WARNING. Recommend adding context: "This approach is correct but has been superseded by [newer approach]." Learners should know the alternative exists.
- **If a practice is suboptimal for the learner level:** Flag as a SUGGESTION. Recommend showing the trade-off or a note that this is a teaching simplification.
- **If a tool or API is deprecated:** Flag as a BLOCKER. Recommend updating to current alternatives or clearly framing as historical.
- **If a practice teaches an anti-pattern:** Flag as a BLOCKER. Teaching bad habits is worse than teaching no habits.
- **If you're unsure whether a practice is current:** Caveat your review. Recommend checking with domain experts or current references.

## Alignment Check: Learner Level

- **Beginner:** Prioritize clear, simple examples over advanced patterns. One right way is better than multiple trade-offs.
- **Intermediate:** Can introduce patterns, trade-offs, and "when to use X vs. Y." Should reference advanced techniques even if not teaching them.
- **Advanced:** Should learn what professionals use now. Include trade-offs, performance considerations, and evolution of the practice.

## Red Lines

- Never recommend deprecated tools as standard without clear framing.
- Never teach anti-patterns, even if they're simpler to explain.
- Never skip security, error handling, or safety considerations just to simplify the example.
- Never present a learner-level-inappropriate pattern without noting it's for a different audience.
