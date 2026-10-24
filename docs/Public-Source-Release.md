# Publish a source-only release

Publish a separately prepared source snapshot with a fresh Git repository.
Keep private development checkouts, local data and release artifacts outside
the public payload.

## Review the source snapshot

1. Read `docs/THIRD_PARTY_NOTICES.md` and resolve source-asset provenance items.
   Preserve third-party notices, including their original copyright names.
2. Include tracked current source and explicitly reviewed new documentation.
   Exclude `.git`, ignored local data, credentials, nested worktrees, installed
   dependencies, generated maps, old builds and deleted files.
3. Inspect the final archive contents and checksum. A source archive is not a
   packaged desktop app and should contain no downloaded executable payloads.

## Publication checklist

- Confirm authorship and redistribution rights for included Agents, skills,
  references and templates; retain all third-party notices.
- Remove credentials, personal machine paths and private fixture content from
  source files, expanded document contents and binary metadata.
- Apply and verify dependency security updates. The root, UI and file-parser
  audit must have no unaccepted high or critical advisories.
- Verify the exact exported payload using the independent setup below; run
  typechecks, lint and relevant tests before publishing.
- Configure a private vulnerability-reporting endpoint for the public repository.
- Inspect the initial commit identity, branches and tags before the first push.

Publication requires these checks on the selected snapshot; old test results or
candidate dependency lockfiles do not establish readiness.

## Verify installation independently

Extract the source into an empty folder without a `.env` file. Use the Node 22
version supported by the repository. Run the documented contributor setup:

```sh
npm run setup:worktree
npm test
node scripts/audit-security.mjs
```

The setup command runs locked `npm ci` installs for the root, UI and parser.
Do not link or copy `node_modules` from another checkout. This verifies setup
on the current machine; it does not establish a clean-machine desktop install,
paid-provider behavior, signing or notarization.

## Prepare new history

Initialize a new Git repository in the reviewed source folder, rather than
copying or rewriting the working repository's `.git`. Inspect that it has no
commits, inherited refs or remotes before making its first public commit.
Choose a project identity or a privacy-preserving email for that commit;
check the recorded author and committer before publication. The initial push
runs the build/test gates; version comparison starts on later updates, when a
previous branch tip exists.

When the maintainer authorizes flattening, create one initial commit in this
separate repository. Check `git rev-list --all --count` returns `1`,
`git rev-list --parents HEAD` contains no parent, `git branch --all` lists only
the intended branch, and both `git tag --list` and `git remote -v` are empty.
Do not copy Git objects, alternates, refs or tags from the working repository.
Choosing the public destination and pushing remain separate maintainer actions.

Keep the original checkout private. A flattened source repository removes its
old history locally; it does not delete existing remote history, cached commits,
forks or other clones. Never make the old remote public to publish this snapshot.

A binary release needs its own payload/license review and packaged installation
checks. Source-only readiness does not certify downloadable macOS artifacts.
