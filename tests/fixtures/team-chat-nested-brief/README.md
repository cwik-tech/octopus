# Nested team-chat brief fixture

`turn-2-incoming-brief.md` is the verbatim `incoming-brief.md` from turn 2 of session
`b8e6afd8-e22e-4f0a-817c-b4a22ca5c7fc` ("CLI Tutorial Class Content Review"), the run that failed
with `Discussion lead returned an invalid roster selection: response is not valid JSON`.

It is the smallest complete reproduction of the brief-nesting bug fixed in Phase 1 of the
retired Team Chat reliability plan
(`git show babda906^:docs/2026-09-06-Team-Chat-Reliability-And-Continuation-Plan.md`):

- Line 18 — the real `# Current user message` ("can you edit these files actually?")
- Line 27 — `Previous user message:` opening a nested copy of turn 1's whole rendered brief,
  capped at `MAX_REPLY_CHARACTERS` (1,200) and cut mid-word at `` and `cl ``
- Line 31 — the nested `## User Brief` heading that truncates `extractMarkdownSection`
- Lines 44 and 243 — two `## Uploaded File Context` headings

Do not reformat it. Its exact heading positions are what the tests assert against.
