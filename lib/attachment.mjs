import { error, failure, success } from './result.mjs';

export const ATTACHMENT_LIMITS = Object.freeze({
  maxBytes: 10 * 1024 * 1024,
  maxPerRecord: 10,
  maxFileNameLength: 120
});

// 添付として受け付ける種類の唯一の一覧。保存する MIME タイプは必ずこの値にする。
// SVG・HTML などスクリプトを含み得る形式は受け付けない。
export const ATTACHMENT_TYPES = Object.freeze([
  Object.freeze({ mime: 'image/jpeg', extensions: Object.freeze(['jpg', 'jpeg']) }),
  Object.freeze({ mime: 'image/png', extensions: Object.freeze(['png']) }),
  Object.freeze({ mime: 'image/webp', extensions: Object.freeze(['webp']) }),
  Object.freeze({ mime: 'image/heic', extensions: Object.freeze(['heic']) }),
  Object.freeze({ mime: 'image/heif', extensions: Object.freeze(['heif']) }),
  Object.freeze({ mime: 'application/pdf', extensions: Object.freeze(['pdf']) })
]);

// 種類判定に読む先頭バイト数。HEIF の ftyp ボックスの互換ブランドまで含める。
export const ATTACHMENT_HEADER_BYTES = 64;

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx']);
const HEIF_BRANDS = new Set(['mif1', 'msf1', 'heif']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const FALLBACK_BASE_NAME = 'attachment';

function startsWith(bytes, signature, offset = 0) {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiAt(bytes, offset, length) {
  if (bytes.length < offset + length) return '';
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function detectHeif(bytes) {
  if (asciiAt(bytes, 4, 4) !== 'ftyp') return null;
  const boxSize = ((bytes[0] << 24) >>> 0) + (bytes[1] << 16) + (bytes[2] << 8) + bytes[3];
  const end = Math.min(bytes.length, boxSize >= 16 ? boxSize : 16);
  const major = asciiAt(bytes, 8, 4);
  const compatible = [];
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    compatible.push(asciiAt(bytes, offset, 4));
  }
  const brands = [major, ...compatible];

  if (HEIC_BRANDS.has(major)) return 'image/heic';
  if (!HEIF_BRANDS.has(major)) return null;
  if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'image/heic';
  // AVIF も mif1 を主ブランドにするため、互換ブランドで除外する。
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return null;
  return 'image/heif';
}

export function detectAttachmentType(header) {
  if (!(header instanceof Uint8Array)) return null;
  if (startsWith(header, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (asciiAt(header, 0, 4) === 'RIFF' && asciiAt(header, 8, 4) === 'WEBP') return 'image/webp';
  if (asciiAt(header, 0, 5) === '%PDF-') return 'application/pdf';
  return detectHeif(header);
}

function findType(mime) {
  return ATTACHMENT_TYPES.find((type) => type.mime === mime) ?? null;
}

export function isAllowedAttachmentMime(mime) {
  return findType(mime) !== null;
}

function truncateCodePoints(text, maxLength) {
  const chars = [...text];
  return chars.length > maxLength ? chars.slice(0, maxLength).join('') : text;
}

export function normalizeAttachmentFileName(name, mime) {
  const type = findType(mime);
  const canonicalExtension = type ? type.extensions[0] : '';
  const cleaned = (typeof name === 'string' ? name : '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    // 制御文字と、表示上の並びを偽装できる双方向制御文字を取り除く。
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[/\\]/g, '_')
    .trim();

  const dotIndex = cleaned.lastIndexOf('.');
  const extension = dotIndex > 0 ? cleaned.slice(dotIndex + 1).toLowerCase() : '';
  const hasMatchingExtension = type !== null && type.extensions.includes(extension);

  let base;
  let suffix;
  if (hasMatchingExtension) {
    base = cleaned.slice(0, dotIndex);
    suffix = cleaned.slice(dotIndex);
  } else {
    base = cleaned;
    suffix = canonicalExtension ? `.${canonicalExtension}` : '';
  }
  if (!base) base = FALLBACK_BASE_NAME;

  const maxBaseLength = ATTACHMENT_LIMITS.maxFileNameLength - [...suffix].length;
  return `${truncateCodePoints(base, maxBaseLength).trimEnd() || FALLBACK_BASE_NAME}${suffix}`;
}

function formatMiB(bytes) {
  return `${bytes / (1024 * 1024)}MiB`;
}

function checkLimits(size, existingCount) {
  if (Number.isInteger(existingCount) && existingCount >= ATTACHMENT_LIMITS.maxPerRecord) {
    return failure(error(
      'ATTACHMENT_LIMIT_REACHED',
      'attachment',
      `添付は1件の記録につき${ATTACHMENT_LIMITS.maxPerRecord}件までです`
    ));
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    return failure(error('ATTACHMENT_EMPTY', 'attachment', '空のファイルは添付できません'));
  }
  if (size > ATTACHMENT_LIMITS.maxBytes) {
    return failure(error(
      'ATTACHMENT_TOO_LARGE',
      'attachment',
      `添付できるファイルは${formatMiB(ATTACHMENT_LIMITS.maxBytes)}までです`
    ));
  }
  return null;
}

export function validateAttachment({ name, size, header, existingCount = 0 } = {}) {
  const limitFailure = checkLimits(size, existingCount);
  if (limitFailure) return limitFailure;
  const mime = detectAttachmentType(header);
  if (!mime) {
    return failure(error(
      'ATTACHMENT_UNSUPPORTED_TYPE',
      'attachment',
      '添付できるのはJPEG・PNG・WebP・HEIC/HEIF画像とPDFだけです'
    ));
  }
  return success({ name: normalizeAttachmentFileName(name, mime), mime, size });
}

function readFailure() {
  return failure(error('ATTACHMENT_READ_FAILED', 'attachment', 'ファイルを読み込めませんでした'));
}

// File（または Blob）を検証し、保存用の値を返す。例外は投げない。
export async function prepareAttachment(file, { existingCount = 0 } = {}) {
  if (!file || typeof file !== 'object' || typeof file.slice !== 'function') return readFailure();

  // 大きすぎるファイルは読み込む前に弾く。
  const limitFailure = checkLimits(file.size, existingCount);
  if (limitFailure) return limitFailure;

  let header;
  try {
    header = new Uint8Array(await file.slice(0, ATTACHMENT_HEADER_BYTES).arrayBuffer());
  } catch {
    return readFailure();
  }

  const result = validateAttachment({ name: file.name, size: file.size, header, existingCount });
  if (!result.ok) return result;

  let blob;
  try {
    // file.type ではなく判定結果の MIME タイプを付け直す。
    blob = file.slice(0, file.size, result.value.mime);
  } catch {
    return readFailure();
  }
  return success({ ...result.value, blob });
}
