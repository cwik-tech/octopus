import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { readResourceZip, writeResourceZip } from '../../domains/resource-library/resource-zip.js';
import { filesFromBuffers } from '../../domains/resource-library/skill-files.js';

test('resource ZIP preserves exact bytes and executable intent', async () => {
  const files = new Map(filesFromBuffers(new Map([
    ['SKILL.md', Buffer.from('skill instructions')],
    ['scripts/run.sh', Buffer.from('#!/bin/sh\necho portable\n')],
    ['assets/binary.dat', Buffer.from([0, 255, 1])],
  ])));
  files.set('scripts/run.sh', { contents: Buffer.from('#!/bin/sh\necho portable\n'), mode: 0o755, executable: true });
  const restored = await readResourceZip(await writeResourceZip(files));
  assert.deepEqual(restored.get('assets/binary.dat')?.contents, Buffer.from([0, 255, 1]));
  assert.equal(restored.get('scripts/run.sh')?.executable, true);
  assert.equal(restored.get('scripts/run.sh')?.contents.toString(), '#!/bin/sh\necho portable\n');
});

test('resource ZIP rejects path traversal and case collisions before exposing files', async () => {
  const traversal = new JSZip().file('../escape.txt', 'bad');
  await assert.rejects(readResourceZip(await traversal.generateAsync({ type: 'nodebuffer' })), /path|relative|invalid/i);
  const collision = new JSZip().file('SKILL.md', 'one').file('skill.md', 'two');
  await assert.rejects(readResourceZip(await collision.generateAsync({ type: 'nodebuffer' })), /collision|duplicate/i);
});

test('resource ZIP enforces expanded file and total limits while reading', async () => {
  const archive = await new JSZip().file('first.txt', '12345').file('second.txt', '67890').generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  await assert.rejects(readResourceZip(archive, { limits: { maxFileBytes: 4 } }), /file.*limit/i);
  await assert.rejects(readResourceZip(archive, { limits: { maxExpandedBytes: 9 } }), /expanded.*limit/i);
  await assert.rejects(readResourceZip(archive, { limits: { maxEntries: 1 } }), /entry.*limit/i);
  await assert.rejects(readResourceZip(archive, { limits: { maxCompressedBytes: archive.length - 1 } }), /compressed.*limit/i);
});

test('resource ZIP honors cancellation before opening an archive', async () => {
  await assert.rejects(readResourceZip(Buffer.from('invalid'), { signal: AbortSignal.abort() }), /abort/i);
});

test('resource ZIP rejects duplicate raw entries and symbolic links', async () => {
  const duplicate = Buffer.from('UEsDBBQAAAAAAEN1U13xhmx6AwAAAAMAAAAIAAAAU0tJTEwubWRvbmVQSwMEFAAAAAAAQ3VTXWaKyhEDAAAAAwAAAAgAAABTS0lMTC5tZHR3b1BLAQIUAxQAAAAAAEN1U13xhmx6AwAAAAMAAAAIAAAAAAAAAAAAAACAAQAAAABTS0lMTC5tZFBLAQIUAxQAAAAAAEN1U11misoRAwAAAAMAAAAIAAAAAAAAAAAAAACAASkAAABTS0lMTC5tZFBLBQYAAAAAAgACAGwAAABSAAAAAAA=', 'base64');
  await assert.rejects(readResourceZip(duplicate), /duplicate|collision/i);
  const link = await new JSZip().file('link', 'target', { unixPermissions: 0o120777 }).generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
  await assert.rejects(readResourceZip(link), /file type/i);
});

test('resource ZIP rejects Unicode and parent-directory case collisions', async () => {
  const unicode = await new JSZip().file('caf\u00e9.txt', 'one').file('cafe\u0301.txt', 'two').generateAsync({ type: 'nodebuffer' });
  await assert.rejects(readResourceZip(unicode), /collision|duplicate/i);
  const parent = await new JSZip().file('Folder/one', 'one', { createFolders: false }).file('folder/two', 'two', { createFolders: false }).generateAsync({ type: 'nodebuffer' });
  await assert.rejects(readResourceZip(parent), /collision/i);
});

test('ZIP limits accept values at and below each configured boundary', async () => {
  const archive = await new JSZip().file('first.txt', '12345').file('second.txt', '67890').generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.equal((await readResourceZip(archive, { limits: { maxFileBytes: 5, maxExpandedBytes: 10, maxEntries: 2, maxCompressedBytes: archive.length } })).size, 2);
  assert.equal((await readResourceZip(archive, { limits: { maxFileBytes: 6, maxExpandedBytes: 11, maxEntries: 3, maxCompressedBytes: archive.length + 1 } })).size, 2);
  const deep = await new JSZip().file('folder/file', 'one', { createFolders: false }).generateAsync({ type: 'nodebuffer' });
  await assert.rejects(readResourceZip(deep, { limits: { maxDepth: 1 } }), /depth.*limit/i);
  assert.equal((await readResourceZip(deep, { limits: { maxDepth: 2 } })).size, 1);
  assert.equal((await readResourceZip(deep, { limits: { maxDepth: 3 } })).size, 1);
});

test('ZIP rejects corrupt stored bytes and honors caller cancellation during opening', async () => {
  const archive = await new JSZip().file('file.txt', 'unique contents').generateAsync({ type: 'nodebuffer', compression: 'STORE' });
  const offset = archive.indexOf(Buffer.from('unique contents')); assert.ok(offset > 0);
  archive[offset] = 0;
  await assert.rejects(readResourceZip(archive), /checksum/);
  const controller = new AbortController();
  const pending = readResourceZip(archive, { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /abort/i);
});
