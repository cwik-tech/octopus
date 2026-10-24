import test from 'node:test';
import assert from 'node:assert/strict';
import { remapPortableTeam, isPrivateResourcePath } from '../../domains/resource-library/portable-resources.js';
import { parseYaml } from '../../core/yaml-parser.js';

test('portable Team remapping preserves behavior while renaming exact resource references', () => {
  const yaml = 'team:\n  name: board\n  description: Keep alpha safe\nagents:\n  - name: alpha\n    type: agent\n    role: Planner\n    agent_file: ../../agents/alpha/alpha.md\n    tools: []\nworkflow:\n  participants:\n    - alpha\n';
  const mapped = remapPortableTeam(yaml, new Map([['alpha', 'alpha-imported']]), new Map([['board', 'board-imported']]));
  assert.deepEqual(parseYaml(mapped), {
    team: { name: 'board-imported', description: 'Keep alpha safe' },
    agents: [{ name: 'alpha-imported', type: 'agent', role: 'Planner', agent_file: '../../agents/alpha-imported/alpha-imported.md', tools: [] }],
    workflow: { participants: ['alpha-imported'] },
  });
  assert.equal(remapPortableTeam(yaml, new Map([['alpha', 'alpha']]), new Map([['board', 'board']])), yaml);
});

test('portable resources exclude memory and credentials while retaining supporting scripts', () => {
  assert.equal(isPrivateResourcePath('experience/private.md'), true);
  assert.equal(isPrivateResourcePath('.env.production'), true);
  assert.equal(isPrivateResourcePath('credentials/token.json'), true);
  assert.equal(isPrivateResourcePath('scripts/loader.mjs'), false);
  assert.equal(isPrivateResourcePath('references/guide.md'), false);
});
