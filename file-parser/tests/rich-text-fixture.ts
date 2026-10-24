/**
 * Rich Text Format fixture builder.
 *
 * `.rtf` reached the desktop pickers with nothing in the suite exercising it: the extension was
 * routed at `parseGeneric`, which hands it to officeparser, and no test ever proved officeparser
 * returned any text for one. RTF is a plain-text control language rather than a container, so the
 * fixture is authored here as the bytes themselves — a font table, a bold heading, three
 * paragraphs — instead of being exported from a word processor.
 *
 * The bytes live in `tests/fixtures/` and are tracked; this module records how they were made and
 * lets `create-fixtures.ts` regenerate them.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export const RICH_TEXT_FIXTURE = Object.freeze({
  fileName: 'meeting-minutes.rtf',
  /** Text the parser must recover, chosen so a partial read cannot pass for a whole one. */
  heading: 'Quarterly Operations Minutes',
  firstParagraph: 'Harvest delays fell by 18 percent across the pilot cohort.',
  lastParagraph: 'Packing throughput is reviewed every Thursday by the operations team.',
})

function richTextDocument(): string {
  return [
    '{\\rtf1\\ansi\\ansicpg1252\\deff0',
    '{\\fonttbl{\\f0\\fnil\\fcharset0 Helvetica;}}',
    `\\f0\\fs28\\b ${RICH_TEXT_FIXTURE.heading}\\b0\\fs24\\par`,
    `${RICH_TEXT_FIXTURE.firstParagraph}\\par`,
    `${RICH_TEXT_FIXTURE.lastParagraph}\\par`,
    '}',
    '',
  ].join('\n')
}

/** Write the RTF fixture into `fixturesDir` and return its path. */
export function writeRichTextFixture(fixturesDir: string): string {
  const filePath = path.join(fixturesDir, RICH_TEXT_FIXTURE.fileName)
  fs.writeFileSync(filePath, richTextDocument(), 'utf8')
  return filePath
}
