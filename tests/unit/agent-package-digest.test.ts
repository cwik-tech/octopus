/**
 * Package hashes are recovery evidence, so an incomplete answer is worse than
 * no answer. Anything the walk cannot read or does not understand must fail the
 * caller rather than quietly shrink the hash map it returns.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  agentPackageMatchesHashes,
  computeAgentPackageHashes,
} from '../../domains/agent-generator/agent-package-digest.js'

function makePackage(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'package-digest-'))
  fs.mkdirSync(path.join(root, 'skills', 'review'), { recursive: true })
  fs.writeFileSync(path.join(root, 'agent.md'), 'persona\n')
  fs.writeFileSync(path.join(root, 'skills', 'review', 'SKILL.md'), 'skill\n')
  return root
}

function withPackage(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = makePackage()
  return Promise.resolve(run(root)).finally(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })
}

test('every file is hashed under a normalized, contained relative path', async () => {
  await withPackage(async (root) => {
    const hashes = await computeAgentPackageHashes(root)

    assert.deepEqual(Object.keys(hashes).sort(), [
      'agent.md',
      'skills/review/SKILL.md',
    ])
    for (const [relativePath, digest] of Object.entries(hashes)) {
      assert.match(digest, /^sha256:[0-9a-f]{64}$/)
      assert.equal(path.isAbsolute(relativePath), false)
      assert.equal(relativePath.includes('\\'), false)
      assert.equal(relativePath.split('/').includes('..'), false)
    }
  })
})

test('a package directory that is not there fails instead of hashing nothing', async () => {
  const root = makePackage()
  fs.rmSync(root, { recursive: true, force: true })

  await assert.rejects(computeAgentPackageHashes(root), /package/i)
})

test('a directory the walk cannot read fails instead of skipping it', async () => {
  await withPackage(async (root) => {
    const locked = path.join(root, 'skills', 'review')
    fs.chmodSync(locked, 0o000)
    try {
      await assert.rejects(computeAgentPackageHashes(root))
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })
})

test('a file the walk cannot read fails instead of omitting it', async () => {
  await withPackage(async (root) => {
    const locked = path.join(root, 'agent.md')
    fs.chmodSync(locked, 0o000)
    try {
      await assert.rejects(computeAgentPackageHashes(root))
    } finally {
      fs.chmodSync(locked, 0o644)
    }
  })
})

test('a symlink inside the package is refused rather than followed or ignored', async () => {
  await withPackage(async (root) => {
    fs.symlinkSync(path.join(root, 'agent.md'), path.join(root, 'alias.md'))

    await assert.rejects(computeAgentPackageHashes(root), /alias\.md/)
  })
})

test('a directory entry that is neither a file nor a directory is refused', async (t) => {
  await withPackage(async (root) => {
    const pipe = path.join(root, 'pipe')
    try {
      execFileSync('mkfifo', [pipe])
    } catch {
      // Documented environmental prerequisite: without `mkfifo` there is no way
      // to create a non-regular entry here. The symlink case still covers the
      // unsupported-entry contract.
      t.skip('mkfifo is unavailable on this platform')
      return
    }

    await assert.rejects(computeAgentPackageHashes(root), /pipe/)
  })
})

test('a package path that is itself a symlink is refused rather than followed', async () => {
  await withPackage(async (root) => {
    const link = `${root}-link`
    fs.symlinkSync(root, link)
    try {
      await assert.rejects(computeAgentPackageHashes(link), /symbolic link/i)
      await assert.rejects(
        agentPackageMatchesHashes(link, { 'agent.md': 'sha256:0' }),
        /symbolic link/i,
      )
    } finally {
      fs.rmSync(link, { force: true })
    }
  })
})

test('a package that is gone does not match recorded evidence', async () => {
  const root = makePackage()
  const hashes = await computeAgentPackageHashes(root)
  fs.rmSync(root, { recursive: true, force: true })

  assert.equal(await agentPackageMatchesHashes(root, hashes), false)
})

test('a package whose bytes changed does not match recorded evidence', async () => {
  await withPackage(async (root) => {
    const hashes = await computeAgentPackageHashes(root)
    fs.writeFileSync(path.join(root, 'agent.md'), 'edited\n')

    assert.equal(await agentPackageMatchesHashes(root, hashes), false)
  })
})

test('an unreadable package is refused rather than reported as matching', async () => {
  await withPackage(async (root) => {
    const hashes = await computeAgentPackageHashes(root)
    const locked = path.join(root, 'skills', 'review')
    fs.chmodSync(locked, 0o000)
    try {
      await assert.rejects(agentPackageMatchesHashes(root, hashes))
    } finally {
      fs.chmodSync(locked, 0o755)
    }
  })
})

/**
 * A package may legally contain a file named `__proto__`.
 *
 * Assigning that key on an ordinary object invokes the prototype setter
 * instead of creating a property, so the file vanishes from the record and a
 * later change to it still compares equal. Durable recovery evidence cannot
 * omit a real file.
 */
test("a package file named __proto__ is recorded and its change is detected", async () => {
  await withPackage(async (packagePath) => {
    fs.writeFileSync(path.join(packagePath, "__proto__"), "original\n");

    const hashes = await computeAgentPackageHashes(packagePath);

    assert.ok(
      Object.keys(hashes).includes("__proto__"),
      `expected __proto__ to be recorded: ${Object.keys(hashes).join(", ")}`,
    );
    assert.equal(await agentPackageMatchesHashes(packagePath, hashes), true);

    fs.writeFileSync(path.join(packagePath, "__proto__"), "changed\n");

    assert.equal(
      await agentPackageMatchesHashes(packagePath, hashes),
      false,
      "a change to that file must not compare equal",
    );
  });
});
