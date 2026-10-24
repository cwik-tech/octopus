import assert from 'node:assert/strict'
import test from 'node:test'

import {
  decideWebResearchLinks,
  enforceWebResearchEvidence,
  INSUFFICIENT_WEB_RESEARCH_RESPONSE,
  stripTrailingFollowUpInvitation,
  type ObservedWebSource,
} from '../../domains/browser/web-research-evidence.js'

test('web research recommendations require two relevant cited hosts', () => {
  const answer = [
    'HOMES is the strongest supported pick.',
    'https://homes.example/ann-arbor-beer',
    'https://local.example/ann-arbor-brewery-guide',
  ].join('\n')
  assert.equal(enforceWebResearchEvidence({
    question: 'What is the best beer in Ann Arbor?',
    answer,
    sources: [
      {
        url: 'https://homes.example/ann-arbor-beer',
        title: 'HOMES Brewery - Ann Arbor beer',
        text: 'Ann Arbor beer guide names HOMES Brewery as a leading local brewery.',
      },
      {
        url: 'https://local.example/ann-arbor-brewery-guide',
        title: 'Ann Arbor brewery guide',
        text: 'Our Ann Arbor beer comparison places HOMES among the best breweries.',
      },
    ],
  }), answer)
})

test('web research rejects a recommendation supported by only one relevant page', () => {
  assert.equal(enforceWebResearchEvidence({
    question: 'What are the best burgers in Ann Arbor?',
    answer: 'Frita Batidos is best. https://search.example/best-burgers-ann-arbor',
    sources: [{
      url: 'https://search.example/best-burgers-ann-arbor',
      title: 'Best burgers in Ann Arbor',
      text: 'Best burgers in Ann Arbor include Frita Batidos.',
    }],
  }), INSUFFICIENT_WEB_RESEARCH_RESPONSE)
})

test('web research does not count www and bare-host aliases as independent sources', () => {
  assert.equal(enforceWebResearchEvidence({
    question: 'What is the best beer in Ann Arbor?',
    answer: [
      'HOMES is best.',
      'https://example.com/ann-arbor-beer',
      'https://www.example.com/local-brewery-guide',
    ].join('\n'),
    sources: [
      {
        url: 'https://example.com/ann-arbor-beer',
        title: 'Ann Arbor beer guide',
        text: 'An Ann Arbor beer guide recommends HOMES Brewery.',
      },
      {
        url: 'https://www.example.com/local-brewery-guide',
        title: 'Best breweries in Ann Arbor',
        text: 'A comparison of the best Ann Arbor breweries includes HOMES.',
      },
    ],
  }), INSUFFICIENT_WEB_RESEARCH_RESPONSE)
})

test('web research rejects completed pages about the wrong location or subject', () => {
  assert.equal(enforceWebResearchEvidence({
    question: 'What is the best beer in Ann Arbor?',
    answer: [
      'HOMES is best.',
      'https://beer.example/baltimore',
      'https://culture.example/',
    ].join('\n'),
    sources: [
      {
        url: 'https://beer.example/baltimore',
        title: 'Beer Guide: Baltimore, Maryland',
        text: 'A directory of breweries and beer in Baltimore, Maryland.',
      },
      {
        url: 'https://culture.example/',
        title: 'Hop Culture',
        text: 'General beer stories, travel guides, and brewery news.',
      },
    ],
  }), INSUFFICIENT_WEB_RESEARCH_RESPONSE)
})

test('same-page observations of equal text length resolve independently of arrival order', () => {
  // Distinct raw URLs that collapse to one normalized URL: the gateway retains
  // them separately, deduplicateSources merges them, and its comparator picks
  // the survivor. With equal text lengths, first-writer-wins would make the
  // verdict depend on completion order once the observing capability is
  // audited parallel-safe.
  const answer = 'Acme Robotics was founded by Ada Lee. https://acme.example/history'
  const relevant = {
    url: 'https://acme.example/history#team',
    title: 'Acme Robotics history',
    text: 'Founded by Ada Lee, Acme Robotics ships arms.',
  }
  const unrelated = {
    url: 'https://acme.example/history',
    title: 'Regional support hours',
    text: 'Careers pages for the regional support teams.',
  }
  assert.equal(
    relevant.text.length,
    unrelated.text.length,
    'the tie-break under test only applies to equal text lengths',
  )

  const forward = enforceWebResearchEvidence({
    question: 'Who founded Acme Robotics?',
    answer,
    sources: [relevant, unrelated],
  })
  const reversed = enforceWebResearchEvidence({
    question: 'Who founded Acme Robotics?',
    answer,
    sources: [unrelated, relevant],
  })

  assert.equal(forward, reversed)
  // Value-determined, not arrival-determined: the lexicographically greater
  // text wins, which here is the relevant observation.
  assert.equal(forward, answer)
})

test('one relevant cited page is sufficient for a non-comparative factual answer', () => {
  const answer = 'Acme Robotics was founded by Ada Lee. https://acme.example/history'
  assert.equal(enforceWebResearchEvidence({
    question: 'Who founded Acme Robotics?',
    answer,
    sources: [{
      url: 'https://acme.example/history',
      title: 'Acme Robotics history',
      text: 'Acme Robotics was founded by Ada Lee in 2018.',
    }],
  }), answer)
})

test('insufficient-evidence answers are canonicalized and lose unsupported claims', () => {
  assert.equal(enforceWebResearchEvidence({
    question: 'What is the best beer in Ann Arbor?',
    answer: [
      "HOMES is probably best, but I couldn't verify this from enough relevant sources.",
      '',
      'If you want, I can try another search.',
    ].join('\n'),
    sources: [],
  }), INSUFFICIENT_WEB_RESEARCH_RESPONSE)
  assert.equal(
    stripTrailingFollowUpInvitation('Direct answer. Would you like more detail?'),
    'Direct answer.',
  )
})

function makeObservedSource(
  url: string,
  overrides: Partial<ObservedWebSource> = {},
): ObservedWebSource {
  return {
    url,
    title: 'Ann Arbor beer guide',
    text: 'An Ann Arbor beer guide recommends HOMES Brewery as a leading local brewery.',
    ...overrides,
  }
}

function makeAcmeSource(url: string): ObservedWebSource {
  return {
    url,
    title: 'Acme Robotics history',
    text: 'Acme Robotics was founded by Ada Lee in 2018.',
  }
}

test('a discovery-only URL is rejected even when acquired hosts pass the count', () => {
  // The incident shape: two acquired pages satisfy the host threshold, but the
  // answer also cites a third URL that only ever appeared in search discovery.
  // Other valid citations cannot offset an unobserved URL.
  const decision = decideWebResearchLinks({
    question: 'What is the best beer in Ann Arbor?',
    answer: [
      'HOMES is the strongest supported pick.',
      'https://homes.example/ann-arbor-beer',
      'https://local.example/ann-arbor-brewery-guide',
      'https://search.example/discovery-only-result',
    ].join('\n'),
    sources: [
      makeObservedSource('https://homes.example/ann-arbor-beer'),
      makeObservedSource('https://local.example/ann-arbor-brewery-guide'),
    ],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'unobserved_url',
    citedUrlCount: 3,
    observedUrlCount: 2,
    unobservedUrlCount: 1,
  })
})

test('a markdown link to an observed source is accepted and keeps its markdown', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer:
      'Acme Robotics was founded by Ada Lee ([history](https://acme.example/history)).',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer:
      'Acme Robotics was founded by Ada Lee ([history](https://acme.example/history)).',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('a bare URL with trailing punctuation is accepted without the punctuation', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: 'See https://acme.example/history.',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer: 'See https://acme.example/history.',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('a cited fragment rewrites to the canonical URL the runtime holds', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: 'Ada Lee founded Acme. https://acme.example/history#team',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer: 'Ada Lee founded Acme. https://acme.example/history',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('a cited trailing slash rewrites to the canonical URL the runtime holds', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: 'Ada Lee founded Acme. https://acme.example/history/',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer: 'Ada Lee founded Acme. https://acme.example/history',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('duplicate aliases of one observed page count once and both rewrite', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: [
      'Ada Lee founded Acme. https://acme.example/history#team',
      'Again: https://acme.example/history/',
    ].join('\n'),
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer: [
      'Ada Lee founded Acme. https://acme.example/history',
      'Again: https://acme.example/history',
    ].join('\n'),
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('an invalid URL in the answer fails closed as unobserved', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: 'Ada Lee founded Acme. https://acme.example/history and http://:8080',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'unobserved_url',
    citedUrlCount: 1,
    observedUrlCount: 1,
    unobservedUrlCount: 1,
  })
})

test('an empty answer reports answer_empty', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: '   ',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'answer_empty',
    citedUrlCount: 0,
    observedUrlCount: 1,
    unobservedUrlCount: 0,
  })
})

test('an answer that declares its own insufficiency reports it', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: "I couldn't verify this from enough relevant sources.",
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'answer_declared_insufficient',
    citedUrlCount: 0,
    observedUrlCount: 1,
    unobservedUrlCount: 0,
  })
})

test('observed but irrelevant sources still fail the host count', () => {
  const decision = decideWebResearchLinks({
    question: 'What is the best beer in Ann Arbor?',
    answer: [
      'HOMES is best.',
      'https://beer.example/baltimore',
      'https://culture.example/',
    ].join('\n'),
    sources: [
      makeObservedSource('https://beer.example/baltimore', {
        title: 'Beer Guide: Baltimore, Maryland',
        text: 'A directory of breweries and beer in Baltimore, Maryland.',
      }),
      makeObservedSource('https://culture.example/', {
        title: 'Hop Culture',
        text: 'General beer stories, travel guides, and brewery news.',
      }),
    ],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'not_enough_relevant_sources',
    citedUrlCount: 2,
    observedUrlCount: 2,
    unobservedUrlCount: 0,
  })
})

test('an uppercase-scheme URL cannot bypass the observation check', () => {
  // One observed URL plus an uppercase-spelled unobserved one: the leak must
  // not slip past extraction, and the observed citation cannot offset it.
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: [
      'Ada Lee founded Acme. https://acme.example/history',
      'HTTPS://unobserved.example/leak',
    ].join('\n'),
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'insufficient',
    reason: 'unobserved_url',
    citedUrlCount: 2,
    observedUrlCount: 1,
    unobservedUrlCount: 1,
  })
})

test('mixed-case scheme and host spellings match and render canonically', () => {
  const decision = decideWebResearchLinks({
    question: 'Who founded Acme Robotics?',
    answer: 'Ada Lee founded Acme. HTTPS://ACME.EXAMPLE/history',
    sources: [makeAcmeSource('https://acme.example/history')],
  })
  assert.deepEqual(decision, {
    kind: 'accepted',
    answer: 'Ada Lee founded Acme. https://acme.example/history',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})

test('canonical URL selection is a pure function of the observation set', () => {
  // Repeated raw URLs at different strengths plus a normalized alias: the
  // longest-text observation must win regardless of arrival order, and the
  // accepted answer must be identical for every permutation.
  const weak = {
    url: 'https://acme.example/history',
    title: 'Acme Robotics history',
    text: 'Short note.',
  }
  const strong = {
    url: 'https://acme.example/history',
    title: 'Acme Robotics history',
    text: 'Acme Robotics was founded by Ada Lee in 2018, in full detail.',
  }
  const alias = {
    url: 'https://acme.example/history#team',
    title: 'Acme Robotics history',
    text: 'Medium length observation of the team page.',
  }
  const orders = [
    [weak, strong, alias],
    [alias, weak, strong],
    [strong, alias, weak],
    [weak, alias, strong],
  ]
  const decisions = orders.map((sources) =>
    decideWebResearchLinks({
      question: 'Who founded Acme Robotics?',
      answer: 'Ada Lee founded Acme. https://acme.example/history',
      sources,
    }),
  )
  for (const decision of decisions) {
    assert.deepEqual(decision, decisions[0])
  }

  // The tie case: identical title AND text, distinguished only by the raw URL
  // spelling. The comparator must still be a total order, so the same
  // canonical spelling wins under every permutation — never the first arrival.
  const bare = {
    url: 'https://acme.example/history',
    title: 'Acme Robotics history',
    text: 'Acme Robotics was founded by Ada Lee in 2018.',
  }
  const fragment = {
    url: 'https://acme.example/history#team',
    title: 'Acme Robotics history',
    text: 'Acme Robotics was founded by Ada Lee in 2018.',
  }
  const tieOrders = [
    [bare, fragment],
    [fragment, bare],
  ]
  const tieDecisions = tieOrders.map((sources) =>
    decideWebResearchLinks({
      question: 'Who founded Acme Robotics?',
      answer: 'Ada Lee founded Acme. https://acme.example/history',
      sources,
    }),
  )
  for (const decision of tieDecisions) {
    assert.deepEqual(decision, tieDecisions[0])
  }
  // The winner is pinned, not merely consistent: the comparator's final
  // tiebreaker is the raw canonical URL string, greater spelling winning as
  // with text and title.
  assert.deepEqual(tieDecisions[0], {
    kind: 'accepted',
    answer: 'Ada Lee founded Acme. https://acme.example/history#team',
    citedUrlCount: 1,
    observedUrlCount: 1,
  })
})
