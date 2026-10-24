import test from 'node:test'
import assert from 'node:assert/strict'

import { getDiscussionOutputPath } from '../../engines/discussion.js'
import { getChainOutputPath } from '../../engines/chain.js'
import { getBroadcastOutputPath } from '../../engines/broadcast.js'
import { getReviewOutputPath } from '../../engines/review.js'

const assignmentPath = '/tmp/assignment'

test('runtime-owned stages resolve relative output.path under the assignment directory', () => {
  const config = {
    config: {
      output: {
        path: 'output',
        format: 'result.md',
      },
    },
  } as any

  assert.equal(
    getDiscussionOutputPath(config, assignmentPath),
    '/tmp/assignment/output/result.md',
  )
  assert.equal(
    getChainOutputPath(config, assignmentPath),
    '/tmp/assignment/output/result.md',
  )
  assert.equal(
    getBroadcastOutputPath(config, assignmentPath),
    '/tmp/assignment/output/result.md',
  )
  assert.equal(
    getReviewOutputPath(config, assignmentPath),
    '/tmp/assignment/output/result.md',
  )
})

test('runtime-owned stages preserve absolute output.path values', () => {
  const config = {
    config: {
      output: {
        path: '/var/tmp/custom-output',
        format: 'result.md',
      },
    },
  } as any

  assert.equal(
    getDiscussionOutputPath(config, assignmentPath),
    '/var/tmp/custom-output/result.md',
  )
  assert.equal(
    getChainOutputPath(config, assignmentPath),
    '/var/tmp/custom-output/result.md',
  )
  assert.equal(
    getBroadcastOutputPath(config, assignmentPath),
    '/var/tmp/custom-output/result.md',
  )
  assert.equal(
    getReviewOutputPath(config, assignmentPath),
    '/var/tmp/custom-output/result.md',
  )
})
