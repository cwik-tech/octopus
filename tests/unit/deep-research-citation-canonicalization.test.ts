import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  canonicalizeResearchCitations,
  collectCitationUrls,
} from '../../domains/deep-research/deep-research-citation-canonicalization.js'
import {
  isSourceSectionHeading,
  normalizeCitationUrl,
} from '../../domains/deep-research/deep-research-publication-audit.js'
import {
  makeEvidenceGraph,
  makeGraphClaim,
  makeGraphSource,
} from './deep-research-citation-fixtures.js'

const KNOWN = 'https://regulator.example/report'
const UNKNOWN = 'https://invented.example/hallucination'

function canonicalize(markdown: string, graph = makeEvidenceGraph()) {
  return canonicalizeResearchCitations({ markdown, evidenceGraph: graph })
}

test('canonicalizes an inline link and keeps its editorial label', () => {
  const result = canonicalize(`Adoption reached [the regulator filing](${KNOWN}) last year.`)
  assert.match(result.markdown, /\[the regulator filing\]\(https:\/\/regulator\.example\/report\)/u)
})

test('canonicalizes autolinks and bare URLs without inventing labels', () => {
  const result = canonicalize(`Auto <${KNOWN}> and bare ${KNOWN} here.`)
  assert.match(result.markdown, /Auto <https:\/\/regulator\.example\/report>/u)
  assert.match(result.markdown, /bare https:\/\/regulator\.example\/report here\./u)
})

test('canonicalizes a reference definition and leaves its reference intact', () => {
  const result = canonicalize(`See [the filing][r1].\n\n[r1]: ${KNOWN}\n`)
  assert.match(result.markdown, /See \[the filing\]\[r1\]\./u)
  assert.match(result.markdown, /\[r1\]: https:\/\/regulator\.example\/report/u)
})

test('preserves label numerals and caveat words so the audit invariants hold', () => {
  const result = canonicalize(
    `The [Q3 2025 disputed earnings review](${KNOWN}) matters.`,
  )
  assert.match(result.markdown, /\[Q3 2025 disputed earnings review\]/u)
  assert.doesNotMatch(
    result.markdown.split('## Sources')[0] ?? '',
    /Regulator Report/u,
  )
})

test('removes an unknown inline link but keeps its readable label', () => {
  const result = canonicalize(`Growth was [reportedly strong](${UNKNOWN}) in Q3.`)
  assert.match(result.markdown, /Growth was reportedly strong in Q3\./u)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
  assert.deepEqual(
    result.summary.removedUnknownUrls.map((entry) => entry.kind),
    ['inline_link'],
  )
  assert.equal(result.summary.removedUnknownUrls[0]?.url, UNKNOWN)
})

test('removes an unknown bare URL together with its wrapping punctuation', () => {
  const result = canonicalize(`See (${UNKNOWN}) for detail.`)
  assert.match(result.markdown, /^See for detail\./mu)
})

test('removes an unknown autolink and collapses the leftover spacing', () => {
  const result = canonicalize(`Evidence <${UNKNOWN}> supports it.`)
  assert.match(result.markdown, /^Evidence supports it\./mu)
})

test('drops a reference definition with an unknown URL and degrades its reference', () => {
  const result = canonicalize(`See [the claim][r9] here.\n\n[r9]: ${UNKNOWN}\n`)
  assert.match(result.markdown, /See the claim here\./u)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
})

test('never edits URLs inside code, HTML, or local images', () => {
  const markdown = [
    '```js',
    `const url = '${UNKNOWN}'`,
    '```',
    '',
    `Inline \`${UNKNOWN}\` stays.`,
    '',
    '![diagram](./local-diagram.png)',
    '',
    `Cited [filing](${KNOWN}).`,
  ].join('\n')
  const result = canonicalize(markdown)
  assert.match(result.markdown, /const url = 'https:\/\/invented\.example\/hallucination'/u)
  assert.match(result.markdown, /Inline `https:\/\/invented\.example\/hallucination` stays\./u)
  assert.match(result.markdown, /!\[diagram\]\(\.\/local-diagram\.png\)/u)
  assert.equal(result.summary.removedUnknownUrls.length, 0)
})

test('leaves an ambiguous numeric marker unmapped', () => {
  const result = canonicalize(`Adoption was 18% [3] according to the filing ${KNOWN}.`)
  assert.match(result.markdown, /\[3\]/u)
})

test('replaces every audit-recognized source heading with one generated section', () => {
  for (const heading of [
    'Source',
    'Sources',
    'Reference',
    'References',
    'Bibliography',
    'Works Cited',
    'Source list',
  ]) {
    const result = canonicalize(
      `Body cites [filing](${KNOWN}).\n\n## ${heading}\n\n- [Stale](${UNKNOWN})\n`,
    )
    assert.deepEqual(result.summary.removedSourceSectionHeadings, [heading])
    assert.equal(result.markdown.match(/^## Sources$/gmu)?.length, 1, heading)
    assert.doesNotMatch(result.markdown, /invented\.example/u)
  }
})

test('generates Sources from the runtime catalog in normalized URL order', () => {
  const graph = makeEvidenceGraph({
    sources: [
      makeGraphSource({ id: 'S2', canonicalUrl: 'https://zeta.example/b', title: 'Zeta Study' }),
      makeGraphSource({ id: 'S1', canonicalUrl: 'https://alpha.example/a', title: 'Alpha Study' }),
    ],
    claims: [makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S1'] })],
  })
  const result = canonicalize('Body text with no citations.', graph)
  const sources = result.markdown.slice(result.markdown.indexOf('## Sources'))
  assert.match(
    sources,
    /## Sources\n\n- \[Alpha Study\]\(https:\/\/alpha\.example\/a\)\n- \[Zeta Study\]\(https:\/\/zeta\.example\/b\)/u,
  )
  assert.equal(result.summary.generatedSourceCount, 2)
})

test('collapses duplicate catalog URLs and rejects conflicting titles', () => {
  const duplicate = makeEvidenceGraph({
    sources: [
      makeGraphSource({ id: 'S1' }),
      makeGraphSource({ id: 'S2' }),
    ],
  })
  assert.equal(canonicalize('Body.', duplicate).summary.generatedSourceCount, 1)

  const conflicting = makeEvidenceGraph({
    sources: [
      makeGraphSource({ id: 'S1', title: 'One Title' }),
      makeGraphSource({ id: 'S2', title: 'Another Title' }),
    ],
  })
  assert.throws(
    () => canonicalize('Body.', conflicting),
    /conflicting titles/u,
  )
})

test('rejects a supported claim backed by a non-usable source', () => {
  const graph = makeEvidenceGraph({
    sources: [makeGraphSource({ status: 'stale' })],
  })
  assert.throws(() => canonicalize('Body.', graph), /status is 'stale'/u)
})

test('rejects a supported claim whose supporting source is missing from the graph', () => {
  // The graph parser validates claim.sourceIds but not supportingSourceIds, so
  // this is the reachable path for an unresolvable supporting source.
  const graph = makeEvidenceGraph({
    claims: [makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S9'] })],
  })
  assert.throws(() => canonicalize('Body.', graph), /cannot resolve source 'S9'/u)
})

test('rejects a supported claim backed by a non-HTTP source URL', () => {
  const graph = makeEvidenceGraph({
    sources: [makeGraphSource({ canonicalUrl: 'ftp://regulator.example/report' })],
  })
  assert.throws(() => canonicalize('Body.', graph), /is not a valid HTTP\(S\) URL/u)
})

test('rejects a malformed evidence graph rather than skipping canonicalization', () => {
  assert.throws(
    () => canonicalizeResearchCitations({ markdown: 'Body.', evidenceGraph: { schemaVersion: 2 } }),
    /schema-v1/u,
  )
})

test('converts a labelled footnote citation into an inline link', () => {
  const result = canonicalize(`Adoption rose[^1].\n\n[^1]: [the filing](${KNOWN})\n`)
  assert.match(result.markdown, /Adoption rose\[the filing\]\(https:\/\/regulator\.example\/report\)\./u)
  assert.doesNotMatch(result.markdown, /\[\^1\]:/u)
})

test('labels a bare footnote citation with the neutral label', () => {
  const result = canonicalize(`Adoption rose[^1].\n\n[^1]: ${KNOWN}\n`)
  assert.match(result.markdown, /\[citation\]\(https:\/\/regulator\.example\/report\)/u)
})

test('never injects a runtime title into footnote claim text', () => {
  const result = canonicalize(`Adoption rose 18%[^1].\n\n[^1]: ${KNOWN}\n`)
  const body = result.markdown.split('## Sources')[0] ?? ''
  assert.doesNotMatch(body, /Regulator Report/u)
})

test('keeps explanatory prose as a footnote and the marker after the citations', () => {
  const result = canonicalize(
    `Adoption rose[^1].\n\n[^1]: See the methodology annex. ${KNOWN}\n`,
  )
  assert.match(result.markdown, /\[citation\]\(https:\/\/regulator\.example\/report\) \[\^1\]\./u)
  assert.match(result.markdown, /\[\^1\]: See the methodology annex\./u)
})

test('emits several ordered inline links for a multi-URL footnote', () => {
  const graph = makeEvidenceGraph({
    sources: [
      makeGraphSource({ id: 'S1', canonicalUrl: 'https://alpha.example/a', title: 'Alpha' }),
      makeGraphSource({ id: 'S2', canonicalUrl: 'https://beta.example/b', title: 'Beta' }),
    ],
    claims: [makeGraphClaim({ sourceIds: ['S1', 'S2'], supportingSourceIds: ['S1', 'S2'] })],
  })
  const result = canonicalize(
    'Adoption rose[^1].\n\n[^1]: https://alpha.example/a https://beta.example/b\n',
    graph,
  )
  assert.match(
    result.markdown,
    /\[citation\]\(https:\/\/alpha\.example\/a\) \[citation\]\(https:\/\/beta\.example\/b\)/u,
  )
})

test('collapses a footnote that repeats one normalized URL', () => {
  const result = canonicalize(`Rose[^1].\n\n[^1]: ${KNOWN} and ${KNOWN}\n`)
  assert.equal(
    result.markdown.match(/regulator\.example\/report/gu)?.length,
    2, // one inline citation plus the generated Sources entry
  )
})

test('rewrites every reference to the same footnote', () => {
  const result = canonicalize(`One[^1] and two[^1].\n\n[^1]: ${KNOWN}\n`)
  assert.equal(result.markdown.match(/\[citation\]/gu)?.length, 2)
})

test('drops a footnote whose only URL is unknown and blocks nothing else', () => {
  const result = canonicalize(`Rose[^1] sharply.\n\n[^1]: ${UNKNOWN}\n`)
  assert.match(result.markdown, /^Rose sharply\./mu)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
  assert.deepEqual(
    result.summary.removedUnknownUrls.map((entry) => entry.kind),
    ['footnote_definition'],
  )
})

test('strips an unknown URL from a footnote while keeping its prose', () => {
  const result = canonicalize(
    `Rose[^1].\n\n[^1]: Methodology annex follows. ${UNKNOWN}\n`,
  )
  assert.match(result.markdown, /\[\^1\]: Methodology annex follows\./u)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
})

test('relocates a footnote definition out of a removed source section', () => {
  const result = canonicalize(
    `Rose[^1].\n\n## References\n\n- [Stale](${UNKNOWN})\n\n[^1]: Methodology annex. ${KNOWN}\n`,
  )
  const footnoteAt = result.markdown.indexOf('[^1]: Methodology annex.')
  const sourcesAt = result.markdown.indexOf('## Sources')
  assert.ok(footnoteAt > 0, 'explanatory footnote survives section removal')
  assert.ok(footnoteAt < sourcesAt, 'footnote precedes the generated Sources')
  assert.doesNotMatch(result.markdown, /invented\.example/u)
})

test('treats a URL-backed [^3] as a citation and a plain [3] as prose', () => {
  const result = canonicalize(`A [3] marker and a real one[^3].\n\n[^3]: ${KNOWN}\n`)
  assert.match(result.markdown, /A \[3\] marker/u)
  assert.match(result.markdown, /\[citation\]\(https:\/\/regulator\.example\/report\)/u)
})

test('produces byte-identical output and hashes across runs', () => {
  const markdown = `Cited [filing](${KNOWN}) and stray ${UNKNOWN}.\n\n## References\n\n- old\n`
  const first = canonicalize(markdown)
  const second = canonicalize(markdown)
  assert.equal(first.markdown, second.markdown)
  assert.equal(first.summary.outputSha256, second.summary.outputSha256)
  assert.notEqual(first.summary.inputSha256, first.summary.outputSha256)
})

test('reports an output inventory equal to the graph baseline on the canonical path', () => {
  const result = canonicalize(
    `Cited [filing](${KNOWN}) plus stray ${UNKNOWN}.\n\n## Sources\n\n- old\n`,
  )
  assert.deepEqual(
    [...result.summary.publicationUrlInventory],
    [...result.summary.graphUrlBaseline],
  )
})

test('recovers the citation inventory by re-reading canonical Markdown', () => {
  assert.deepEqual(
    collectCitationUrls(`Body [a](${KNOWN}).\n\n\`\`\`\n${UNKNOWN}\n\`\`\`\n`),
    [KNOWN],
  )
})

test('shares the URL normalizer and heading predicate with the audit', () => {
  assert.equal(normalizeCitationUrl('https://a.example'), 'https://a.example/')
  assert.equal(normalizeCitationUrl('https://a.example/x.'), 'https://a.example/x')
  assert.equal(isSourceSectionHeading('  source LIST '), true)
  assert.equal(isSourceSectionHeading('Reference'), true)
  assert.equal(isSourceSectionHeading('Methodology'), false)
})

test('drops an unknown inline link whose label is the URL itself', () => {
  const result = canonicalize(`Growth was [${UNKNOWN}](${UNKNOWN}) last year.`)
  assert.match(result.markdown, /^Growth was last year\./mu)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
})

test('drops an unknown inline link whose label normalizes to the URL', () => {
  const result = canonicalize(
    `Growth was [HTTPS://INVENTED.EXAMPLE/hallucination](${UNKNOWN}) last year.`,
  )
  assert.match(result.markdown, /^Growth was last year\./mu)
  assert.doesNotMatch(result.markdown, /invented\.example/ui)
})

test('keeps a readable label that merely resembles the removed URL', () => {
  const result = canonicalize(
    `Growth was [see ${UNKNOWN} for context](${UNKNOWN}) last year.`,
  )
  assert.match(result.markdown, /Growth was see for context last year\./u)
})

test('wraps paren-bearing inline link URLs so the Markdown stays intact', () => {
  const url = 'https://en.wikipedia.org/wiki/Widget_(computing)'
  const graph = makeEvidenceGraph({
    sources: [makeGraphSource({ canonicalUrl: url, title: 'Wiki Study' })],
    claims: [makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S1'] })],
  })
  const result = canonicalize(`Adoption reached 18% [report](${url}).`, graph)
  assert.match(
    result.markdown,
    /\[report\]\(<https:\/\/en\.wikipedia\.org\/wiki\/Widget_\(computing\)>\)\./u,
  )
  const body = result.markdown.split('## Sources')[0] ?? ''
  assert.doesNotMatch(body, /\)\)\./u)
  assert.deepEqual(
    [...result.summary.publicationUrlInventory],
    [...result.summary.graphUrlBaseline],
  )
})

test('wraps unbalanced-paren URLs given as angle-bracket destinations', () => {
  const url = 'https://en.wikipedia.org/wiki/A_(b'
  const graph = makeEvidenceGraph({
    sources: [makeGraphSource({ canonicalUrl: url, title: 'Wiki Study' })],
    claims: [makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S1'] })],
  })
  const result = canonicalize(`Adoption reached 18% [report](<${url}>).`, graph)
  assert.match(
    result.markdown,
    /\[report\]\(<https:\/\/en\.wikipedia\.org\/wiki\/A_\(b>\)\./u,
  )
  assert.match(
    result.markdown,
    /- \[Wiki Study\]\(<https:\/\/en\.wikipedia\.org\/wiki\/A_\(b>\)/u,
  )
  assert.deepEqual(
    [...result.summary.publicationUrlInventory],
    [...result.summary.graphUrlBaseline],
  )
})

test('emits Sources entries with paren-bearing URLs wrapped', () => {
  const url = 'https://en.wikipedia.org/wiki/A)_b'
  const graph = makeEvidenceGraph({
    sources: [makeGraphSource({ canonicalUrl: url, title: 'Wiki Study' })],
    claims: [makeGraphClaim({ sourceIds: ['S1'], supportingSourceIds: ['S1'] })],
  })
  const result = canonicalize('Body text with no citations.', graph)
  assert.match(
    result.markdown,
    /- \[Wiki Study\]\(<https:\/\/en\.wikipedia\.org\/wiki\/A\)_b>\)/u,
  )
  assert.deepEqual(
    collectCitationUrls(result.markdown),
    [url],
  )
})

test('escapes bracket characters when re-emitting inline link labels', () => {
  const result = canonicalize(`See [report [final]](${KNOWN}) for detail.`)
  assert.match(
    result.markdown,
    /\[report \\\[final\\\]\]\(https:\/\/regulator\.example\/report\)/u,
  )
  assert.deepEqual(collectCitationUrls(result.markdown), [KNOWN])
})

test('does not double-escape labels that already escape their brackets', () => {
  const result = canonicalize(`See [report \\[final\\]](${KNOWN}) for detail.`)
  assert.match(
    result.markdown,
    /\[report \\\[final\\\]\]\(https:\/\/regulator\.example\/report\)/u,
  )
  assert.doesNotMatch(result.markdown, /\\\\\[/u)
})

test('omits the Sources section when the usable catalog is empty', () => {
  const graph = makeEvidenceGraph({ sources: [], claims: [] })
  const result = canonicalize('Body text.', graph)
  assert.equal(result.markdown, 'Body text.\n')
  assert.equal(result.summary.generatedSourceCount, 0)
})

test('drops a footnote whose only reference sat in a removed source section', () => {
  const result = canonicalize(
    [
      'Body text.',
      '',
      '## References',
      '',
      'See the annex[^1].',
      '',
      `[^1]: Methodology annex. ${KNOWN}`,
      '',
    ].join('\n'),
  )
  assert.match(result.markdown, /^Body text\./mu)
  assert.doesNotMatch(result.markdown, /\[\^1\]/u)
  assert.doesNotMatch(result.markdown, /Methodology annex/u)
  assert.match(
    result.markdown,
    /- \[Regulator Report\]\(https:\/\/regulator\.example\/report\)/u,
  )
})

test('drops an unreferenced footnote definition instead of orphaning it', () => {
  const result = canonicalize(
    `Body text.\n\n[^1]: Methodology annex. ${KNOWN}\n`,
  )
  assert.doesNotMatch(result.markdown, /\[\^1\]/u)
  assert.doesNotMatch(result.markdown, /Methodology annex/u)
})

test('resolves duplicate footnote definitions first-wins and drops the rest', () => {
  const result = canonicalize(
    `Rose[^1].\n\n[^1]: ${KNOWN}\n\n[^1]: Second definition ${UNKNOWN}\n`,
  )
  assert.match(
    result.markdown,
    /Rose\[citation\]\(https:\/\/regulator\.example\/report\)\./u,
  )
  assert.doesNotMatch(result.markdown, /Second definition/u)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
  assert.deepEqual(
    result.summary.removedUnknownUrls.map((entry) => entry.kind),
    ['footnote_definition'],
  )
})

test('canonical Markdown ends with exactly one newline and hashes those bytes', () => {
  const result = canonicalize(`Cited [filing](${KNOWN}).`)
  assert.ok(result.markdown.endsWith('\n'))
  assert.ok(!result.markdown.endsWith('\n\n'))
  assert.equal(
    result.summary.outputSha256,
    createHash('sha256').update(result.markdown).digest('hex'),
  )
})

test('resolves duplicate reference definitions first-wins and keeps the citation alive', () => {
  const result = canonicalize(
    `See [the filing][r1].\n\n[r1]: ${KNOWN}\n\n[r1]: ${UNKNOWN}\n`,
  )
  // CommonMark resolves the reference to the first definition, so the later
  // unknown duplicate must not degrade a live citation to plain text.
  assert.match(result.markdown, /See \[the filing\]\[r1\]\./u)
  assert.equal(result.markdown.match(/\[r1\]:/gu)?.length, 1)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
  assert.deepEqual(
    result.summary.removedUnknownUrls.map((entry) => entry.kind),
    ['reference_definition'],
  )
})

test('drops a duplicate reference definition that outlives its removed first definition', () => {
  const result = canonicalize(
    `See [the claim][r1].\n\n[r1]: ${UNKNOWN}\n\n[r1]: ${KNOWN}\n`,
  )
  // First-wins: the reference resolved to the removed URL and degrades.
  assert.match(result.markdown, /See the claim\./u)
  // The dead later definition follows its first definition instead of
  // surviving as an unreferenced block.
  assert.doesNotMatch(result.markdown, /\[r1\]:/u)
  assert.deepEqual(
    [...result.summary.publicationUrlInventory],
    [...result.summary.graphUrlBaseline],
  )
})

test('a reference inside a dropped duplicate footnote cannot keep its target alive', () => {
  const result = canonicalize(
    `Rose[^1].\n\n[^1]: First note. ${KNOWN}\n\n[^1]: Duplicate see[^2].\n\n[^2]: Orphan note.\n`,
  )
  assert.match(
    result.markdown,
    /Rose\[citation\]\(https:\/\/regulator\.example\/report\) \[\^1\]\./u,
  )
  assert.doesNotMatch(result.markdown, /Duplicate/u)
  assert.doesNotMatch(result.markdown, /Orphan note/u)
  assert.doesNotMatch(result.markdown, /\[\^2\]/u)
})

test('removes the empty wrappers a stripped URL leaves inside a preserved label', () => {
  const result = canonicalize(
    `See [evidence <${UNKNOWN}> and context (${UNKNOWN})](${UNKNOWN}) here.`,
  )
  assert.match(result.markdown, /See evidence and context here\./u)
  assert.doesNotMatch(result.markdown, /invented\.example/u)
})

test('inventory recovers raw URLs embedded in kept link labels', () => {
  assert.deepEqual(
    collectCitationUrls(`Body [note https://blog.example/post](${KNOWN}).`),
    ['https://blog.example/post', KNOWN],
  )
})

test('inventory counts HTTP image URLs but never local image paths', () => {
  assert.deepEqual(
    collectCitationUrls(
      'Body ![chart](https://img.example/chart.png) and ![local](./diagram.png).',
    ),
    ['https://img.example/chart.png'],
  )
})
