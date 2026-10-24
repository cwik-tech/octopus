---
name: meeting-minutes-synthesis
description: >
  Defines the board-record contract for venture-capital discussions so the
  minutes artifact stays distinct from the final investment memo.
---

# Meeting Minutes Synthesis Skill

## When to Use

Use this to calibrate what `output/minutes.md` represents in the VC team.

## Minutes Contract

The minutes artifact is the formal board record. It must:

- begin with a short overview of the company or opportunity being evaluated
- name the discussion participants near the top of the document
- preserve the round-by-round discussion
- preserve individual agent positions
- preserve disagreement and convergence
- remain separate from the final investment memo

The minutes artifact is not the place to collapse the board into a single recommendation narrative. That happens in `output/investment-memo.md`.

## Template

Reference `templates/minutes.md` for the intended meaning of the minutes artifact:

- title it as meeting minutes
- include an opening evaluation overview
- include a participant roster
- preserve transcript fidelity
- keep the file auditable and easy to scan

## Separation Rule

- `output/minutes.md`: transcript-quality board record
- `output/investment-memo.md`: synthesized committee decision document
