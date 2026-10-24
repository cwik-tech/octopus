/**
 * Legacy binary Office fixture builder.
 *
 * `.doc`, `.xls` and `.ppt` are OLE2 Compound File Binary documents, not ZIPs — which is exactly
 * why the OOXML readers in this package cannot open them. The fixtures are therefore built as real
 * compound files: the CFB signature and header, a FAT, a directory with the format's own root
 * CLSID, and the stream every such document carries (`WordDocument`, `Workbook`,
 * `PowerPoint Document`). Anything sniffing them identifies the format correctly.
 *
 * The bytes live in `tests/fixtures/` and are tracked; this module records how they were made and
 * lets `create-fixtures.ts` regenerate them.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const SECTOR_SIZE = 512
const CFB_SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const FREESECT = 0xffffffff
const ENDOFCHAIN = 0xfffffffe
const FATSECT = 0xfffffffd
const NOSTREAM = 0xffffffff

/** Object types from the CFB directory entry spec. */
const OBJECT_TYPE_STREAM = 2
const OBJECT_TYPE_ROOT_STORAGE = 5

/** `{00020906-0000-0000-C000-000000000046}` style CLSID into its on-disk mixed-endian bytes. */
function clsid(text: string): Buffer {
  const hex = text.replace(/[{}-]/g, '')
  const buffer = Buffer.alloc(16)
  buffer.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0)
  buffer.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4)
  buffer.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6)
  Buffer.from(hex.slice(16), 'hex').copy(buffer, 8)
  return buffer
}

/** One 128-byte CFB directory entry. */
function directoryEntry(options: {
  name: string
  objectType: number
  clsid?: Buffer
  child?: number
  startingSector?: number
  streamSize?: number
}): Buffer {
  const entry = Buffer.alloc(128)
  const name = Buffer.from(`${options.name}\0`, 'utf16le')
  name.copy(entry, 0)
  entry.writeUInt16LE(name.length, 0x40)
  entry.writeUInt8(options.objectType, 0x42)
  entry.writeUInt8(1, 0x43) // colour flag: black
  entry.writeUInt32LE(NOSTREAM, 0x44) // left sibling
  entry.writeUInt32LE(NOSTREAM, 0x48) // right sibling
  entry.writeUInt32LE(options.child ?? NOSTREAM, 0x4c)
  if (options.clsid) options.clsid.copy(entry, 0x50)
  entry.writeUInt32LE(options.startingSector ?? ENDOFCHAIN, 0x74)
  entry.writeUInt32LE(options.streamSize ?? 0, 0x78)
  return entry
}

/** The 512-byte CFB header: version 3, 512-byte sectors, one FAT sector at sector 0. */
function header(): Buffer {
  const head = Buffer.alloc(SECTOR_SIZE)
  CFB_SIGNATURE.copy(head, 0)
  head.writeUInt16LE(0x003e, 0x18) // minor version
  head.writeUInt16LE(0x0003, 0x1a) // major version 3
  head.writeUInt16LE(0xfffe, 0x1c) // little-endian byte order mark
  head.writeUInt16LE(9, 0x1e) // sector shift: 512 bytes
  head.writeUInt16LE(6, 0x20) // mini sector shift: 64 bytes
  head.writeUInt32LE(0, 0x28) // directory sector count (unused in version 3)
  head.writeUInt32LE(1, 0x2c) // FAT sector count
  head.writeUInt32LE(1, 0x30) // first directory sector
  head.writeUInt32LE(0, 0x34) // transaction signature
  head.writeUInt32LE(4096, 0x38) // mini stream cutoff
  head.writeUInt32LE(ENDOFCHAIN, 0x3c) // first mini FAT sector
  head.writeUInt32LE(0, 0x40) // mini FAT sector count
  head.writeUInt32LE(ENDOFCHAIN, 0x44) // first DIFAT sector
  head.writeUInt32LE(0, 0x48) // DIFAT sector count
  for (let index = 0; index < 109; index++) {
    head.writeUInt32LE(index === 0 ? 0 : FREESECT, 0x4c + index * 4)
  }
  return head
}

/** Sector 0: the FAT. Sector 0 is the FAT itself, 1 the directory, 2 the document stream. */
function fatSector(): Buffer {
  const fat = Buffer.alloc(SECTOR_SIZE, 0xff)
  fat.writeUInt32LE(FATSECT, 0)
  fat.writeUInt32LE(ENDOFCHAIN, 4)
  fat.writeUInt32LE(ENDOFCHAIN, 8)
  return fat
}

function compoundFile(options: {
  rootClsid: string
  streamName: string
  streamBody: string
}): Buffer {
  const stream = Buffer.alloc(SECTOR_SIZE)
  Buffer.from(options.streamBody, 'utf8').copy(stream, 0)

  const directory = Buffer.concat([
    directoryEntry({
      name: 'Root Entry',
      objectType: OBJECT_TYPE_ROOT_STORAGE,
      clsid: clsid(options.rootClsid),
      child: 1,
    }),
    directoryEntry({
      name: options.streamName,
      objectType: OBJECT_TYPE_STREAM,
      startingSector: 2,
      streamSize: stream.length,
    }),
    Buffer.alloc(128),
    Buffer.alloc(128),
  ])

  return Buffer.concat([header(), fatSector(), directory, stream])
}

const LEGACY_OFFICE_FIXTURES = [
  {
    fileName: 'legacy-report.doc',
    rootClsid: '{00020906-0000-0000-C000-000000000046}',
    streamName: 'WordDocument',
    streamBody: 'Legacy Word 97 document body.',
  },
  {
    fileName: 'legacy-book.xls',
    rootClsid: '{00020820-0000-0000-C000-000000000046}',
    streamName: 'Workbook',
    streamBody: 'Legacy Excel 97 workbook body.',
  },
  {
    fileName: 'legacy-deck.ppt',
    rootClsid: '{64818D10-4F9B-11CF-86EA-00AA00B929E8}',
    streamName: 'PowerPoint Document',
    streamBody: 'Legacy PowerPoint 97 presentation body.',
  },
] as const

/** Write the three legacy binary Office fixtures into `fixturesDir` and return their paths. */
export function writeLegacyOfficeFixtures(fixturesDir: string): string[] {
  return LEGACY_OFFICE_FIXTURES.map((fixture) => {
    const filePath = path.join(fixturesDir, fixture.fileName)
    fs.writeFileSync(filePath, compoundFile(fixture))
    return filePath
  })
}
