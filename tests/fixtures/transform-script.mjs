#!/usr/bin/env node
/**
 * Test fixture: a simple gate transform script.
 * Reads TRANSFORM_INPUT, writes a summary to TRANSFORM_OUTPUT.
 */
import fs from 'node:fs'

const inputPath = process.env.TRANSFORM_INPUT
const outputPath = process.env.TRANSFORM_OUTPUT
const workspacePath = process.env.WORKSPACE_PATH

let inputContent = ''
if (inputPath && fs.existsSync(inputPath)) {
  inputContent = fs.readFileSync(inputPath, 'utf-8')
}

const output = [
  '# Transform Output',
  '',
  `Workspace: ${workspacePath}`,
  `Input: ${inputPath}`,
  '',
  '## Processed Content',
  '',
  inputContent || '(no input)',
].join('\n')

fs.writeFileSync(outputPath, output)
