---
name: desktop-distribution-strategy
description: Define packaging, code signing and macOS notarization, auto-update channels and rollback, and issue explicit branch-or-abstract verdicts for every point where macOS and Windows behavior diverges enough to affect the architecture.
---

# Desktop Distribution Strategy

## Purpose

Distribution constraints shape desktop architecture, they do not follow it. Signing identity, notarization lead time, update topology, and OS divergence all need to be established while the design is still movable. This skill produces those constraints as decisions and issues explicit verdicts on cross-platform divergence.

Run this early in a session, not at the end.

## Step 1 — Signing Identity and Custody

Establish before anything else, because it has lead time and cost.

**macOS**
- Developer ID certificate under a specific Apple Developer account. Name the account holder.
- Notarization is required for distribution outside the App Store. It is a submission-and-wait step in the release pipeline, not a build flag.
- Hardened runtime, and any entitlements the application requires. Each entitlement is a claim that must be justified.
- Stapling the notarization ticket so first launch works offline.

**Windows**
- Code signing certificate, and whether it is OV or EV. EV affects SmartScreen reputation behavior immediately; OV builds reputation over time.
- Certificate storage: increasingly hardware-token or cloud-HSM backed, which changes how CI signs.

**Custody — ask explicitly**
- Where do signing credentials live in CI?
- Who can release today, and what happens to shipping when that person is unavailable?
- Is the Apple account an individual or an organization account?

Unresolved custody is a release blocker disguised as an administrative detail.

## Step 2 — Packaging Targets

Name the artifacts per platform and the reason for each.

- **macOS:** `.app` bundle, and the distribution wrapper — DMG or PKG. Architecture targets: Apple Silicon, Intel, or universal binary. State the minimum supported macOS version.
- **Windows:** installer format — MSI, NSIS, or MSIX — and whether per-user or per-machine install. Per-machine installs require elevation; that is a UX and enterprise-deployment decision.
- **Minimum OS versions.** These constrain webview availability, especially for Tauri, and should be stated rather than inherited from tooling defaults.

## Step 3 — Auto-Update Strategy

Design the update path as architecture, not as a library selection.

- **Mechanism.** Which update system, and how updates are hosted and served.
- **Update signing.** Updates must be signed and verified independently of the installer signature. State the key and where it lives.
- **Channels.** Stable, beta, internal — and how a user moves between them.
- **Cadence and enforcement.** Silent background update, prompt-on-available, or forced minimum version. Forced minimums require a version gate the app can enforce.
- **Rollback.** What happens when a bad build ships? Options are pull the release, publish a higher-versioned revert, or support a downgrade path. Most auto-update systems do not downgrade — decide now rather than during the incident.
- **Migration safety.** If an update changes the local data schema, updates become one-way. State whether a rolled-back binary can read data written by the newer one. This is the constraint that turns a bad release into a data incident.

## Step 4 — OS Divergence Verdicts

Walk the divergence points and issue a verdict on each: **branch** or **abstract**. Branch where user-visible behavior or platform expectation differs. Abstract only where the difference is syntax over the same behavior.

| Divergence point | Typical verdict | Reasoning |
|---|---|---|
| App data and config paths | abstract | Same behavior, different location; use platform-aware path resolution |
| Menu bar vs system tray | **branch** | Different user expectation, different affordances, different placement conventions |
| Application menu structure | **branch** | macOS expects a conventional app menu; Windows does not use one the same way |
| Window chrome, traffic lights, close-vs-quit | **branch** | Close on macOS commonly does not quit; on Windows it commonly does |
| Installer and first-run experience | **branch** | Different formats, different elevation and trust prompts |
| Update mechanism | usually **branch** | Different delivery and permission models beneath a shared trigger |
| Notifications and permissions | **branch** | Different permission flows and presentation |
| Keyboard accelerators | abstract with a mapping | Same intent, different modifier conventions — Cmd vs Ctrl |
| Filesystem case sensitivity and path length | abstract with constraints | Enforce the stricter constraint set everywhere |
| Credential storage | abstract | Keychain and Credential Manager behind one secret interface |
| Auto-launch at login | **branch** | Different registration mechanisms and user-facing settings |

Treat this table as a starting checklist, not a conclusion. Add divergence points specific to the application and issue a verdict on each.

**The rule:** if abstracting a divergence would make the application feel wrong on one of the two platforms, branch. A false abstraction over genuinely different behavior produces an app that is native on neither.

## Step 5 — Release Pipeline Sketch

Sketch the release path end to end so the gaps are visible: build per target → sign → notarize where required → package → publish artifacts → publish update manifest → verify install and update on a clean machine per platform.

Call out any step that currently has no owner, no credential, or no automation.

## Anti-Patterns

- Treating signing and notarization as a final packaging step rather than a design constraint.
- No named rollback path, discovered during an incident.
- Data migrations that make updates one-way without acknowledging it.
- Abstracting tray and menu behavior into one component across both platforms.
- Assuming Linux is in scope when it was not named — state the assumption instead.
- Signing credentials held by one person with no documented backup path.
- Testing updates only on the developer's machine, never on a clean install of each platform.

## Output

- Signing identity, certificate type, entitlements, and CI custody per platform.
- Packaging targets, architectures, and minimum OS versions.
- Update mechanism, channels, cadence, rollback path, and migration-safety statement.
- Divergence table with a branch-or-abstract verdict and reasoning per row.
- Release pipeline sketch with unowned steps flagged.
- Explicit scope statement on platforms not covered.
