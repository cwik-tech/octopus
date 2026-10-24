import assert from 'node:assert/strict'
import test from 'node:test'

import { readWordImageDimensions } from '../../domains/word-generation/image-dimensions.js'

test('Word image dimensions are read from each supported image format', () => {
  const fixtures = [
    {
      type: 'png' as const,
      data: pngHeader(320, 200),
    },
    {
      type: 'jpg' as const,
      data: jpegHeader(320, 200),
    },
    {
      type: 'gif' as const,
      data: gifHeader(320, 200),
    },
    {
      type: 'bmp' as const,
      data: bmpHeader(320, 200),
    },
  ]

  for (const fixture of fixtures) {
    assert.deepEqual(
      readWordImageDimensions(fixture.data, fixture.type),
      { width: 320, height: 200 },
      fixture.type,
    )
  }
})

test('Word image dimensions reject data that does not match its declared format', () => {
  assert.throws(
    () => readWordImageDimensions(Buffer.from('icns\0\0\0\0'), 'png'),
    /valid PNG image/,
  )
})

function pngHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(24)
  Buffer.from('89504e470d0a1a0a', 'hex').copy(data)
  data.writeUInt32BE(13, 8)
  data.write('IHDR', 12, 'ascii')
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  return data
}

function jpegHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(21)
  Buffer.from([0xff, 0xd8, 0xff, 0xc0]).copy(data)
  data.writeUInt16BE(17, 4)
  data[6] = 8
  data.writeUInt16BE(height, 7)
  data.writeUInt16BE(width, 9)
  return data
}

function gifHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(10)
  data.write('GIF89a', 0, 'ascii')
  data.writeUInt16LE(width, 6)
  data.writeUInt16LE(height, 8)
  return data
}

function bmpHeader(width: number, height: number): Buffer {
  const data = Buffer.alloc(26)
  data.write('BM', 0, 'ascii')
  data.writeUInt32LE(40, 14)
  data.writeInt32LE(width, 18)
  data.writeInt32LE(height, 22)
  return data
}
