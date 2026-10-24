# Source Method Template (per-video)

Use this template for every `write_methodology` call. One file per source
video, named `output/methods/<videoId>.md`. Replace `[bracketed]` placeholders
with content drawn strictly from that video's transcript. Mark every
interpretive claim with one of the four evidence labels defined in
`references/extraction-contract.md` so the consolidated playbook can distinguish
source-backed rules from agent synthesis.

```
---
video_id: [videoId]
video_url: [https://www.youtube.com/watch?v=<videoId>]
title: [transcript title]
channel: [channel name or —]
language: [transcript language code]
captured_at: [ISO 8601 timestamp]
capture_method: [direct | webshare | authenticated | browser]
---

# Source Method: [title]

## Outcome and intended use

[1–3 sentences on what this method produces and the situations it is meant for. Cite the transcript with a timestamp link.]

## Source states
- [Direct claim from the transcript, attributed with a `[HH:MM:SS]`](timestamp) link. One bullet per discrete claim.]

## Source demonstrates
- [An example shown or narrated by the speaker, with a timestamp link.]

## Prerequisites and required inputs
- [Required tools, data, prior steps, or conditions the speaker names as necessary before starting.]

## Ordered procedure
1. [Step, with a timestamp link to where the speaker describes it.]
2. [Step.]
3. [Step.]

### Decision points
- **At [step / trigger]:** if [condition], then [branch]. Otherwise [branch]. [Timestamp link.]

## Named tools, templates, and measurements
- [Concrete artifacts the speaker names — tools, frameworks, metrics, thresholds — exactly as phrased.]

## Examples and evidence
- [Worked example from the transcript, with the timestamp range it spans.]

## Failure modes, constraints, and caveats
- [Failure condition the speaker calls out, with a timestamp link.]
- [Explicit limitation or boundary on when the method does not apply.]

## Interpretation
- [Agent inference not explicitly stated by the speaker. Mark clearly as interpretation; never blend with source-backed claims.]

## Unresolved
- [Question the transcript raises but does not answer. Do not fill gaps with general knowledge.]
```

## Notes for the agent

- Persist the filled template via `write_methodology` with `videoId` set to the source video's ID. The runtime writes it to `output/methods/<videoId>.md`.
- Every material claim must carry an evidence label. If a section has no source-backed content, write `— none identified —` rather than inventing content.
- Timestamps link to the video as `[MM:SS](https://www.youtube.com/watch?v=<videoId>&t=<seconds>s)`. Use `[HH:MM:SS]` for videos over an hour.
- Do not collapse multiple videos into one method file. One source video → one method file.
