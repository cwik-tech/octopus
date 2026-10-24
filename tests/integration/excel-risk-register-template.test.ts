import assert from 'node:assert/strict'
import test from 'node:test'

import XlsxPopulate from 'xlsx-populate'

import {
  excelTemplateSummary,
  fillExcelTemplate,
  listExcelTemplates,
  loadExcelTemplate,
  parseExcelTemplateData,
  resolveDefaultExcelTemplatesRoot,
} from '../../domains/excel-generation/excel-templates.js'

test('shipped risk-register template fills rows without touching template formulas', async () => {
  const templatesRoot = resolveDefaultExcelTemplatesRoot()
  const listed = listExcelTemplates(templatesRoot)
  assert.deepEqual(listed.warnings, [])
  assert.ok(listed.templates.some((entry) => entry.manifest.id === 'risk-register'))

  const template = loadExcelTemplate(templatesRoot, 'risk-register')
  const summary = excelTemplateSummary(template)
  assert.equal(summary.tables[0]?.name, 'risks')
  assert.equal(summary.tables[0]?.columns.length, 12)
  assert.equal(summary.tables[0]?.maxRows, 83)

  const filled = await fillExcelTemplate(template, parseExcelTemplateData({
    tables: {
      risks: [
        {
          risk: 'Key-person dependency on spray process',
          category: 'Operations',
          likelihood: 'Med',
          severity: 'High',
          priority: 'Y',
          effort: 2,
          jira_issue: 'RISK-1',
          mitigation_strategy: 'Control',
          action: 'Cross-train a second engineer',
          status: 'To Do',
          accountable: 'CEO',
          action_description: 'Document the spray process and rotate ownership.',
        },
        {
          risk: 'Regulatory approval slips a quarter',
          category: 'Regulatory',
          likelihood: 'Low',
          severity: 'High',
          priority: 'N',
          effort: 3,
          jira_issue: '',
          mitigation_strategy: 'Transference',
          action: 'Engage external counsel',
          status: 'Doing',
          accountable: 'Lawyers',
          action_description: 'Track filing milestones weekly.',
        },
      ],
    },
  }))
  assert.deepEqual(filled.warnings, [])

  const workbook = await XlsxPopulate.fromDataAsync(filled.buffer)
  const risks = workbook.sheet('Risks')
  assert.ok(risks)
  assert.equal(risks.cell('B2').value(), 'Key-person dependency on spray process')
  assert.equal(risks.cell('C2').value(), 'Operations')
  assert.equal(risks.cell('G2').value(), 2)
  assert.equal(risks.cell('B3').value(), 'Regulatory approval slips a quarter')
  // The prefilled '#' numbering formulas in column A must survive the fill.
  assert.equal(risks.cell('A2').formula(), 'ROW()-1')
  // Unused register rows inside the region are cleared.
  assert.equal(risks.cell('B4').value(), undefined)
  assert.equal(risks.cell('M84').value(), undefined)

  const riskSummary = workbook.sheet('Risk summary')
  assert.ok(riskSummary)
  assert.match(riskSummary.cell('D5').formula() ?? '', /COUNTIFS/)
  assert.equal(riskSummary.cell('G5').formula(), 'SUM(D5:F5)')

  const lists = workbook.sheet('Lists')
  assert.ok(lists)
  assert.equal(lists.cell('B4').value(), 'High')
})
