import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_TYPES,
  detectAttachmentType,
  isAllowedAttachmentMime,
  normalizeAttachmentFileName,
  prepareAttachment,
  validateAttachment,
} from '../lib/attachment.mjs';

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));

const HEADERS = {
  jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii('JFIF')]),
  png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
  webp: Uint8Array.from([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBPVP8 ')]),
  pdf: Uint8Array.from(ascii('%PDF-1.7\n')),
};

function ftyp(major, compatible = []) {
  const size = 16 + compatible.length * 4;
  return Uint8Array.from([
    0, 0, 0, size,
    ...ascii('ftyp'),
    ...ascii(major),
    0, 0, 0, 0,
    ...compatible.flatMap(ascii),
  ]);
}

function file(bytes, name, type = '') {
  return new File([bytes], name, { type });
}

test('上限値は1ファイル10MiB・1記録10件', () => {
  assert.equal(ATTACHMENT_LIMITS.maxBytes, 10 * 1024 * 1024);
  assert.equal(ATTACHMENT_LIMITS.maxPerRecord, 10);
  assert.ok(Object.isFrozen(ATTACHMENT_LIMITS));
  assert.ok(Object.isFrozen(ATTACHMENT_TYPES));
});

test('先頭バイトから許可された種類を判定する', () => {
  assert.equal(detectAttachmentType(HEADERS.jpeg), 'image/jpeg');
  assert.equal(detectAttachmentType(HEADERS.png), 'image/png');
  assert.equal(detectAttachmentType(HEADERS.webp), 'image/webp');
  assert.equal(detectAttachmentType(HEADERS.pdf), 'application/pdf');
  assert.equal(detectAttachmentType(ftyp('heic', ['mif1', 'heic'])), 'image/heic');
  assert.equal(detectAttachmentType(ftyp('heix')), 'image/heic');
  assert.equal(detectAttachmentType(ftyp('mif1', ['mif1', 'heic'])), 'image/heic');
  assert.equal(detectAttachmentType(ftyp('mif1', ['mif1'])), 'image/heif');
});

test('許可していない種類や壊れた先頭バイトは判定しない', () => {
  const rejected = [
    Uint8Array.from(ascii('<svg xmlns="http://www.w3.org/2000/svg">')),
    Uint8Array.from(ascii('<!doctype html><script>')),
    Uint8Array.from(ascii('GIF89a')),
    Uint8Array.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]),
    ftyp('avif', ['mif1', 'avif']),
    ftyp('mif1', ['mif1', 'avif']),
    ftyp('isom', ['mp41']),
    Uint8Array.from([0xff, 0xd8]),
    new Uint8Array(),
  ];
  rejected.forEach((bytes) => assert.equal(detectAttachmentType(bytes), null));
  assert.equal(detectAttachmentType(null), null);
  assert.equal(detectAttachmentType('PDF'), null);
});

test('MIMEの許可リストを判定する', () => {
  assert.equal(isAllowedAttachmentMime('image/png'), true);
  assert.equal(isAllowedAttachmentMime('image/svg+xml'), false);
  assert.equal(isAllowedAttachmentMime('text/html'), false);
});

test('ファイル名から制御文字・区切り文字を除き、拡張子を判定結果に合わせる', () => {
  assert.equal(normalizeAttachmentFileName('  現場\u0000写真‮.jpg ', 'image/jpeg'), '現場写真.jpg');
  assert.equal(normalizeAttachmentFileName('../../etc/passwd', 'application/pdf'), '.._.._etc_passwd.pdf');
  assert.equal(normalizeAttachmentFileName('photo.JPEG', 'image/jpeg'), 'photo.JPEG');
  assert.equal(normalizeAttachmentFileName('evil.html', 'image/png'), 'evil.html.png');
  assert.equal(normalizeAttachmentFileName('IMG_0001.HEIC', 'image/heic'), 'IMG_0001.HEIC');
  assert.equal(normalizeAttachmentFileName('', 'image/webp'), 'attachment.webp');
  assert.equal(normalizeAttachmentFileName(undefined, 'application/pdf'), 'attachment.pdf');
  assert.equal(normalizeAttachmentFileName('a\t\n  b.pdf', 'application/pdf'), 'a b.pdf');
});

test('長いファイル名は拡張子を残して文字数上限に収める', () => {
  const name = normalizeAttachmentFileName(`${'あ'.repeat(300)}.pdf`, 'application/pdf');
  assert.equal([...name].length, ATTACHMENT_LIMITS.maxFileNameLength);
  assert.ok(name.endsWith('.pdf'));

  const emoji = normalizeAttachmentFileName(`${'😀'.repeat(200)}.png`, 'image/png');
  assert.equal([...emoji].length, ATTACHMENT_LIMITS.maxFileNameLength);
  assert.ok(emoji.endsWith('.png'));
});

test('validateAttachmentは種類・サイズ・件数を検証する', () => {
  const ok = validateAttachment({ name: 'a.png', size: 100, header: HEADERS.png, existingCount: 9 });
  assert.deepEqual(ok, { ok: true, value: { name: 'a.png', mime: 'image/png', size: 100 } });

  const codes = (input) => validateAttachment(input).errors.map((item) => item.code);
  assert.deepEqual(codes({ name: 'a.svg', size: 10, header: Uint8Array.from(ascii('<svg')) }), [
    'ATTACHMENT_UNSUPPORTED_TYPE',
  ]);
  assert.deepEqual(codes({ name: 'a.png', size: 0, header: HEADERS.png }), ['ATTACHMENT_EMPTY']);
  assert.deepEqual(codes({ name: 'a.png', size: ATTACHMENT_LIMITS.maxBytes + 1, header: HEADERS.png }), [
    'ATTACHMENT_TOO_LARGE',
  ]);
  assert.deepEqual(codes({ name: 'a.png', size: 1, header: HEADERS.png, existingCount: 10 }), [
    'ATTACHMENT_LIMIT_REACHED',
  ]);
  assert.deepEqual(codes({ name: 'a.png', size: Number.NaN, header: HEADERS.png }), ['ATTACHMENT_EMPTY']);

  const result = validateAttachment({ name: 'a.png', size: 1, header: HEADERS.png, existingCount: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].field, 'attachment');
  assert.match(result.errors[0].message, /10件/);
});

test('validateAttachmentは上限サイズちょうどを許可する', () => {
  const result = validateAttachment({ name: 'a.pdf', size: ATTACHMENT_LIMITS.maxBytes, header: HEADERS.pdf });
  assert.equal(result.ok, true);
});

test('prepareAttachmentはfile.typeを信用せず、判定したMIMEのBlobを返す', async () => {
  const bytes = Uint8Array.from([...HEADERS.png, 1, 2, 3]);
  const result = await prepareAttachment(file(bytes, 'camera.html', 'text/html'));

  assert.equal(result.ok, true);
  assert.equal(result.value.mime, 'image/png');
  assert.equal(result.value.name, 'camera.html.png');
  assert.equal(result.value.size, bytes.length);
  assert.ok(result.value.blob instanceof Blob);
  assert.equal(result.value.blob.type, 'image/png');
  assert.deepEqual(new Uint8Array(await result.value.blob.arrayBuffer()), bytes);
});

test('prepareAttachmentは拡張子を偽装したSVGを拒否する', async () => {
  const result = await prepareAttachment(file(ascii('<svg onload="alert(1)">'), 'photo.jpg', 'image/jpeg'));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ATTACHMENT_UNSUPPORTED_TYPE');
});

test('prepareAttachmentは大きすぎるファイルを読み込まずに拒否する', async () => {
  let sliced = false;
  const huge = {
    name: 'big.pdf',
    size: ATTACHMENT_LIMITS.maxBytes + 1,
    slice() {
      sliced = true;
      throw new Error('should not read');
    },
  };
  const result = await prepareAttachment(huge);
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ATTACHMENT_TOO_LARGE');
  assert.equal(sliced, false);
});

test('prepareAttachmentは読み込み失敗や不正な入力を例外にせず結果で返す', async () => {
  const broken = {
    name: 'x.pdf',
    size: 10,
    slice() {
      return { arrayBuffer: () => Promise.reject(new Error('NotReadableError')) };
    },
  };
  const readFailure = await prepareAttachment(broken);
  assert.equal(readFailure.ok, false);
  assert.equal(readFailure.errors[0].code, 'ATTACHMENT_READ_FAILED');

  const invalid = await prepareAttachment(null);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors[0].code, 'ATTACHMENT_READ_FAILED');
});

test('prepareAttachmentは件数上限を検証する', async () => {
  const result = await prepareAttachment(file(HEADERS.pdf, 'a.pdf'), { existingCount: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'ATTACHMENT_LIMIT_REACHED');
});
