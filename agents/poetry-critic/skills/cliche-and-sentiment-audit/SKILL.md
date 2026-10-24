---
name: cliche-and-sentiment-audit
description: Line-by-line audit of an occasional poem for greeting-card clichés, forced or padded rhymes, abstraction drift, and declared but unearned sentiment, with targeted fixes grounded in the requester's personal details. Use when reviewing a draft wedding, eulogy, birthday, retirement, toast, anniversary, or gift poem for generic phrasing, rhyme quality, or sentimentality.
---

# Cliché and Sentiment Audit

Occasional poems fail most often by sounding like every other poem written for the same occasion. This audit finds the lines that belong to no one and the feelings the poem announces without earning.

## Inputs

- The draft poem
- The interviewer's detail brief (names, stories, objects, places, inside jokes)
- The form specification (meter, rhyme scheme)

## Procedure

### 1. Swap Test (every line)

Mentally replace the honoree's name and details with a stranger's. Mark each line with one of three labels:

- **Owned:** only works for this person. Keep it.
- **Neutral:** connective or structural and fine in small doses.
- **Generic:** would fit any card for this occasion. Flag it.

More than roughly one third generic lines is a WARNING at poem level. A generic opening or closing line is always flagged.

### 2. Stock-phrase scan

Flag known greeting-card phrasing by occasion:

- **Wedding / anniversary:** two hearts become one, happily ever after, soulmate, journey together, hand in hand, forevermore
- **Eulogy / memorial:** in a better place, gone but not forgotten, forever in our hearts, watching from above, angel gained its wings
- **Birthday:** another trip around the sun, young at heart, only getting better, over the hill
- **Retirement:** well-earned rest, next chapter, time to relax, golden years
- **General:** from the bottom of my heart, words cannot express, means the world, shining star, special someone

These are signals, not bans. A stock phrase that is deliberately subverted or tied to a specific detail can pass.

### 3. Rhyme receipt

For each rhyme pair, check four things:

1. **Inversion.** Did the syntax invert to put the rhyme word last ('my love for you I will pursue')?
2. **Padding.** Is there filler added only for the sound or the syllable count ('indeed', 'so true', 'up above', 'every day')?
3. **Weak word choice.** Is the rhyme word the weakest word in the line, chosen from a narrow set (love/above, heart/apart, day/way, you/true)?
4. **Predictability.** Would a listener predict the rhyme word two beats early? If so, it risks unintended comedy.

Flag any failure as a WARNING. Escalate to BLOCKING if the forced rhyme lands on the poem's emotional peak or final line.

### 4. Abstraction drift

Track the ratio of concrete nouns (objects, places, actions, sensory details) to abstractions (love, joy, strength, memories, spirit). Flag any stanza where abstractions outnumber concrete nouns. Flag any stretch of three or more lines with no concrete image. Point to a specific item in the detail brief that could anchor the stanza.

### 5. Earned-sentiment check

Find every line that names an emotion directly. For each one, ask whether an earlier image or story has already produced that feeling in the listener.

- **Yes:** the line is earned and can stay.
- **No:** flag it as unearned sentiment. Suggest moving a concrete detail in front of it or cutting the declaration so the image carries the feeling.

## Output

For each issue, give:

- The quoted line
- The category (Cliché, Padded rhyme, Abstraction drift, Unearned sentiment)
- A severity
- A targeted fix

Where possible, the fix should reference a real detail from the brief. Never invent personal facts. If the brief lacks a usable detail, list the question to send back to the interviewer. Also list the lines that pass the Swap Test cleanly so the revision protects them.
