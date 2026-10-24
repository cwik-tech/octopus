# Cloud-browser limits

The Browser Use provider must be enabled and have a key in Research acquisition
settings. Its enable switch controls availability independently of its limits.

| Setting | Zero | Positive value |
| --- | --- | --- |
| Cloud browser calls | Unlimited sessions | Maximum sessions per assignment lane |
| Cloud browser spend threshold | No spend threshold | Stop starting sessions once confirmed spend reaches the threshold |

A zero in one field leaves the other field effective. Search and source
acquisition share the same lane counters. Costs are confirmed after stopping a
session, so a positive spend threshold can be exceeded by one session. An
unconfirmed bill still prevents further sessions in that lane.

Disabling Browser Use preserves the ordinary acquisition ladder. An unconfigured
search does not consume the search budget. Other acquisition limits keep their
existing meanings; the zero-as-unlimited rule applies to these two cloud fields.

Worker model selection, YouTube Gemini video analysis and Brave search are
separate settings. A cloud-browser limit does not select or replace the model
running a worker.

The implementation is `services/research-web-tool-service.ts`; the public
regressions are `tests/integration/research-web-cloud-rung.test.ts`, including
"zero removes only its cloud browser limit", with real loopback provider HTTP,
and the existing parallel-safety and proxied-retry files. Provider HTTP is
substituted because Browser Use sessions are paid and nondeterministic.
See the [chat-workflow flow](../flows/chat-workflow-launch.md) for expected behavior and test mappings.
