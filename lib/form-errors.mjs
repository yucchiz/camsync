// validateRecord の errors[].field を、画面の入力欄単位の表示に振り分ける。
// 並びは画面上の入力順。最初の要素へフォーカスを移す想定。
export const FORM_FIELD_ORDER = Object.freeze([
  'location',
  'viewDate',
  'extractDate',
  'extractStartTime',
  'extractEndDate',
  'extractEndTime',
  'extractRange',
  'witnessName',
  'witnessAge',
  'notes'
]);

export function groupFormErrors(errors) {
  const byField = new Map();
  const general = [];
  for (const entry of Array.isArray(errors) ? errors : []) {
    const message = entry?.message ?? '';
    if (FORM_FIELD_ORDER.includes(entry?.field)) {
      const messages = byField.get(entry.field) ?? [];
      messages.push(message);
      byField.set(entry.field, messages);
    } else {
      general.push(message);
    }
  }
  const fields = FORM_FIELD_ORDER
    .filter((field) => byField.has(field))
    .map((field) => ({ field, messages: byField.get(field) }));
  return { fields, general };
}
