/**
 * Windows Bitmap fixture builder.
 *
 * A refusal is only worth anything if the file it refuses is real. This writes a valid, complete
 * 2x2 24-bit BMP — signature, `BITMAPINFOHEADER`, bottom-up pixel rows with their row padding —
 * so a test proving `.bmp` is refused cannot be passing because the bytes were garbage.
 *
 * `sharp` cannot open it: libvips reads BMP only through its ImageMagick loader, and
 * `sharp.format.magick.input.file` is `false` in the build this package ships.
 *
 * The bytes live in `tests/fixtures/` and are tracked; this module records how they were made and
 * lets `create-fixtures.ts` regenerate them.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const FILE_HEADER_SIZE = 14
const INFO_HEADER_SIZE = 40
const PIXELS_PER_METRE = 2835 // 72 dpi

export const BITMAP_FIXTURE = Object.freeze({
  fileName: 'yield-chart.bmp',
  width: 2,
  height: 2,
})

/** Two bottom-up rows of 24-bit BGR pixels, each padded to a 4-byte boundary. */
function pixelRows(): Buffer {
  return Buffer.from([
    0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0x00,
    0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0x00, 0x00,
  ])
}

function bitmap(): Buffer {
  const pixels = pixelRows()

  const info = Buffer.alloc(INFO_HEADER_SIZE)
  info.writeUInt32LE(INFO_HEADER_SIZE, 0)
  info.writeInt32LE(BITMAP_FIXTURE.width, 4)
  info.writeInt32LE(BITMAP_FIXTURE.height, 8)
  info.writeUInt16LE(1, 12) // colour planes
  info.writeUInt16LE(24, 14) // bits per pixel
  info.writeUInt32LE(0, 16) // BI_RGB, uncompressed
  info.writeUInt32LE(pixels.length, 20)
  info.writeInt32LE(PIXELS_PER_METRE, 24)
  info.writeInt32LE(PIXELS_PER_METRE, 28)

  const header = Buffer.alloc(FILE_HEADER_SIZE)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(FILE_HEADER_SIZE + INFO_HEADER_SIZE + pixels.length, 2)
  header.writeUInt32LE(FILE_HEADER_SIZE + INFO_HEADER_SIZE, 10)

  return Buffer.concat([header, info, pixels])
}

/** Write the BMP fixture into `fixturesDir` and return its path. */
export function writeBitmapFixture(fixturesDir: string): string {
  const filePath = path.join(fixturesDir, BITMAP_FIXTURE.fileName)
  fs.writeFileSync(filePath, bitmap())
  return filePath
}
