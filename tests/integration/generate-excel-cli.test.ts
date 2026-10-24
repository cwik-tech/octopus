import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import ExcelJS from 'exceljs'

test('Generate Excel CLI converts Markdown without an agent runtime', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-excel-cli-'))
  try {
    const inputPath = path.join(workspace, 'report.md')
    const outputPath = path.join(workspace, 'report.xlsx')
    fs.writeFileSync(
      inputPath,
      '# CLI Report\n\n## Result\n\n| Metric | Value |\n| --- | ---: |\n| Runs | 3 |\n',
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/generate-excel.ts',
        inputPath,
        outputPath,
        '--profile',
        'plain-data',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /profile 'plain-data'/)
    assert.equal(
      fs.readFileSync(outputPath).subarray(0, 2).toString('ascii'),
      'PK',
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})

test('Generate Excel CLI fills a workbook template from JSON data', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-excel-cli-template-'))
  try {
    const templatesRoot = path.join(workspace, 'excel-templates')
    const templateDirectory = path.join(templatesRoot, 'risk-cli')
    fs.mkdirSync(templateDirectory, { recursive: true })
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Model')
    sheet.getCell('A1').value = 'Startup'
    sheet.getCell('B1').value = 'SAMPLE NAME'
    fs.writeFileSync(
      path.join(templateDirectory, 'template.xlsx'),
      Buffer.from(await workbook.xlsx.writeBuffer()),
    )
    fs.writeFileSync(
      path.join(templateDirectory, 'manifest.json'),
      JSON.stringify({
        id: 'risk-cli',
        displayName: 'Risk CLI',
        description: 'Synthetic template for the CLI test.',
        templateFile: 'template.xlsx',
        inputs: {
          cells: {
            startup_name: {
              type: 'string',
              required: true,
              sheet: 'Model',
              cell: 'B1',
            },
          },
        },
      }),
    )
    const dataPath = path.join(workspace, 'data.json')
    const outputPath = path.join(workspace, 'risk.xlsx')
    fs.writeFileSync(
      dataPath,
      JSON.stringify({ cells: { startup_name: 'Acme Robotics' } }),
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/generate-excel.ts',
        dataPath,
        outputPath,
        '--template',
        'risk-cli',
        '--templates-dir',
        templatesRoot,
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /template 'risk-cli'/)
    assert.equal(
      fs.readFileSync(outputPath).subarray(0, 2).toString('ascii'),
      'PK',
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
