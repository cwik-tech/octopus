import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { WorkspaceProjectContextStore } from '../../domains/projects/project-context-store.js'
import { WorkspaceProjectStore } from '../../domains/projects/project-store.js'
import { captureProjectDocuments, captureDeliveryDocuments } from '../../services/document-context-service.js'

test('project document capture exposes full selected references and excludes unselected files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-document-access-'))
  try {
    const project = await new WorkspaceProjectStore({ workspacePath: root }).create({ name: 'Evidence' })
    const store = new WorkspaceProjectContextStore({ workspacePath: root })
    await store.saveFile(project.id, { filename: 'chosen.md', contents: Buffer.from('background '.repeat(8_000) + 'FINAL_FACT=4831') })
    await store.saveFile(project.id, { filename: 'private.md', contents: Buffer.from('PRIVATE_NOT_SELECTED') })
    const sources = await captureProjectDocuments({ selection: { projectId: project.id, includeBrief: false, fileNames: ['chosen.md'] }, store })
    assert.equal(sources.length, 1)
    assert.match(sources[0]?.text ?? '', /FINAL_FACT=4831/)
    assert.doesNotMatch(JSON.stringify(sources), /PRIVATE_NOT_SELECTED/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('delivered artifacts retain their final section under their admitted history identity', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-document-access-'))
  const file = path.join(root, 'result.md')
  await fs.writeFile(file, 'background '.repeat(2_000) + 'FINAL_RESULT=6137')
  try {
    const sources = await captureDeliveryDocuments({ sessionId: 'session', history: [{ id: 'message', role: 'assistant', text: 'Done.', createdAt: '2026-10-09T00:00:00Z', delivery: { taskId: 'owned-task', artifacts: [{ runId: 'owned-run', path: 'result.md', role: 'final' }] } }], readArtifact: async (runId, artifact) => { assert.equal(runId, 'owned-run'); assert.equal(artifact, 'result.md'); return fs.readFile(file, 'utf8') } })
    assert.match(sources[0]?.text ?? '', /FINAL_RESULT=6137/)
    assert.match(sources[0]?.id ?? '', /^doc_[a-f0-9]{64}$/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('a delivered document changed after publication is unavailable rather than admitted as the published revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-revision-'))
  try {
    const file = path.join(root, 'result.md')
    await fs.writeFile(file, 'CHANGED_AFTER_PUBLICATION')
    const digest = createHash('sha256').update('PUBLISHED_ORIGINAL').digest('hex')
    const sources = await captureDeliveryDocuments({ sessionId: 'session', history: [{ id: 'message', role: 'assistant', text: 'Done.', createdAt: '2026-10-09T00:00:00Z', delivery: { taskId: 'owned-task', artifacts: [{ runId: 'owned-run', path: 'result.md', role: 'final', digest }] } }], readArtifact: async () => fs.readFile(file, 'utf8') })
    assert.equal(sources[0]?.text, null)
    assert.doesNotMatch(JSON.stringify(sources), /CHANGED_AFTER_PUBLICATION/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
