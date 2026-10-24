---
name: desktop-runtime-selection
description: Decide whether an application genuinely requires a native desktop runtime, and if so select between Electron and Tauri using capability reach, backend language and team fit, bundle and startup profile, webview consistency, and ecosystem maturity.
---

# Desktop Runtime Selection

## Purpose

Produce a defensible runtime decision instead of a defaulted one. This skill runs two gates in order: first, whether a native desktop runtime is required at all; second, which runtime fits this specific application and this specific team.

Use this skill when the runtime is unchosen, when an existing choice is being reconsidered, or when the choice was made by familiarity rather than analysis.

## Gate One — Is Desktop Required

Before comparing runtimes, establish that a runtime is needed. Answer each:

1. **Named capability.** What does this application do that a browser tab cannot? Acceptable answers name specific mechanisms: arbitrary filesystem access, persistent background execution, system tray residency, global shortcuts, native menu integration, local process spawning, hardware or peripheral access, protocol handling, or hard offline guarantees.
2. **Distribution versus capability.** If the only driver is presence — an icon in the dock, a downloadable installer, a perception of seriousness — then the desktop layer is a distribution decision. Scope it as thinly as possible and do not let it pull architecture into the native layer.
3. **Offline requirement.** Does the application need to function with no network for a meaningful period? If yes, that is a real capability driver and it constrains storage design downstream.
4. **Data locality.** Does data need to stay on the user's machine for policy, privacy, or trust reasons? This is a legitimate driver and it changes the whole boundary design.

**Output of gate one:** either a named list of capabilities that justify a desktop runtime, or an explicit finding that desktop is a distribution decision and should be scoped thin.

## Gate Two — Runtime Comparison

Evaluate Electron and Tauri across these axes. Do not treat the axes as equally weighted — weight them by what this application actually needs.

### Capability reach

What native surface does the application require, and which runtime exposes it without custom native code? Electron's Node backend gives broad immediate access through the npm ecosystem. Tauri's Rust backend gives access through its plugin system and direct Rust crates, which is powerful but may require writing native code for less common needs. Ask: is there a required capability where one runtime means writing custom native code and the other means installing a package?

### Backend language and team fit

The privileged process is written in Node for Electron and Rust for Tauri. This decides who can maintain the security-critical code path. Ask:

- Does anyone on the team write Rust today?
- If not, is the privileged surface small enough that learning it is bounded?
- Who is on call when the privileged process misbehaves in production?

Treat this as a first-order factor. A technically superior runtime that nobody on the team can maintain is the wrong choice.

### Bundle size and startup profile

Tauri uses the system webview and produces substantially smaller bundles; Electron ships Chromium and does not. This matters when it matters — bandwidth-constrained distribution, many concurrent installs, or a user population that notices. It does not matter merely because a number is smaller.

Ask: **who specifically is harmed by the larger bundle?** If nobody can be named, this axis carries little weight for this decision.

### Webview consistency

Electron ships its own Chromium, so rendering is identical everywhere. Tauri uses the system webview — WebKit on macOS, WebView2 on Windows — so rendering and web platform feature availability vary by platform and OS version. Ask:

- How complex is the UI, and how sensitive is it to rendering differences?
- Does the app depend on recent web platform features whose availability varies?
- What is the minimum OS version being supported, and what webview ships with it?

A visually demanding or feature-dependent UI raises the cost of webview variance considerably.

### Ecosystem and operational maturity

Consider available plugins, packaging and update tooling, documentation depth, community size, and how many teams have shipped and maintained comparable applications. Weight by how much of the operational path — signing, notarization, updating — the team wants to build versus adopt.

## Decision Construction

Produce a decision that names:

1. **The choice.** Electron or Tauri.
2. **The two or three axes that actually decided it.** Not all six — the ones that carried weight for this application.
3. **What was traded away.** Every choice loses something. Name it explicitly so the decision record is honest.
4. **The condition that would reverse the decision.** What would have to change — a capability requirement, a team change, a bundle constraint — for the other runtime to be correct?

## Anti-Patterns

- Choosing by general reputation rather than by this application's requirements.
- Citing bundle size without naming a user harmed by it.
- Treating Rust as free because the app is small today, when the privileged surface will grow.
- Ignoring webview variance because development happened on one platform.
- Deciding before the required native capability list exists.
- Skipping gate one and comparing runtimes for an application that does not need one.

## Output

- Desktop justification: named capabilities, or a finding that desktop is distribution-only.
- Runtime choice with the deciding axes.
- Explicit statement of what the choice trades away.
- The reversal condition.
