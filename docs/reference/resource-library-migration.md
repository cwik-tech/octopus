# Enable or recover Resource Library

Use Node 22 and explicit project and Library roots. The Library root is the host-owned application user-data resource-library directory, separate from the project source. Stop the application before command-line migration or rollback. Never point verification at personal data.

## Review before enabling

Opening Library shows a read-only inventory before the first migration. Create and Run continue using existing resources. Review the paths and file digests, then select **Back up and enable Library** only when those are the intended sources. The service verifies a private backup before publishing the first catalog. Original directories remain intact. Changed inventory requires another review.

The command-line equivalent uses caller-selected paths:

```sh
npm run library:migration -- dry-run --repo-root "$PROJECT_ROOT" --library-root "$LIBRARY_ROOT" --report "$REPORT_FILE"
```

`REPORT_FILE` must be a new file. Dry-run writes only that report, not a Library catalog or source edits. Review its `sources`, `agentIds`, `sourceRootDigest` and `inventoryDigest`. Keep the report private because it includes source paths.

After explicit approval of that inventory:

```sh
npm run library:migration -- apply --repo-root "$PROJECT_ROOT" --library-root "$LIBRARY_ROOT" --report "$REPORT_FILE"
```

The command rejects a report from a different root or stale inventory. Its JSON result identifies the verified backup. Retain that location. Backups include complete skill files and executable intent; they are not a complete project/application backup.

## Roll back an unused migration

Rollback is available only for the first catalog generation, before Library edits, package import or retained task projections. It validates the backup and all source digests, then archives the current pointer. It does not delete source directories or immutable revisions. Library requests approval again afterward.

```sh
npm run library:migration -- rollback --repo-root "$PROJECT_ROOT" --library-root "$LIBRARY_ROOT" --backup "$BACKUP_DIRECTORY"
```

If later use makes rollback unsafe, the command refuses. Do not remove the current pointer or restore directories by hand to bypass the guard. Preserve the Library and backup for a separately reviewed recovery.

## Curated distribution and update review

`resources/builtins.json` selects system Agents, four default Teams and their dependencies, and explicit workflow templates. `npm run builtins:stage` builds a fresh `build/curated-resources` tree; it does not edit sources. The desktop package includes that tree instead of every personal Agent, Team or skill in the checkout.

A source skill that fails existing conformance stops staging.

For the first curated upgrade of an existing project without an old receipt, bundled resources become review offers instead of being copied automatically. This preserves absent defaults without guessing whether they were deleted. A fresh project receives the selected defaults. Installation receipts preserve edited and deleted defaults on later starts. Changed bundled resources appear as Library update offers and use the ordinary ZIP preview/conflict process. Configuration-file offers require manual review. Importing a collection does not run its scripts or grant tools, credentials, integrations or permissions.

## Archive and publication recovery

Imports retain the source ZIP for provenance and a checksummed snapshot of the accepted collection, including selected local revision substitutions and reviewed Agent/Team names. Collection export uses that accepted snapshot even if live resources are subsequently changed or removed. It is not a backup of sessions or private memory.

A staged import publishes project directories and the Team registry under the shared publication lock, then publishes one catalog pointer. Restart recovers incomplete work from the journal. Unpublished files are removed only when their ownership marker and content still match; external drift causes refusal with the files retained. Do not delete a recovery journal to suppress that refusal.

## Publication ownership

Application-owned Team edits, shell creation/finalization/discard, staged Agent additions and ZIP imports share Library publication ownership before taking Team or Agent file locks. Nested staged Agent writes use the already-owned capability instead of reacquiring the Library lock. Generation and document processing remain outside that scope. Hosts without a configured Library keep their legacy filesystem behavior; manual filesystem edits are outside this coordination boundary.

For packaged Library verification, supply an isolated `PIPELINE_DESKTOP_EXECUTABLE` to Playwright and run `tests/electron/resource-library-packaged-upgrade.spec.ts`. The journey changes only a test-owned package's bundled defaults, relaunches its real engine on the same isolated user-data directory, and restores the package files in cleanup. It does not represent a notarized-release or clean-machine upgrade.
