---
name: desktop-process-boundary-design
description: Design the privileged/sandboxed process split for a desktop application — enumerate the IPC surface as a deliberate API, place local storage and define offline authority, and specify background work and system integration such as tray, native menus, and global shortcuts.
---

# Desktop Process Boundary Design

## Purpose

In a desktop application the process boundary is the trust boundary. Every IPC channel is a privilege grant from the view layer into the native layer. This skill produces a deliberate, enumerable boundary rather than one that accretes as features are added.

Use this skill once the runtime is selected and the conversation turns to what runs where.

## Step 1 — Establish the Privilege Model

Name the processes and what each is trusted to do.

- **Privileged process.** Electron main, or Tauri core. Holds filesystem access, network privileges beyond the webview, process spawning, native OS integration, and secrets. This is the code that must be reviewed as security-critical.
- **View process.** Electron renderer, or Tauri webview. Treat as untrusted. Assume any code that reaches it — including transitive dependencies — can call any exposed IPC channel.
- **Preload or bridge layer.** Where present, this is the only place the two meet. It should expose a narrow, explicit, typed API and nothing else.

State the sandbox posture explicitly: context isolation, node integration, and allowed origins for Electron; capability and allowlist configuration for Tauri. Defaults are not a decision — name them.

## Step 2 — Enumerate the IPC Surface

Do not describe IPC as "the renderer talks to main." Produce a table. Every row is a privilege grant.

| Channel | Direction | Privilege granted | Why necessary | Input validation |
|---|---|---|---|---|
| example: `file.readProject` | view → privileged | reads within project dir | open a user project | path confined to selected root |

Rules for the surface:

- **Enumerate, never open.** No generic `invoke(anything)` passthrough, no dynamic method dispatch from the view layer.
- **Domain verbs, not primitives.** Expose `saveDocument`, not `writeFile`. A filesystem primitive on the bridge is a filesystem grant to anything running in the view.
- **Validate at the boundary.** Every input crossing into the privileged process is untrusted. Validate shape and constrain paths, URLs, and identifiers.
- **Justify each row.** If necessity cannot be stated in one sentence, the channel probably should not exist.

A long table is a signal. If the surface has dozens of channels, the boundary is likely in the wrong place — reconsider what should live natively.

## Step 3 — Place Local Storage and Define Authority

Decide what lives on the device and what authority it carries.

- **Storage mechanism.** Named options with rationale: embedded database file, structured files on disk, OS keychain or credential store for secrets, platform app-data directories for configuration. Never store secrets in webview-accessible storage.
- **Location.** Use platform app-data conventions rather than hardcoded paths. This is one of the first places macOS and Windows diverge.
- **Authority.** State plainly which data is authoritative locally and which is a cache of a remote source. Ambiguity here produces reconciliation bugs that surface months later.
- **Reconciliation.** For anything both local and remote: what happens on conflict? Last-write-wins, server-authoritative, merge, or user-resolved. Pick one per data class and say so.
- **Offline envelope.** State what works with no network and for how long. "Offline-first" is not a design — the list of operations that function offline is.

## Step 4 — Background Work and System Integration

Specify the behaviors that make the application feel native, and where each one is implemented.

- **Background execution.** What runs when no window is visible? Sync, watchers, scheduled work, notification polling. State whether the app quits on last-window-close or persists.
- **Tray residency.** Whether the app lives in the tray or menu bar, what the menu contains, and what clicking does. Note that macOS menu bar and Windows system tray carry different user expectations — this is a divergence point, not a shared component.
- **Native menus.** Application menu structure, and whether it is shared or platform-specific. macOS expects an application menu with conventional item placement; Windows does not.
- **Global shortcuts.** Registered accelerators, conflict handling, and permission implications.
- **Window and lifecycle behavior.** Multi-window model, state restoration, close-versus-quit semantics, deep link and protocol handling.
- **Notifications.** Which layer emits them and what permissions each platform requires.

For every item, name the process it lives in. Background work in the view layer stops when the window closes — that is usually a bug in waiting.

## Step 5 — Boundary Review

Before handing off, check:

- Can any single compromised dependency in the view layer reach the filesystem, the network beyond intended origins, or secrets?
- Is every IPC channel justified in one sentence?
- Is offline authority stated per data class rather than as a slogan?
- Does any background behavior depend on a window being open when it should not?
- Are secrets outside webview-accessible storage?

## Anti-Patterns

- A generic bridge that forwards arbitrary calls into the privileged process.
- Exposing filesystem or shell primitives rather than domain operations.
- Disabling context isolation or widening the allowlist for convenience during development and never narrowing it.
- Treating "offline-first" as a property rather than an enumerated set of operations.
- Building tray and menu behavior as one shared abstraction across macOS and Windows.
- Storing tokens or keys in webview-accessible storage instead of the OS credential store.

## Output

- Process and privilege model with explicit sandbox posture.
- Enumerated IPC table with justification and validation per channel.
- Storage placement, authority per data class, and reconciliation rules.
- Offline operation envelope.
- Background work and system integration, each assigned to a process.
- Boundary review findings.
