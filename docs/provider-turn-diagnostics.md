# Provider turn diagnostics

For a recorded Agent turn, inspect the assignment's
`.runtime/provider-turns/<turnKey>.jsonl` beside its assignment journal.
The key correlates process records with that assignment's provider attempt.
`services/provider-turn-diagnostics-store.ts` owns storage;
`domains/runtime/provider-turn-diagnostics.ts` owns the validated record format.

| Record | Meaning |
| --- | --- |
| `provider-cancellation` | Cancellation was observed, with `phase` equal to `turn` or `process`. `source` is `user-stop`, `request-disconnected`, `provider-deadline`, or `caller-abort` for an unrecognized caller reason. The turn record is written immediately, before cleanup settles. |
| `provider-cli-diagnostic` | Classified stdout error/retry event or stderr line. Contains channel, shared provider error category or `retry`, optional HTTP status, attempt and retry delay in milliseconds. Also retained after eventual success. |
| `provider-process-started`, `provider-protocol-event`, `provider-stall`, `provider-process-exited` | Process lifecycle, protocol event types, observed silence and exit metadata. |
| `protocol-events-truncated`, `cli-diagnostics-truncated` | That recorder's corresponding event budget was exhausted. |

Each recorder keeps at most 200 protocol events and, independently, 64 CLI
diagnostics. Lifecycle, cancellation and failure records remain recordable
after those budgets. Readers accept at most 4 MiB per file. Retry attempts
must be integers from 0 through 10,000; delays from 0 through 86,400,000 ms.
HTTP statuses must be integers from 100 through 599. Other numeric values are
omitted. The stderr collector keeps at most 16,384 characters of an incomplete
line; an unterminated final line is classified when the process closes.

Records contain metadata, never raw stderr, prompts, answers, account names,
tokens or arbitrary cancellation text. Ordinary assistant stdout is excluded
from CLI error classification. Writes are best effort so logging cannot fail
an otherwise working turn.

A cancellation observation proves which signal the runtime received; it does
not prove the provider finished cleanup. The journal and completed stream
establish completion. A failed cancellation request followed by local transport
abort is observed by the server as a disconnect. Missing upstream output cannot
establish what an opaque CLI was thinking or doing internally.

Coverage is mapped by `tests/unit/cli-diagnostics.test.ts`,
`tests/unit/provider-turn-diagnostics.test.ts`, the CLI provider integration
tests, `direct-chat-provider-diagnostics.test.ts`, `request-abort-reason.test.ts`,
`agent-reply-lifecycle.test.ts` and `tests/electron/multi-window-sync.spec.ts`.
