/**
 * The agent-question content store: the request, answers, continuation and
 * result bodies that durable workflow state names only by an
 * agentQuestionContentReference (SHA-256 and UTF-8 byte length).
 *
 * A write serializes the value as canonical JSON, refuses it with a store
 * error if it does not fit in a content file, and saves it to
 * <private runtime path>/agent-questions/<sha256>.json through an atomic
 * write, after checking that the private runtime path is inside the
 * assignment and that the content folder is a real folder inside it. A file
 * already saved under that name is kept when its bytes are the same, and
 * refused as changed when they are not, so a later identical question never
 * silently repairs a file an earlier one references.
 * A read resolves the file inside the assignment, checks that it is a regular
 * file of the referenced byte length and then checks the digest of its bytes
 * before parsing it. A referenced file that does not exist is reported as
 * missing.
 *
 * This module takes no lock and publishes no state. The workflow state store
 * calls it while holding workflow.lock for writes and keeps every state
 * mutation, its validation and its publication. It imports neither the store
 * nor workflows/workflow-files.ts.
 */

import type { Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  agentQuestionContentReferenceSchema,
  MAX_AGENT_QUESTION_CONTENT_BYTES,
  type AgentQuestionContentReference,
} from '../contracts/agent-questions.js'
import { canonicalizeJson as serializeCanonicalJson } from '../contracts/canonical-json.js'
import { writeFileAtomic } from '../core/file-mutation.js'
import { resolveExistingPathInside } from '../core/path-safety.js'
import { WorkflowStateStoreError } from './workflow-state-errors.js'
import { hashWorkflowContent } from './workflow-state-validation.js'

const STORAGE_OUTSIDE = 'The question storage is outside its assignment.'
const CONTENT_OUTSIDE = 'The question content is outside its assignment.'

export async function writeAgentQuestionContentFile(
  rootAssignmentPath: string,
  privateRuntimePath: string,
  value: unknown,
): Promise<AgentQuestionContentReference> {
  const text = serializeCanonicalJson(value)
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength > MAX_AGENT_QUESTION_CONTENT_BYTES) {
    throw new WorkflowStateStoreError('invalid_state', 'The question content is larger than 8,000,000 bytes.')
  }
  const reference = agentQuestionContentReferenceSchema.parse({
    sha256: hashWorkflowContent(bytes), byteLength: bytes.byteLength,
  })
  if (!resolveExistingPathInside(rootAssignmentPath, privateRuntimePath)) {
    throw new WorkflowStateStoreError('corrupt', STORAGE_OUTSIDE)
  }
  const directory = path.join(privateRuntimePath, 'agent-questions')
  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  } catch (error) {
    // A regular file where the folder belongs. The caller maps store errors;
    // a raw EEXIST reached it as an unmapped failure.
    if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTDIR')) {
      throw new WorkflowStateStoreError('corrupt', 'The question storage is not a folder.', { cause: error })
    }
    throw error
  }
  const directoryStat = await fs.lstat(directory)
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || !resolveExistingPathInside(rootAssignmentPath, directory)) {
    throw new WorkflowStateStoreError('corrupt', STORAGE_OUTSIDE)
  }
  const contentPath = path.join(directory, `${reference.sha256}.json`)
  const existing = await lstatOrNull(contentPath)
  if (existing) {
    // Questions with identical content share one file. Keep it when it is
    // still the saved bytes; replacing it would hide an edit an earlier
    // question's read would otherwise report.
    if (existing.isFile() && (await fs.readFile(contentPath)).equals(bytes)) return reference
    throw new WorkflowStateStoreError('corrupt', 'A saved question content was changed after it was saved.')
  }
  await writeFileAtomic(contentPath, bytes)
  return reference
}

export async function readAgentQuestionContentFile(
  rootAssignmentPath: string,
  privateRuntimePath: string,
  unvalidated: AgentQuestionContentReference,
): Promise<unknown> {
  const reference = agentQuestionContentReferenceSchema.parse(unvalidated)
  const candidatePath = path.join(privateRuntimePath, 'agent-questions', `${reference.sha256}.json`)
  const contentPath = resolveExistingPathInside(rootAssignmentPath, candidatePath)
  if (!contentPath) {
    throw new WorkflowStateStoreError('corrupt',
      await isMissingInsideAssignment(rootAssignmentPath, privateRuntimePath, candidatePath)
        ? 'The question content is missing.'
        : CONTENT_OUTSIDE)
  }
  const stat = await fs.stat(contentPath)
  if (!stat.isFile() || stat.size !== reference.byteLength) {
    throw new WorkflowStateStoreError('corrupt', 'The question content size does not match its reference.')
  }
  // The digest covers the bytes, not the decoded text: two different byte
  // sequences can decode to the same text.
  const bytes = await fs.readFile(contentPath)
  if (hashWorkflowContent(bytes) !== reference.sha256) {
    throw new WorkflowStateStoreError('corrupt', 'The question content digest does not match its reference.')
  }
  return JSON.parse(bytes.toString('utf8'))
}

/**
 * Whether a content file that did not resolve is simply absent from a real
 * content folder inside the assignment, rather than reached through a link or
 * a folder that is not one.
 */
async function isMissingInsideAssignment(
  rootAssignmentPath: string,
  privateRuntimePath: string,
  candidatePath: string,
): Promise<boolean> {
  if (!resolveExistingPathInside(rootAssignmentPath, privateRuntimePath)) return false
  const folder = await lstatOrNull(path.dirname(candidatePath))
  if (folder && (folder.isSymbolicLink() || !folder.isDirectory())) return false
  return (await lstatOrNull(candidatePath)) === null
}

/** The entry at `entryPath`, or null only when nothing is there. */
async function lstatOrNull(entryPath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(entryPath)
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
