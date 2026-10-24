export type WordImageType = 'jpg' | 'png' | 'gif' | 'bmp'

export interface WordImageDimensions {
  readonly width: number
  readonly height: number
}

export function readWordImageDimensions(
  data: Uint8Array,
  type: WordImageType,
): WordImageDimensions {
  const dimensions = type === 'png'
    ? readPngDimensions(data)
    : type === 'jpg'
      ? readJpegDimensions(data)
      : type === 'gif'
        ? readGifDimensions(data)
        : readBmpDimensions(data)
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw invalidImage(type)
  }
  return dimensions
}

function readPngDimensions(data: Uint8Array): WordImageDimensions {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (
    data.byteLength < 24 ||
    !signature.every((byte, index) => data[index] === byte) ||
    readUint32(data, 8, false) !== 13 ||
    ascii(data, 12, 4) !== 'IHDR'
  ) {
    throw invalidImage('png')
  }
  return {
    width: readUint32(data, 16, false),
    height: readUint32(data, 20, false),
  }
}

function readJpegDimensions(data: Uint8Array): WordImageDimensions {
  if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw invalidImage('jpg')
  }
  let offset = 2
  while (offset < data.byteLength) {
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset]
    if (marker === undefined) break
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue
    }
    if (offset + 2 > data.byteLength) break
    const segmentLength = readUint16(data, offset, false)
    if (segmentLength < 2 || offset + segmentLength > data.byteLength) break
    if (isStartOfFrame(marker)) {
      if (segmentLength < 7) break
      return {
        width: readUint16(data, offset + 5, false),
        height: readUint16(data, offset + 3, false),
      }
    }
    offset += segmentLength
  }
  throw invalidImage('jpg')
}

function readGifDimensions(data: Uint8Array): WordImageDimensions {
  const signature = ascii(data, 0, 6)
  if (data.byteLength < 10 || (signature !== 'GIF87a' && signature !== 'GIF89a')) {
    throw invalidImage('gif')
  }
  return {
    width: readUint16(data, 6, true),
    height: readUint16(data, 8, true),
  }
}

function readBmpDimensions(data: Uint8Array): WordImageDimensions {
  if (data.byteLength < 26 || ascii(data, 0, 2) !== 'BM') {
    throw invalidImage('bmp')
  }
  const headerSize = readUint32(data, 14, true)
  if (headerSize === 12) {
    return {
      width: readUint16(data, 18, true),
      height: readUint16(data, 20, true),
    }
  }
  if (headerSize < 40) throw invalidImage('bmp')
  const view = dataView(data)
  return {
    width: view.getInt32(18, true),
    height: Math.abs(view.getInt32(22, true)),
  }
}

function isStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ].includes(marker)
}

function readUint16(data: Uint8Array, offset: number, littleEndian: boolean): number {
  return dataView(data).getUint16(offset, littleEndian)
}

function readUint32(data: Uint8Array, offset: number, littleEndian: boolean): number {
  return dataView(data).getUint32(offset, littleEndian)
}

function dataView(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function ascii(data: Uint8Array, offset: number, length: number): string {
  if (offset + length > data.byteLength) return ''
  return String.fromCharCode(...data.subarray(offset, offset + length))
}

function invalidImage(type: WordImageType): Error {
  const displayType = type === 'jpg' ? 'JPEG' : type.toUpperCase()
  return new Error(`Image data is not a valid ${displayType} image.`)
}
