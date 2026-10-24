# Voice control through Model Context Protocol

Octopus exposes an authenticated local Model Context Protocol (MCP) endpoint for
enrolled voice clients. Calls use the same local application routes as the desktop.
Dialogue replies remain visible in their normal chat session.

## Discovery

The desktop writes a private `apps/octopus.json` descriptor under
`~/Library/Application Support/voice-control/` by default. It contains the
loopback MCP URL and a per-launch credential. Keep this file private. A client
must enroll the app before using its tools; discovery alone is not trust.

Outbound speech and status use the voice-layer descriptor and the per-app grant
in `voice/octopus.json`. The API credential is not the MCP credential.

## Octopus MCP tools

| Tool | Annotations | Calls |
|---|---|---|
| `list_workflows`, `list_teams`, `list_agents` | read-only | `services/workflow-service.ts`, team and agent catalog |
| `list_sessions`, `create_session` | read-only / write | session store |
| `start_workflow`, `start_team` | write, returns `taskId` | same path as `POST /sessions/:id/tasks` (`server/routes/sessions.ts:1693-1700`) |
| `get_task`, `list_tasks` | read-only | task records |
| `cancel_task` | destructive | `cancelSessionTask` |
| `ask` | write, progress notifications | `POST /sessions/:id/messages`, then `dispatchSessionMessage` (`services/session-dispatch-service.ts:160`) |
| `list_results`, `read_result` | read-only | session results |
| `get_question` | read-only | the same three routes, to say what the task waits for |
| `answer_question`, `choose_model` | write | agent-questions, human-in-the-loop and model-choice routes |
| `show` | write, UI only (`idempotentHint`) | a `show` function the desktop passes to the server, which focuses the window and sends the renderer `pipeline:voice-navigate` |
| `start_dialogue`, `get_dialogue`, `interject_dialogue`, `pause_dialogue`, `resume_dialogue`, `stop_dialogue` | reads or writes; controls idempotent; Stop non-destructive | Shared dialogue REST routes; omitted delivery defaults to text |

Tools send authenticated loopback requests to the same REST routes the window
uses. Their input and returned data are validated at the MCP boundary. This
keeps admission rules in one place.

Not exposed: folder grants. Granting disk access stays with the native picker
(`domains/shared-folders/shared-folder-access-policy.ts`). Dialogue turns can
read folders already attached and granted to the session; MCP adds no grant tool.

## Outbound status and notifications

Octopus sends current task status through `set_status` and attention requests
through `notify`. Notifications are retained in `voice-control/outbox.json` and
rechecked against current task state before delivery. A missing voice layer does
not stop ordinary application work. Notification delivery is at least once, so
the receiver must deduplicate by `dedupeKey`.

The Hexa Puffs dialogue integration and its wider generic notification receiver
have different scopes. Do not assume support for a tool merely because Octopus
can send it. Physical audio and packaged integration require their own checks.

## Security

| Rule | How |
|---|---|
| Loopback only | The server rejects other configured hosts (`server/api-server.ts:409-412`) |
| MCP token is separate from the API token | Configuration requires a distinct token; the MCP endpoint authenticates it separately (`server/api-server.ts:397-404`, `server/voice-control/app-mcp-endpoint.ts:166-180`) |
| The API token never leaves Octopus | The descriptor holds only the MCP token |
| Token file is private | Mode 0600, rewritten every launch, deleted on quit |
| Browsers cannot call it | The MCP endpoint refuses requests with an `Origin` header (`server/voice-control/app-mcp-endpoint.ts:173-175`) |
| No disk grants by voice | See above |
| Spoken confirmation | Current Hexa Puffs checks Octopus enablement/enrollment and confirms destructive tools, ordinary writes and optionally dialogue starts. Generic per-tool overrides remain proposed (`electron/octopusControl.ts:149-173` in Hexa Puffs) |
| Descriptors point only at loopback | Readers reject a non-loopback `mcp.url` |
| App-to-voice identity | Current Hexa Puffs speech and dialogue status authenticate the Octopus grant and reject another source. Generic `notify` identity remains proposed (`electron/octopusVoiceServer.ts:59-95` in Hexa Puffs) |

See the [voice-control flow](flows/voice-control-mcp.md) for behavior and test mappings.
