---
name: occasion-brief-locking
description: Lock the occasion, honoree, speaker, audience, delivery mode, length limit, tone, and sensitivities into a single Brief Lock before any occasional poem is drafted. Use when taking in a request for a wedding, eulogy, birthday, retirement, toast, anniversary, or gift poem, or when new facts change the occasion, audience, or delivery constraints.
---

# Occasion Brief Locking

Occasional poems fail most often because the brief was misread. The poem might be too long for the toast, too intimate for the crowd, or too jokey for the grief in the room. The Brief Lock is the single source of truth every downstream agent works from.

## Brief Lock Fields

| Field | Critical | What to capture |
|---|---|---|
| Occasion | Yes | Type and specifics, such as a 40th anniversary or a retirement after 32 years of teaching |
| Honoree(s) | Yes | Name(s) to use in the poem, including preferred nicknames |
| Speaker / giver | Yes | Who delivers or gives the poem, and their relationship to the honoree |
| Audience | Yes | Who hears or reads it; a private or public setting; approximate size |
| Delivery mode | Yes | Read aloud at a ceremony, toast, eulogy, printed card, framed keepsake, or a combination |
| Length limit | Yes | Seconds of speaking time, or lines and words for print |
| Tone | Yes | Primary register plus any allowed secondary register, such as tender with light humor |
| Sensitivities | Yes | Topics, people, or facts that must not appear |
| Must-include | No | Required names, phrases, dates, or references |
| Rhyme preference | No | Rhymed, unrhymed, or no preference |
| Date / deadline | No | When the poem is needed |

## Delivery Mode Limits

Spoken poems run at roughly 120 to 140 words per minute once pauses are included.

| Mode | Typical limit | Constraints |
|---|---|---|
| Toast | 45 to 120 seconds, about 100 to 250 words | Noisy room; must end on a raise-your-glass line; short lines; no fragile enjambment |
| Ceremony reading | 1 to 3 minutes | Formal register; clear cadence; audience of mixed ages and relations |
| Eulogy poem | 1 to 3 minutes | Speaker may be overcome; avoid tongue-twisting lines; rhyme optional; no forced cheer |
| Printed card | 4 to 16 lines | Read silently, often once; the first and last lines carry the weight |
| Framed keepsake | 12 to 30 lines | Reread for years; avoid time-bound jokes and references that date quickly |

## Occasion Defaults

Apply these defaults unless the requester says otherwise, and record them as assumptions.

| Occasion | Default tone | Common pitfalls |
|---|---|---|
| Wedding | Warm, celebratory, forward-looking | Past relationships, in-jokes the room cannot follow, overlong reading |
| Eulogy | Tender, honest, grateful | Cause of death, family conflict, platitudes about better places without consent |
| Birthday | Affectionate, playful | Age jokes the honoree dislikes, milestone gloom |
| Retirement | Grateful, lightly humorous | Workplace politics, implying the person is old or done |
| Anniversary | Intimate, reflective | Private details unsuitable for a public reading |
| Gift | Personal, lasting | Generic sentiment that could be for anyone |

## Procedure

1. Extract every field already stated in the request.
2. List the missing critical fields.
3. Ask the requester at most five questions, ordered by impact. Always prioritize delivery mode, length, and sensitivities.
4. If you must proceed without answers, fill each gap with the occasion default and mark it `ASSUMED`.
5. Re-open the Brief Lock whenever a later stage surfaces a fact that contradicts it. Notify every downstream agent of the change.

## Output

Return the Brief Lock as a table with columns Field, Value, and Status. Status is `CONFIRMED`, `ASSUMED`, or `MISSING`. Drafting may not begin while any critical field is `MISSING`.
