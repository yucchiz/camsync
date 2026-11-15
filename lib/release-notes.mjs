export const MAX_RELEASE_NOTES = 5;
export const MAX_RELEASE_NOTE_LENGTH = 80;

// Service Worker から受け取った更新内容を、表示できる短い文字列の一覧に整える。
// 想定外の形は空の一覧にし、件数と長さを上限で切る。
export function normalizeReleaseNotes(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((note) => typeof note === 'string')
    .map((note) => note.replace(/\s+/g, ' ').trim().slice(0, MAX_RELEASE_NOTE_LENGTH))
    .filter((note) => note !== '')
    .slice(0, MAX_RELEASE_NOTES);
}
