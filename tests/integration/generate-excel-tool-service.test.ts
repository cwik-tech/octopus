import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { createHash } from 'node:crypto'

import ExcelJS from 'exceljs'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { GenerateExcelToolService } from '../../services/generate-excel-tool-service.js'

test('Generate Excel tool is persona-gated and writes only assignment artifacts', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'generate-excel-tool-')),
  )
  const workspacePath = path.join(root, 'workspace')
  const repoRootPath = path.join(root, 'repo')
  const agentDirectory = path.join(repoRootPath, 'agents', 'modeler')
  const identity = {
    sessionId: 'session-excel',
    runId: 'run-excel',
    assignmentId: 'assignment-excel',
  }
  const context = {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-excel',
    leaseId: 'lease-excel',
    ...identity,
    agentPath: 'agents/modeler',
  }
  try {
    fs.mkdirSync(agentDirectory, { recursive: true })
    fs.writeFileSync(
      path.join(agentDirectory, 'modeler.md'),
      '---\nname: modeler\ntools: generate_excel\n---\n\n# Modeler\n',
    )
    const templateDirectory = path.join(
      repoRootPath,
      'domains',
      'excel-generation',
      'templates',
      'risk-check',
    )
    fs.mkdirSync(templateDirectory, { recursive: true })
    await writeTemplateWorkbook(path.join(templateDirectory, 'template.xlsx'))
    fs.writeFileSync(
      path.join(templateDirectory, 'manifest.json'),
      JSON.stringify({
        id: 'risk-check',
        displayName: 'Risk Check',
        description: 'Synthetic template for the tool-service test.',
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
    const location = buildSessionRunAssignmentLocation(workspacePath, identity)
    assert.ok(location)
    fs.mkdirSync(location.assignmentPath, { recursive: true })
    fs.writeFileSync(
      path.join(location.assignmentPath, 'metrics.md'),
      '# Metrics\n\n## Funnel\n\n| Stage | Count |\n| --- | ---: |\n| Leads | 120 |\n',
    )
    fs.writeFileSync(
      path.join(location.assignmentPath, 'risk-data.json'),
      JSON.stringify({ cells: { startup_name: 'Acme Robotics' } }),
    )
    const service = new GenerateExcelToolService({
      workspacePath,
      repoRootPath,
    })

    const profiles = await service.execute(
      context,
      'call-profiles',
      { action: 'list_profiles' },
    )
    assert.equal(profiles.ok, true)
    assert.equal(profiles.profiles?.length, 3)

    const templates = await service.execute(
      context,
      'call-templates',
      { action: 'list_templates' },
    )
    assert.equal(templates.ok, true)
    assert.equal(templates.templates?.length, 1)
    assert.equal(templates.templates?.[0]?.id, 'risk-check')
    assert.equal(templates.templates?.[0]?.cells[0]?.name, 'startup_name')

    const generated = await service.execute(
      context,
      'call-generate',
      {
        action: 'generate',
        inputPath: 'metrics.md',
        outputPath: 'exports/metrics.xlsx',
        profile: 'financial-model',
      },
    )
    assert.equal(generated.ok, true)
    assert.equal(generated.outputPath, 'exports/metrics.xlsx')
    assert.equal(generated.profile, 'financial-model')
    assert.equal('digest' in generated ? generated.digest : undefined, createHash('sha256').update(fs.readFileSync(path.join(location.assignmentPath, 'exports/metrics.xlsx'))).digest('hex'))
    assert.deepEqual(generated.sheetNames, ['Funnel'])
    assert.equal(
      fs.readFileSync(
        path.join(location.assignmentPath, 'exports', 'metrics.xlsx'),
      ).subarray(0, 2).toString('ascii'),
      'PK',
    )

    const filled = await service.execute(
      context,
      'call-fill',
      {
        action: 'fill_template',
        template: 'risk-check',
        inputPath: 'risk-data.json',
        outputPath: 'exports/risk.xlsx',
      },
    )
    assert.equal(filled.ok, true)
    assert.equal(filled.template, 'risk-check')
    assert.equal(
      fs.readFileSync(
        path.join(location.assignmentPath, 'exports', 'risk.xlsx'),
      ).subarray(0, 2).toString('ascii'),
      'PK',
    )

    const escaped = await service.execute(
      context,
      'call-escape',
      {
        action: 'generate',
        inputPath: 'metrics.md',
        outputPath: '../outside.xlsx',
      },
    )
    assert.equal(escaped.ok, false)
    assert.equal(escaped.error?.code, 'invalid_request')

    fs.writeFileSync(
      path.join(agentDirectory, 'modeler.md'),
      '---\nname: modeler\ntools: none\n---\n\n# Modeler\n',
    )
    const denied = await service.execute(
      context,
      'call-denied',
      { action: 'list_profiles' },
    )
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, 'not_enabled')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

async function writeTemplateWorkbook(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Model')
  sheet.getCell('A1').value = 'Startup'
  sheet.getCell('B1').value = 'SAMPLE NAME'
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer())
  fs.writeFileSync(filePath, buffer)
}
