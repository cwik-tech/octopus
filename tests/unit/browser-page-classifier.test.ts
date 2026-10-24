import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyBrowserPage } from '../../domains/browser/browser-page-classifier.js'

const usablePage = {
  title: 'Research report',
  url: 'https://example.com/report',
  text: 'Independent evidence with enough usable page content.',
  elementCount: 1,
  elements: [{ name: 'Read report', role: 'link' }],
  frames: [],
  blockCount: 1,
  hasVisualContent: false,
}

test('browser page classifier recognizes common challenge-page language', () => {
  for (const text of [
    'Our systems have detected unusual traffic from your computer network. CAPTCHA required.',
    'Verify your device before continuing.',
    'Checking your browser before accessing the site.',
    'Attention required! Cloudflare. Verify you are human.',
  ]) {
    assert.equal(classifyBrowserPage({ ...usablePage, text })?.code, 'access_challenge')
  }
})

test('browser page classifier maps unusable HTTP responses and empty output', () => {
  assert.equal(classifyBrowserPage({ ...usablePage, httpStatus: 403 })?.code, 'access_denied')
  assert.equal(classifyBrowserPage({ ...usablePage, httpStatus: 429 })?.code, 'rate_limited')
  assert.equal(classifyBrowserPage({ ...usablePage, httpStatus: 404 })?.code, 'not_found')
  assert.equal(classifyBrowserPage({
    title: '',
    url: 'https://example.com/blank',
    text: '',
    elementCount: 0,
    elements: [],
    frames: [],
    blockCount: 0,
    hasVisualContent: false,
  })?.code, 'empty_content')
})

test('browser page classifier accepts usable evidence pages', () => {
  assert.equal(classifyBrowserPage({ ...usablePage, httpStatus: 200 }), null)
})

test('browser page classifier recognizes a YouTube consent wall', () => {
  assert.equal(classifyBrowserPage({
    ...usablePage,
    title: 'Before you continue to YouTube',
    text: 'Review your cookie choices before continuing.',
  })?.code, 'access_challenge')
})

test('human verification behavior is a CAPTCHA without a site-specific rule', () => {
  const problem = classifyBrowserPage({
    ...usablePage,
    httpStatus: 403,
    title: 'Verification Required',
    text: [
      'The visual verification might not be accessible to you.',
      'Use the audio verification to hear six digits.',
      'Slide right to secure your access.',
      'We detected unusual activity from your device or network.',
    ].join(' '),
    elements: [
      { name: 'Play audio verification', role: 'button' },
      { name: 'Slide right to secure your access', role: 'slider' },
    ],
    frames: [{ title: 'You have been blocked', allowed: true }],
  })

  assert.equal(problem?.code, 'access_challenge')
  assert.equal(problem?.challengeType, 'captcha')
})

test('an article about verification controls is not a challenge', () => {
  assert.equal(classifyBrowserPage({
    ...usablePage,
    httpStatus: 200,
    title: 'Verification Required in accessibility testing',
    text: 'This report compares visual verification with audio verification and explains how to slide right without excluding keyboard users.',
  }), null)
})

/**
 * The challenge taxonomy.
 *
 * Every literal below is a whole page as a reader would meet it, because the
 * rule under test is "what is this page", not "does this string appear". The
 * last case is the one that makes the taxonomy trustworthy: a page that talks
 * about CAPTCHAs is ordinary evidence, not a wall.
 */
const CHALLENGE_SUBTYPE_PAGES = [
  {
    subtype: 'captcha' as const,
    title: 'Verification required',
    text: 'Please complete the reCAPTCHA below to confirm you are human before we can show this page.',
  },
  {
    subtype: 'browser-verification' as const,
    title: 'Just a moment...',
    text: 'Checking your browser before accessing the site. This process is automatic and will finish shortly.',
  },
  {
    subtype: 'consent-wall' as const,
    title: 'Before you continue to YouTube',
    text: 'We use cookies and data to deliver services. Review your cookie choices to carry on.',
  },
  {
    subtype: 'login-wall' as const,
    title: 'Members only',
    text: 'Sign in to continue reading this article. Subscribers get unlimited access to every report.',
  },
  {
    subtype: 'unknown' as const,
    title: 'Sorry',
    text: 'Our systems have detected unusual traffic from your computer network and cannot serve this page.',
  },
]

test('the challenge classifier names each wall it recognizes', () => {
  for (const page of CHALLENGE_SUBTYPE_PAGES) {
    const problem = classifyBrowserPage({
      ...usablePage,
      title: page.title,
      text: page.text,
    })
    assert.equal(problem?.code, 'access_challenge', page.subtype)
    assert.equal(problem?.challengeType, page.subtype, page.text)
  }
})

/**
 * The message an agent reads has to match the wall it met.
 *
 * Calling a cookie banner or a paywall a CAPTCHA is not a wording quibble: the
 * agent decides what to do next from this sentence, and "anti-bot verification"
 * suggests waiting or retrying where "sign-in wall" suggests finding another
 * source. Challenged content stays inadmissible either way.
 */
test('a challenge message describes the wall it actually met', () => {
  const messageFor = (subtype: string): string => {
    const page = CHALLENGE_SUBTYPE_PAGES.find(
      (candidate) => candidate.subtype === subtype,
    )
    assert.ok(page, subtype)
    const problem = classifyBrowserPage({
      ...usablePage,
      title: page.title,
      text: page.text,
    })
    assert.equal(problem?.code, 'access_challenge', subtype)
    return String(problem?.message)
  }

  assert.match(messageFor('consent-wall'), /consent|cookie/iu)
  assert.doesNotMatch(
    messageFor('consent-wall'),
    /captcha|anti-bot/iu,
    'a cookie consent wall is not a CAPTCHA',
  )
  assert.match(messageFor('login-wall'), /sign[- ]?in|login|subscription/iu)
  assert.doesNotMatch(
    messageFor('login-wall'),
    /captcha|anti-bot/iu,
    'a sign-in wall is not a CAPTCHA',
  )
  assert.match(messageFor('captcha'), /captcha/iu)
  assert.match(messageFor('browser-verification'), /browser|device/iu)

  for (const page of CHALLENGE_SUBTYPE_PAGES) {
    assert.match(
      messageFor(page.subtype),
      /not usable evidence|another source/iu,
      `${page.subtype} must stay inadmissible`,
    )
  }
})

test('an article about CAPTCHAs stays usable evidence', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      title: 'How CAPTCHA systems evolved',
      text: 'A CAPTCHA is a test that tells humans and computers apart. Early captcha images used distorted text; later designs measure behaviour instead.',
    }),
    null,
  )
})

/**
 * The counterexample that keeps the rule honest.
 *
 * This page says every phrase the wall says, including the notice sentence
 * itself, because it is reporting on what those walls say. It is evidence. The
 * rule is "the notice is the entire page", not "the page mentions cookies".
 */
test('a substantive article about cookie consent stays usable evidence', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      httpStatus: 200,
      title: 'How consent walls changed European news sites',
      text: [
        'Publishers across the EU now open with a banner saying that we use cookies and process personal data for advertising and measurement.',
        'Our survey of forty newsrooms found that twenty-eight present a reject-all control beside accept all cookies, while the rest bury the choice inside cookie settings two clicks away.',
        'Regulators in France and Germany fined four publishers during 2025 for making refusal slower than acceptance, and three of those publishers have since redesigned the banner.',
        'The tables below report measured latency, wording, and the share of readers who reached the article on the first attempt, compared against the same measurements taken in 2023.',
      ].join(' '),
    }),
    null,
  )
})

/**
 * The counterexample that length cannot answer.
 *
 * This page is short, and it says the trigger sentence outright, so any rule
 * built on "cookie words in a small page" convicts it. It is a newsroom report
 * about the site's own tracking, and the sentence after the notice carries
 * facts nothing else on the web states. The wall rule has to ask whether the
 * notice is all the page says, not how much the page says in total.
 */
test('a short article that states the cookie notice still says something of its own', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      httpStatus: 200,
      title: 'Why our newsroom dropped third-party trackers',
      text: 'We use cookies only to keep you signed in. Advertising trackers left the site in March, page weight fell by 40 percent, and subscription conversions rose.',
    }),
    null,
  )
})

/**
 * A cookie policy is a document about cookies, not a wall made of one.
 *
 * It is short, it is entirely on the subject, and it opens with the notice
 * sentence. What separates it from the wall is that it goes on to say things.
 */
test('a short cookie policy is a document, not a consent wall', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      httpStatus: 200,
      title: 'Cookie policy',
      text: 'We use cookies to keep you signed in for 30 days. We do not sell data. Session cookies expire when you close the browser, and you can delete them from your browser settings at any time.',
    }),
    null,
  )
})

/**
 * A listing page whose rows are short is still a listing page.
 *
 * Extraction collapses the line breaks, so a directory's entries and its cookie
 * line arrive as one run of text. A rule that discards any passage touching the
 * notice discards the addresses with it.
 */
test('a directory listing carrying a cookie line is not a consent wall', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      httpStatus: 200,
      title: 'Bookstores in Ann Arbor',
      text: [
        '# Bookstores',
        '',
        'Motte and Bailey Booksellers, 212 S Main St',
        '',
        'Dawn Treader Book Shop, 514 E Liberty St',
        '',
        'We use cookies and process personal data.',
      ].join('\n'),
    }),
    null,
  )
})

/**
 * Cookie furniture is on nearly every page, including the good ones.
 *
 * The page below says two facts and carries the consent control that any site
 * in Europe carries. Reading the notice out of the control tree and then
 * measuring only the body convicts every short real page that has a cookie
 * button, which is most of them. The content-only rule has to find the notice
 * in the content it is judging.
 */
test('a short page with an ordinary cookie preferences control is not a consent wall', () => {
  assert.equal(
    classifyBrowserPage({
      ...usablePage,
      httpStatus: 200,
      title: 'Opening hours',
      text: 'Open daily 9 to 5. 123 Main Street.',
      elements: [{ name: 'Cookie preferences', role: 'button' }],
    }),
    null,
  )
})

/**
 * Consent text does not make the factual text after it disappear.
 *
 * These deliberately tiny pages caught the residue-length rule that the longer
 * article and directory counterexamples missed. Each says less than the
 * cookie-only page once the notice is removed, so no character threshold can
 * preserve the fact while rejecting that wall.
 */
for (const page of [
  {
    kind: 'opening-hours fact',
    title: 'Opening hours',
    text: 'We use cookies. Open daily 9 to 5.',
  },
  {
    kind: 'address',
    title: 'Contact',
    text: 'We use cookies. 123 Main Street.',
  },
  {
    kind: 'news fact',
    title: 'Notice',
    text: 'We use cookies. The shop moved in March.',
  },
]) {
  test(`a cookie notice followed by a short ${page.kind} stays usable`, () => {
    assert.equal(
      classifyBrowserPage({
        ...usablePage,
        httpStatus: 200,
        title: page.title,
        text: page.text,
      }),
      null,
    )
  })
}
