# Business workflow: let Agents talk to each other

## Scope and starting conditions

A dialogue started in one desktop window is discovered by other already-open
views of the same session. Starts and terminal changes invalidate those views;
the existing dialogue event stream supplies replies. See [MW-06](multi-window.md)
and `tests/electron/multi-window-dialogue.spec.ts`.

See [the Agent dialogue guide](../feature-agent-dialogue.md) for usage and limits.

A person starts a dialogue in a normal Octopus chat, either by selecting
Agents and a chat mode or by making an explicit request through Model Context
Protocol (MCP). Manual starts always use text delivery. Connecting through MCP
alone does not select dialogue mode: ordinary answers, workflows and Deep
Research retain their own operation paths. A dialogue can use two to five
Agents, in the supplied speaking order.

Individual ordinary chat and dialogue replies use the provider-operation
ceiling in [the timeout reference](../feature-b2-timeout-and-shutdown.md#ordinary-agent-chat-replies).
Deep Research and other Workflow workers use their own execution budgets,
outside that reply lifecycle. The boundary is specified by “an ordinary reply
stays active until the thirty-minute
default deadline” in `tests/integration/agent-reply-lifecycle.test.ts` and “a
two-hour research plan retains its own budget after thirty minutes of work” in
`tests/unit/deep-research-dispatch-budget.test.ts`.

Discussion mode labels the existing multi-Agent chat
behavior. The current reply loop visits each planned speaker once
(`services/agent-chat-service.ts:676`), and its prompt tells the Agent to wait
for the next human message (`services/agent-reply-prompt.ts:87`). Talk to each
other adds repeated short turns between Agents. It does not invoke the Team
discussion engine.

## Flow

1. In Run's Agents sidebar, select at least two Agents. A switch beneath the
   selected list offers Discussion mode and Talk to each other. Discussion
   mode is selected by default. Changing selection or mode starts no work.
   An info tooltip explains both modes. With fewer than two Agents, hide the
   switch and use ordinary chat. With more than five, keep Discussion mode
   available and disable Talk to each other with the limit explained.
2. Send a topic while Talk to each other is selected, or call `start_dialogue`
   explicitly. An MCP call can name a session or create one; its delivery
   defaults to text unless voice is explicitly requested. The server checks
   and claims the session atomically. Refuse a start if a dialogue, ordinary
   chat turn or session task already owns it.
3. Save an explicit user or MCP topic as a normal user message. A native Agent
   tool saves its generated topic under the calling Agent's identity. The
   topic never counts toward the generated reply ceiling. Return the dialogue and session
   IDs immediately, with generation continuing as a server job. Each dialogue
   has its own identity, limits and status.
4. Ask the next Agent to answer the latest speaker in two to four sentences.
   Supply earlier turns with speaker labels and identify that Agent's own
   earlier words. Keep every shared tool, file and evidence safeguard. The
   prompt does not disclose the reply limit or ask for a closing summary.
   Shortness is controlled by the prompt, not by truncating a reply.
5. Filter passes before publishing live text. Hold a possible `[pass]` prefix
   across chunks, ignoring leading spaces and case; remove a trailing pass
   token while preserving real text. A completed pass is never displayed,
   saved or spoken. Empty provider output is a failure. Real replies reset
   the pass streak.
6. For text delivery, stream API replies and show completed CLI replies. Save
   each accepted reply once as a normal chat message with its Agent identity
   and dialogue provenance. Save transcript text before advancing the dialogue
   record. Then move to the next Agent in the supplied order.
7. Keep the composer enabled for interjections and show dialogue status with
   Pause or Resume and Stop. Controls address the active dialogue; changing
   the mode switch cannot turn it into an ordinary chat turn.
8. End after every remaining Agent passes consecutively, the reply or running
   time limit is reached, the user stops, or fewer than two Agents can reply.
   Show a muted reason and offer Keep going. The default ceiling is 12 saved
   replies, with an explicit maximum of 50. Passes, failures and user messages
   do not count. Stop produces no spoken closing line or summary.

## Alternative flows

### Jump in, pause and stop

- A text interjection is saved once using the client's `messageId`, even if
  retried. The Agent currently writing finishes; the next Agent answers the
  interjection. It resets the pass streak. An interjection can resume a paused
  dialogue.
- A text Pause request lets the current turn finish, then starts no further
  turn until Resume or an interjection. Resume uses the next speaker, rather
  than repeating the previous one.
- Stop records the request before cancelling generation, discards the
  unfinished reply, and sends no further provider requests. Repeated control
  requests are safe. A paused dialogue can also be stopped.
- An optional time budget counts only while running. Its cancellation signal
  bounds generation by the remaining running budget. Expiry discards an unfinished text turn;
  paused time consumes no dialogue budget. The separate provider operation
  retains its ordinary 900-second ceiling; the pause-aware running-budget
  signal controls earlier cancellation.

### Failure, continuation and recovery

- A provider failure produces a muted failure line, not an Agent chat message
  that later Agents could mistake for a contribution. The next Agent still
  speaks. Two consecutive failures remove the failing Agent; fewer than two
  remaining Agents ends the dialogue.
- Keep going starts a new dialogue ID in the same session, with the same
  Agents, earlier history and a fresh reply limit. The old dialogue and its
  messages are preserved.
- Shutdown cancels each running dialogue and leaves it interrupted. After a
  crash, reading a record whose exact owner process has exited marks it
  interrupted and releases its session claim. Another live launch retains
  ownership. Discovery also releases dead claims left before the first record
  was written. No dialogue restarts automatically.
- Admission of an ordinary chat or workflow task runs this recovery before
  checking dialogue ownership. A live foreign owner still blocks admission.
- A finished job leaves the live job map after its loop and cleanup settle.
  Reading or retrying terminal controls uses the saved record. Deleting its
  session also removes its durable and live lookup.
- Recovery counts accepted replies from the transcript, including a reply
  saved just before the record advanced. An abandoned slot is never regenerated
  into its old message ID. A recorded stop request remains stopped on recovery.
  Continue starts a new dialogue and sees any already-saved interjection.
- An active-dialogue query includes only running or paused records. Retried
  Stop, Pause and Resume return a recovered terminal record without restarting
  it. An already-saved interjection can be replayed with the same identity and
  text after restart; different text for that identity or a new interjection
  on a terminal dialogue is refused.

### Session claim

A running or paused dialogue owns its session. An ordinary chat message,
another Start or Continue, or a Team or workflow start is refused with
`409 dialogue_active`, from any client. Dialogue text uses its interjection
endpoint. Session deletion stops the dialogue and waits for its loop before
deleting. The locked deletion check also rejects a new claim acquired during
that wait. Existing chat recovery must not classify dialogue replies as
unfinished ordinary chat turns.

If ownership cleanup fails after an ordinary reply or Team admission is already
durable, return that successful result and log the cleanup fault. Retain any
unreleased claim. The trusted completion signal remains false, so a reserved
dialogue generates nothing after failed cleanup.

### Voice delivery and Hexa Puffs preferences

Hexa Puffs's Voice tab has an Octopus preferences section for voice access,
confirmation before starting a dialogue, and reading replies aloud. The last
preference chooses explicit text or voice delivery. These preferences are
implemented in the separate Hexa Puffs worktree and require enrollment.
The brain is instructed to clarify ambiguous intent, topic or Agent names
before starting. An explicit typed request to
an Agent can start a text dialogue through the same service operation. The
initiating ordinary reply must be saved before the dialogue generates; a
failed or cancelled initiating reply interrupts its reservation. Ownership
is promoted atomically from that exact chat claim, and setup failure restores
it before returning.

For voice, keep one `say` call in flight and at most one generated turn in
reserve. Display text only when playback reports `started`; persist it when
the call returns. An interrupted reply retains text up to the last whole word
heard and is marked cut off; discard the reserved turn and pause. New spoken
words go through the interjection endpoint. A cut-in with no words stays paused.
Every utterance has a unique identity. Obsolete speech cannot change newer
state; a mismatched final receipt for the current request pauses visibly as a
refusal. An interruption receipt cannot undo an already-accepted interjection
or Resume.

Stop cancels active or queued speech and discards the reserved turn. If the
voice layer is unreachable or a turn is dropped before playback, pause with a
visible reason. There is no automatic text fallback. When the time budget
expires, speech already playing finishes, but nothing more is spoken and the
reserved turn is discarded. Voice and text dialogues both leave readable chat
history in Octopus.

While generating a voice reply, Hexa Puffs shows the current Agent's activity.
Speech, Pause, Stop and connection loss clear that activity. Idle cleanup checks
the dialogue identity, and disconnect cleanup checks the owning connection,
so an older dialogue or disconnected client cannot clear a newer label.
Clearing the label never adds a spoken closing
line or delays the visible Stop response.

## Business rules and test mapping

The IDs below match [the feature's rule mapping](../feature-agent-dialogue.md#business-flow-and-test-mapping).

| ID | Required outcome | Test boundary and reason | Test file and exact name, or gap |
| --- | --- | --- | --- |
| AD-01 | Agents alternate, later prompts read earlier replies, and accepted replies retain their Agent identity | Real REST, filesystem and provider HTTP boundary | [agent-dialogue.test.ts](../../tests/integration/agent-dialogue.test.ts), “two Agents alternate, read earlier replies and save the dialogue in their chat”; [agent-dialogue.spec.ts](../../tests/electron/agent-dialogue.spec.ts), “Talk to each other alternates saved replies and ends when both Agents pass” |
| AD-02 | Pass tokens never appear live or saved; a complete pass round ends the dialogue | Integration observes every frame and saved message | [agent-dialogue-pass-failure.test.ts](../../tests/integration/agent-dialogue-pass-failure.test.ts), “split and trailing pass tokens stay out of every live frame and saved contribution”; policy unit tests cover case and chunk boundaries |
| AD-03 | Only saved replies count toward the configured ceiling; the shared defaults and cap are validated | Pure policy and request contracts; integration for resulting end state | [agent-dialogue-policy.test.ts](../../tests/unit/agent-dialogue-policy.test.ts), “only saved replies reach the configured reply ceiling”; [agent-dialogue-contract.test.ts](../../tests/unit/agent-dialogue-contract.test.ts), “a dialogue start defaults to text and twelve saved replies” and “a dialogue refuses reply ceilings above fifty and empty topics” |
| AD-04 | Stop aborts the unfinished text reply and starts no further turn | Real held HTTP response | [agent-dialogue-controls.test.ts](../../tests/integration/agent-dialogue-controls.test.ts), “Stop returns while generation is pending and discards the unfinished reply”; the Electron Stop journey in `agent-dialogue.spec.ts` |
| AD-05 | Retried interjections save once; the writing Agent finishes and the next answers the user | Real HTTP barrier and transcript | [agent-dialogue-controls.test.ts](../../tests/integration/agent-dialogue-controls.test.ts), “a typed interjection is saved once and the next Agent answers it after the current reply”; [agent-dialogue-durable-controls.test.ts](../../tests/integration/agent-dialogue-durable-controls.test.ts) covers identity replay after restart |
| AD-06 | Pause starts no new turn after the current one; Resume continues the order | Real turn barriers; desktop controls | [agent-dialogue-pause-recovery.test.ts](../../tests/integration/agent-dialogue-pause-recovery.test.ts), “Pause lets the writing Agent finish and Resume starts the next Agent”; pause and continuation Electron journeys |
| AD-07 | Provider failures stay out of chat history; two consecutive failures remove the Agent | Provider HTTP boundary and saved state | [agent-dialogue-pass-failure.test.ts](../../tests/integration/agent-dialogue-pass-failure.test.ts), “failed provider turns never enter chat and a twice-failed Agent leaves”; Electron failure status journey |
| AD-08 | Recovery never restarts, counts saved replies, preserves Stop and continues under a new identity | Real files, owned child processes and REST | [agent-dialogue-pause-recovery.test.ts](../../tests/integration/agent-dialogue-pause-recovery.test.ts), “reopening an interrupted dialogue waits and Keep going uses a new run with the saved history”; [agent-dialogue-owner-recovery.test.ts](../../tests/integration/agent-dialogue-owner-recovery.test.ts) covers live owners and dead recordless claims; policy, shutdown and durable-control tests |
| AD-09 | Only running time consumes the budget; expiry discards unfinished generation, while Pause lets the current reply finish | Injected dialogue/platform clocks with real provider HTTP | [agent-dialogue-time.test.ts](../../tests/integration/agent-dialogue-time.test.ts), “only running time consumes the budget and expiry discards unfinished generation” and “Pause lets the current Agent finish after more paused time than its remaining dialogue budget”; voice tests distinguish queued and already-playing speech |
| AD-10 | Locked claims exclude chat, tasks and other dialogues; deletion stops and rechecks ownership | Competing REST calls, real stores and process liveness | [agent-dialogue-ownership.test.ts](../../tests/integration/agent-dialogue-ownership.test.ts), [session-activity-claims.test.ts](../../tests/integration/session-activity-claims.test.ts), [session-chat-dialogue-handoff.test.ts](../../tests/integration/session-chat-dialogue-handoff.test.ts) and owner recovery tests |
| AD-11 | Dialogue style preserves all chat safeguards and tool/context capabilities | Prompt unit tests and real tool/context integration | [agent-reply-prompt.test.ts](../../tests/unit/agent-reply-prompt.test.ts), [agent-dialogue-tools.test.ts](../../tests/integration/agent-dialogue-tools.test.ts), [agent-dialogue-context.test.ts](../../tests/integration/agent-dialogue-context.test.ts); journal lifecycle and transcript provenance tests |
| AD-12 | Playback start controls live text; interruption saves only heard words, discards reserve and rejects stale identities | Authenticated SDK MCP with controlled playback receipts | [agent-dialogue-voice.test.ts](../../tests/integration/agent-dialogue-voice.test.ts), “spoken replies appear at playback start, save after the receipt and prepare one next reply while speech plays”, “a spoken interruption keeps heard words, drops the reserve and resumes on an interjection with a fresh utterance” and “a rapid Pause and Resume finishes playing speech and replaces its reserved turn with a fresh identity”; [voice-layer-say.test.ts](../../tests/integration/voice-layer-say.test.ts) covers stale progress/receipts and request cancellation isolation |
| AD-13 | Stop cancels speech, outages pause visibly, shutdown keeps heard words, and expiry distinguishes queued/playing audio | Real API/MCP and desktop | [agent-dialogue-voice.test.ts](../../tests/integration/agent-dialogue-voice.test.ts), Stop, unavailable voice, dropped utterance, time-limit and shutdown journeys; [agent-dialogue-voice.spec.ts](../../tests/electron/agent-dialogue-voice.spec.ts), “interrupted speech keeps its heard words in the desktop chat and a typed interjection resumes the next Agent” |
| AD-14 | Desktop users start, interject, Stop, Pause, Resume, continue and reopen history | Distinct Electron user journeys | [agent-dialogue.spec.ts](../../tests/electron/agent-dialogue.spec.ts) contains eight text dialogue journeys; its initial and control journeys completed genuine Red/Green loops. The paired voice journey also passed with cutoff-annotation mutation protection |
| AD-15 | Multiple selections default to Discussion mode; mode changes start nothing; Send replies once per Agent | Real desktop/API; component bounds | [agent-dialogue.spec.ts](../../tests/electron/agent-dialogue.spec.ts), “multiple selected Agents default to Discussion mode and reply once after Send”; [agent-chat-mode-picker.test.tsx](../../ui/src/components/run/pickers/__tests__/agent-chat-mode-picker.test.tsx) covers selection bounds |
| AD-16 | MCP defaults to text and accepts explicit voice; Hexa Puffs honors enrollment and Octopus preferences | Real SDK MCP; Hexa Puffs UI and Electron | [agent-dialogue-mcp.test.ts](../../tests/integration/agent-dialogue-mcp.test.ts) covers text default/control; the voice Electron journey starts with explicit voice through MCP. Separate Hexa Puffs preference/backend/enrollment suites are verified in `agent-dialogue-voice-current-main` |
| AD-17 | An explicit ordinary Agent tool call starts a dialogue only after its initiating reply is saved | Real native provider tool loop, REST, durable claims and desktop discovery | [agent-dialogue-chat-activation.test.ts](../../tests/integration/agent-dialogue-chat-activation.test.ts), “asking an Agent to discuss with a named peer starts text dialogue after its ordinary reply is saved”, cancellation and no-auto-start cases; [agent-dialogue-deferred-start.test.ts](../../tests/integration/agent-dialogue-deferred-start.test.ts) covers failed publication, Stop, rollback and pending-handoff budget; [agent-dialogue.spec.ts](../../tests/electron/agent-dialogue.spec.ts), “asking an Agent to discuss with a peer acquires dialogue controls and replies in the already-open chat”; [agent-dialogue-voice.spec.ts](../../tests/electron/agent-dialogue-voice.spec.ts) also covers external MCP starts refreshing the already-open chat without Show |
| AD-18 | Voice generation shows the current Agent's activity; Pause, Stop and revoked access clear only the owned label | Real API/MCP cleanup and Hexa Puffs IPC/Electron | [agent-dialogue-voice-status.test.ts](../../tests/integration/agent-dialogue-voice-status.test.ts), “Stop during voice generation clears its working label without speaking a closing line” and “a paused voice dialogue clears its working label when the current Agent passes”; Hexa Puffs's `tests/e2e/octopus-status.spec.ts` covers the visible label and revocation |
| AD-19 | Ordinary chat and workflow admission recover crashed dialogues, preserving live foreign ownership | REST, real stores and owned processes | [agent-dialogue-owner-recovery.test.ts](../../tests/integration/agent-dialogue-owner-recovery.test.ts), "ordinary chat recovers a crashed dialogue before claiming its session", "workflow admission recovers a crashed dialogue before claiming its session", and both "preserves a live foreign dialogue owner" cases |
| AD-20 | Agent-generated topics keep the calling Agent's authorship and never count as generated replies; explicit MCP topics retain user authorship | Native provider tool loop, saved transcript and pure recovery policy | [agent-dialogue-chat-activation.test.ts](../../tests/integration/agent-dialogue-chat-activation.test.ts), "asking an Agent to discuss with a named peer starts text dialogue after its ordinary reply is saved"; [agent-dialogue-policy.test.ts](../../tests/unit/agent-dialogue-policy.test.ts), "an Agent-authored topic never counts as a generated dialogue reply on recovery"; MCP new-chat journey |
| AD-21 | Finished dialogue jobs leave the live map; a deleted session cannot resolve its dialogue | Real authenticated SDK, DELETE and filesystem stores | [agent-dialogue-mcp.test.ts](../../tests/integration/agent-dialogue-mcp.test.ts), "deleting a completed dialogue chat removes durable and live lookups"; durable control and shutdown suites protect terminal replays |

## Coverage boundaries

Test mappings describe intended coverage; run the relevant checks against the current checkout.

Local transport and provider fixtures do not establish physical microphone, audible playback or installed-package behavior.
