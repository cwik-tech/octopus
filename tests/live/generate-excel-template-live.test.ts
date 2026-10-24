import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import XlsxPopulate from 'xlsx-populate'

import { generateExcelToolModule } from '../../server/tools/generate-excel.js'
import {
  executeProvider,
  getProvider,
  initProviders,
} from '../../providers/index.js'
import { McpClientManager } from '../../domains/mcp/mcp-client-manager.js'
import { McpParentBroker } from '../../domains/mcp/mcp-parent-broker.js'
import { UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE } from '../../services/capability-dispatch-lifecycle.js'
import { McpRunLeaseStore } from '../../domains/mcp/mcp-run-lease-store.js'
import { buildSessionRunAssignmentLocation } from '../../domains/run/run-location.js'
import { GenerateExcelToolService } from '../../services/generate-excel-tool-service.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'
import { McpAgentToolService } from '../../services/mcp-agent-tool-service.js'
import { McpSettingsService } from '../../services/mcp-settings-service.js'
import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import {
  cliCapability,
  createLiveSecretCodec,
  createLiveTempDirectory,
  liveTest,
} from './live-provider-support.js'

initProviders()

const repoRoot = process.cwd()
const codexCapability = await cliCapability('codex')
const configuredModel =
  process.env.PIPELINE_LIVE_CODEX_MODEL?.trim() || 'gpt-5.4'

const FIRST_RISK = 'Key-person dependency on the spray process'

liveTest(
  'codex fills the risk-register Excel template through a real generate_excel tool call',
  'codex',
  codexCapability,
  async () => {
    // Realpath so the service's symlink-safe assignment checks pass on macOS,
    // where os.tmpdir() lives behind the /var -> /private/var symlink.
    const directory = fs.realpathSync(
      createLiveTempDirectory('codex-generate-excel-live-'),
    )
    const workspacePath = path.join(directory, 'workspace')
    const identity = {
      sessionId: '77777777-7777-4777-8777-777777777777',
      runId: '88888888-8888-4888-8888-888888888888',
      assignmentId: '99999999-9999-4999-8999-999999999999',
    }
    const manager = new McpClientManager({
      connectTimeoutMs: 5_000,
      requestTimeoutMs: 30_000,
      closeTimeoutMs: 2_000,
    })
    const settings = new McpSettingsService({
      storagePath: path.join(directory, 'mcps.json'),
      secretCodec: createLiveSecretCodec(),
      clientManager: manager,
    })
    const providerSettings = new ProviderSettingsService({
      storagePath: path.join(directory, 'providers.json'),
    })
    const leases = new McpRunLeaseStore()
    const broker = new McpParentBroker({
      lifecycle: UNMANAGED_CAPABILITY_DISPATCH_LIFECYCLE,
      settingsService: settings,
      clientManager: manager,
      grantResolver: ({ context, serverId }) =>
        settings.isAgentGranted(context.agentPath, serverId),
      leaseResolver: (context) => leases.resolve(context),
    })

    try {
      const location = buildSessionRunAssignmentLocation(workspacePath, identity)
      assert.ok(location)
      fs.mkdirSync(location.assignmentPath, { recursive: true })
      fs.writeFileSync(
        path.join(location.assignmentPath, 'risk-data.json'),
        JSON.stringify({
          tables: {
            risks: [
              {
                risk: FIRST_RISK,
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
                effort: 1,
                jira_issue: '',
                mitigation_strategy: 'Transference',
                action: 'Engage external counsel',
                status: 'Doing',
                accountable: 'Lawyers',
                action_description: 'Track filing milestones weekly.',
              },
            ],
          },
        }, null, 2),
      )

      if (configuredModel !== 'default') {
        const discovered = (await providerSettings.listCliAgents(true)).find(
          (candidate) => candidate.id === 'codex',
        )
        assert.ok(
          discovered?.models.some((model) => model.id === configuredModel),
          `codex did not advertise model ${configuredModel}`,
        )
        await providerSettings.setCliModelEnabled('codex', configuredModel, true)
      }
      const readiness = (await providerSettings.listCliAgents(true)).find(
        (candidate) => candidate.id === 'codex',
      )
      assert.equal(readiness?.mcpBridge.supported, true, readiness?.error)

      let cliFailure: unknown
      const generateExcelToolService = new GenerateExcelToolService({
        workspacePath,
        repoRootPath: repoRoot,
      })
      const generateExcelAgentTool = generateExcelToolModule.build({
        capabilityDispatcher: createCapabilityTestDispatcher(),
        moduleOptions: {
          "generate-excel": { toolService: generateExcelToolService },
        },
      }).agentTool
      assert.ok(generateExcelAgentTool)
      const service = new McpAgentToolService({
        broker,
        leaseStore: leases,
        providerSettingsService: providerSettings,
        builtinAgentTools: [generateExcelAgentTool],
        cliProviderExecutor: async (providerId, options) => {
          try {
            return await executeProvider(getProvider(providerId), options)
          } catch (error) {
            cliFailure = error
            throw error
          }
        },
      })

      let result
      try {
        result = await service.runTurn({
          ...identity,
          agentPath: 'agents/vc-financial-modeler',
          provider: 'codex',
          model: configuredModel,
          thinking: 'low',
          cwd: location.assignmentPath,
          systemPrompt: [
            'You have exactly one MCP tool available; it runs the deterministic Generate Excel engine.',
            'A JSON data artifact named risk-data.json already exists in your working directory.',
            'Do not create, edit, or inspect files yourself.',
            'Call the tool exactly once with these arguments:',
            '{"action":"fill_template","template":"risk-register","inputPath":"risk-data.json","outputPath":"risk-register.xlsx"}.',
            'After the tool returns, reply with only the outputPath value from the tool result.',
          ].join(' '),
          userMessage:
            "Fill this week's risk register from risk-data.json using the risk-register template.",
          signal: AbortSignal.timeout(240_000),
        })
      } catch (error) {
        if (cliFailure instanceof Error) {
          throw new Error(cliFailure.message, { cause: error })
        }
        throw error
      }

      assert.equal(result.kind, 'completed')
      if (result.kind !== 'completed') return
      assert.ok(
        result.result.executedToolCallCount >= 1,
        `provider response: ${result.result.text}`,
      )

      const outputPath = path.join(location.assignmentPath, 'risk-register.xlsx')
      assert.ok(
        fs.existsSync(outputPath),
        `risk-register.xlsx was not created; provider response: ${result.result.text}`,
      )
      const buffer = fs.readFileSync(outputPath)
      assert.equal(buffer.subarray(0, 2).toString('ascii'), 'PK')

      const workbook = await XlsxPopulate.fromDataAsync(buffer)
      const risks = workbook.sheet('Risks')
      assert.ok(risks)
      assert.equal(risks.cell('B2').value(), FIRST_RISK)
      assert.equal(risks.cell('C3').value(), 'Regulatory')
      // Template formulas must survive the LLM-triggered fill untouched.
      assert.equal(risks.cell('A2').formula(), 'ROW()-1')
      const summary = workbook.sheet('Risk summary')
      assert.ok(summary)
      assert.match(summary.cell('D5').formula() ?? '', /COUNTIFS/)
      assert.equal(leases.size, 0)
    } finally {
      await settings.closeAll().catch(() => undefined)
      fs.rmSync(directory, { recursive: true, force: true })
    }
  },
  300_000,
)
