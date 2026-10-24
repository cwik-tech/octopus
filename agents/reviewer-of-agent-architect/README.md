# Reviewer of Agent Architect configuration

The shipped persona inherits the application default model. Its stable ID is
`reviewer-of-agent-architect`, and `system: true` keeps it editable in Create
while excluding it from normal Run and Team selection.

To select a reviewer model, edit `reviewer-of-agent-architect.md` and add both
`provider` and `model` to its frontmatter. This installation accepts:

```yaml
provider: codex
model: gpt-5.6-sol
```

The native app adapter successfully called that exact model on 2026-09-19.
The evidence is in the retired baseline record, under "Codex/Sol prerequisite"
(`git show babda906^:docs/2026-09-19-Agent-Architect-Baseline-Evidence.md`).
Remove both fields to return to the application default. The shipped persona
retains that portable default.

The next turn reads the edited persona from the application's editable project
root. A running turn keeps its original instructions and selection. If an
explicit reviewer is unavailable, the turn may attempt its captured application
default once when that default is available and different. Provider settings
belong to their selected provider and must not transfer to another provider.

Set `PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED=false` before starting the
application to disable review. Unset or `true` enables review. Other values are
configuration errors. A restart is required after changing the setting.

Development launch:

```sh
PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED=false npm run desktop:start
```

For a packaged macOS app, quit the running app and launch its executable from a
terminal. Substitute the actual bundle path:

```sh
PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED=false /path/to/Octopus.app/Contents/MacOS/Octopus
```

Use `true` in the same command to enable review on the next launch.
