export function error(code, field, message) {
  return { code, field, message };
}

export function failure(errors) {
  return { ok: false, errors: Array.isArray(errors) ? errors : [errors] };
}

export function success(value) {
  return { ok: true, value };
}
