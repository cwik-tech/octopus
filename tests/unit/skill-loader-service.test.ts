import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { SkillLoaderService } from '../../services/skill-loader-service.js'

test('skill loader is enabled only when the current agent has a discoverable skill', async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-enabled-')),
  )
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }))
  const service = new SkillLoaderService({ repoRootPath })
  const skillPath = path.join(
    repoRootPath,
    'agents',
    'analyst',
    'skills',
    'evidence-review',
    'SKILL.md',
  )
  await fs.mkdir(path.join(repoRootPath, 'agents', 'analyst'), { recursive: true })

  assert.equal(service.isEnabledForAgent('agents/analyst'), false)

  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await fs.writeFile(skillPath, '# Evidence review\n')

  assert.equal(service.isEnabledForAgent('agents/analyst'), true)
})

test('load_skill returns one selected skill after verifying its content hash', async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-')),
  )
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }))
  const skillPath = path.join(
    repoRootPath,
    'agents',
    'analyst',
    'skills',
    'evidence-review',
    'SKILL.md',
  )
  const content = `---
name: evidence-review
description: Review evidence before reaching a conclusion.
version: 2.1.0
---

# Evidence Review

FULL-SELECTED-SKILL-INSTRUCTIONS
`
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await fs.writeFile(skillPath, content)
  const sha256 = createHash('sha256').update(content).digest('hex')
  const service = new SkillLoaderService({ repoRootPath })

  const output = await service.execute('agents/analyst', {
    source: skillPath,
    sha256,
  })

  assert.deepEqual(output, {
    ok: true,
    name: 'evidence-review',
    source: skillPath,
    sha256,
    content,
  })
})

test('load_skill rejects sources outside the repository agent packages', async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-root-')),
  )
  const externalRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-external-')),
  )
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }))
  context.after(() => fs.rm(externalRoot, { recursive: true, force: true }))
  await fs.mkdir(path.join(repoRootPath, 'agents'), { recursive: true })
  const externalSkillPath = path.join(
    externalRoot,
    'skills',
    'external-skill',
    'SKILL.md',
  )
  const content = '# Outside skill\n'
  await fs.mkdir(path.dirname(externalSkillPath), { recursive: true })
  await fs.writeFile(externalSkillPath, content)
  const service = new SkillLoaderService({ repoRootPath })

  const output = await service.execute('agents/analyst', {
    source: externalSkillPath,
    sha256: createHash('sha256').update(content).digest('hex'),
  })

  assert.deepEqual(output, {
    ok: false,
    code: 'skill_source_not_allowed',
    message: 'Skill source is outside the repository agent packages.',
  })
})

test('load_skill rejects a skill owned by a different agent', async (context) => {
  const repoRootPath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'skill-loader-owner-')),
  )
  context.after(() => fs.rm(repoRootPath, { recursive: true, force: true }))
  const skillPath = path.join(
    repoRootPath,
    'agents',
    'writer',
    'skills',
    'editorial-review',
    'SKILL.md',
  )
  const content = '# Editorial review\n'
  const analystSkillPath = path.join(
    repoRootPath,
    'agents',
    'analyst',
    'skills',
    'evidence-review',
    'SKILL.md',
  )
  await fs.mkdir(path.dirname(skillPath), { recursive: true })
  await fs.mkdir(path.dirname(analystSkillPath), { recursive: true })
  await fs.writeFile(skillPath, content)
  await fs.writeFile(analystSkillPath, '# Evidence review\n')
  const service = new SkillLoaderService({ repoRootPath })

  const output = await service.execute('agents/analyst', {
    source: skillPath,
    sha256: createHash('sha256').update(content).digest('hex'),
  })

  assert.deepEqual(output, {
    ok: false,
    code: 'skill_source_not_allowed',
    message: 'Skill source is outside the current agent skill catalog.',
  })
})
