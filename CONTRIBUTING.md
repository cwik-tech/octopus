# Contributing

Thanks for your interest in contributing to Pipeline. This document covers
development setup, the testing policy, and how to get a change merged.

## Development setup

Use Node.js 22 or newer. After cloning, install the locked dependencies for
the repository root, UI, and file parser:

```bash
npm run setup:worktree
```

Run the desktop app in development mode with Vite hot reload:

```bash
npm run desktop:dev
```

## Before you submit

Every change must pass the verification gates that CI runs:

| Scope | Command |
|-------|---------|
| Backend unit suite | `npm run test:unit` |
| Backend integration suite | `npm run test:integration` |
| Backend TypeScript | `npx tsc --noEmit` |
| UI lint, tests, and build | `npm --prefix ui run check` |
| File-parser tests and build | `npm --prefix file-parser test && npm --prefix file-parser run build` |
| Full gate | `npm test` |

During development, run the narrowest relevant command; run `npm test`,
`npx tsc --noEmit`, and any applicable Electron verification before opening
a pull request.

## Testing policy

This repository follows test-driven development. Every behavior change and
bug fix needs a failing test written before the implementation
(Red → Green → Refactor). The full policy — how to choose the test layer,
when a test is not required (presentational-only UI changes, documentation,
behavior-preserving refactors), and the definition of done — lives in
`AGENTS.md`. Please read it before your first code change; it is enforced in
review.

A few highlights:

- Tests are the specification: derive them from the requirement, not from
  the implementation.
- Use the lowest test layer that can observe the complete requirement.
- Do not hide unfinished behavior behind skips, todos, or weakened
  assertions.

## Code and UI style

- Match the conventions of the code around you.
- UI work must use the shadcn primitives in `ui/src/components/ui/`, theme
  tokens instead of raw pixel values, and semantic color tokens. The rules
  and the lint-style checks are in `docs/UI-Styling-Guide.md`.
- Agent skills (`SKILL.md` files) follow the Agent Skills specification;
  `tests/unit/skill-spec-conformance.test.ts` enforces it.

The shadcn CLI is an on-demand development tool, rather than a project
dependency. Run a reviewed CLI version from `ui/` when adding components,
using the existing `ui/components.json` configuration and the
[official CLI workflow](https://ui.shadcn.com/docs/cli#add). Review generated
dependency and CSS changes. The current shadcn 4.5.0 Tailwind helpers are
vendored in `ui/src/styles/vendor/shadcn.css`, including their MIT notice;
update that copy deliberately when new components require newer helpers.

## Changelog and versioning

- Every completed coding task adds an entry to `CHANGELOG.md` under
  `[Unreleased]`. Documentation-only changes do not need one.
- Do not edit version fields by hand. Maintainers run `npm run version:bump`
  as part of merging an app-affecting change.

## Pull requests

- Keep one concern per pull request.
- Describe the observable behavior change and name the tests that cover it.
- Report any pre-existing test failures separately from failures your change
  introduces.

## Security

Please do not open public issues for security vulnerabilities. See
`SECURITY.md` for the project's security posture and how to report a
vulnerability.

## License

By contributing, you agree that your contributions are licensed under the
Apache License, Version 2.0. See `LICENSE` for the full text.
