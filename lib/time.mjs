import { error, failure, success } from './result.mjs';

const SECONDS_PER_DAY = 24 * 60 * 60;
const HALF_DAY_SECONDS = 12 * 60 * 60;

export function pad2(value) {
  return String(value).padStart(2, '0');
}

// ローカル時刻の YYYY/MM/DD HH:mm。無効な日時は null を返し、扱いは呼び出し側に任せる。
export function formatRecordDateTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// ファイル名用のローカル時刻 YYYYMMDD_HHmm（seconds 指定時は YYYYMMDD_HHmmss）。
export function formatCompactDateTime(date, { seconds = false } = {}) {
  const time = `${pad2(date.getHours())}${pad2(date.getMinutes())}${seconds ? pad2(date.getSeconds()) : ''}`;
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${time}`;
}

function parseClockTime(value, field) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) {
    return failure(error('invalid_time', field, '時刻はHH:MM:SSの24時間表記で入力してください'));
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return failure(error('invalid_time', field, '存在しない時刻です'));
  }

  return success({
    hours,
    minutes,
    seconds,
    totalSeconds: hours * 3600 + minutes * 60 + seconds,
    formatted: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
  });
}

function parseDuration(value) {
  const match = /^(\d{1,3}):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) {
    return failure(error('invalid_duration', 'duration', '時間差はHH:MM:SS形式で入力してください'));
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (hours > 999 || minutes > 59 || seconds > 59) {
    return failure(error('invalid_duration', 'duration', '時間差は999:59:59以内で入力してください'));
  }

  return success({
    hours,
    minutes,
    seconds,
    totalSeconds: hours * 3600 + minutes * 60 + seconds
  });
}

function formatDiff(diffSec) {
  const absolute = Math.abs(diffSec);
  const minutes = Math.floor(absolute / 60);
  const seconds = absolute % 60;
  const sign = diffSec > 0 ? '+' : diffSec < 0 ? '-' : '±';
  return minutes > 0 ? `${sign}${minutes}分${seconds}秒` : `${sign}${absolute}秒`;
}

function directionFor(diffSec) {
  if (diffSec > 0) return 'ahead';
  if (diffSec < 0) return 'behind';
  return 'exact';
}

function dayLabelFor(dayOffset) {
  if (dayOffset === 0) return '同日';
  if (dayOffset === 1) return '翌日';
  if (dayOffset === -1) return '前日';
  return dayOffset > 0 ? `${dayOffset}日後` : `${Math.abs(dayOffset)}日前`;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function normalizeMinuteTime(value) {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';

  const match = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(trimmed);
  if (!match) return trimmed;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = match[3] === undefined ? null : Number(match[3]);
  if (hours > 23 || minutes > 59 || (seconds !== null && seconds > 59)) {
    return trimmed;
  }

  return `${match[1]}:${match[2]}`;
}

function isValidMinuteTime(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return false;
  return Number(match[1]) <= 23 && Number(match[2]) <= 59;
}

export function calculateDrift(refTime, camTime) {
  const reference = parseClockTime(refTime, 'refTime');
  const camera = parseClockTime(camTime, 'camTime');
  const errors = [reference, camera].flatMap((result) => result.ok ? [] : result.errors);
  if (errors.length > 0) return failure(errors);

  let diffSec = camera.value.totalSeconds - reference.value.totalSeconds;
  if (diffSec > HALF_DAY_SECONDS) diffSec -= SECONDS_PER_DAY;
  if (diffSec < -HALF_DAY_SECONDS) diffSec += SECONDS_PER_DAY;

  return success({
    refTime: reference.value.formatted,
    camTime: camera.value.formatted,
    diffSec,
    direction: directionFor(diffSec),
    displayVal: formatDiff(diffSec)
  });
}

export function calculateTimeOffset(baseTime, duration, operator) {
  const base = parseClockTime(baseTime, 'baseTime');
  const parsedDuration = parseDuration(duration);
  const errors = [base, parsedDuration].flatMap((result) => result.ok ? [] : result.errors);
  if (!['add', 'sub'].includes(operator)) {
    errors.push(error('invalid_operator', 'operator', '演算はaddまたはsubを指定してください'));
  }
  if (errors.length > 0) return failure(errors);
  if (parsedDuration.value.totalSeconds === 0) {
    return failure(error('zero_duration', 'duration', '時間差を入力してください'));
  }

  const signedDuration = operator === 'sub'
    ? -parsedDuration.value.totalSeconds
    : parsedDuration.value.totalSeconds;
  const rawSeconds = base.value.totalSeconds + signedDuration;
  const dayOffset = Math.floor(rawSeconds / SECONDS_PER_DAY);
  const normalizedSeconds = ((rawSeconds % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  const hours = Math.floor(normalizedSeconds / 3600);
  const minutes = Math.floor((normalizedSeconds % 3600) / 60);
  const seconds = normalizedSeconds % 60;

  return success({
    resultTime: `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`,
    dayOffset,
    dayLabel: dayLabelFor(dayOffset)
  });
}

export function normalizeExtractRange(range = {}) {
  const startDate = String(range.startDate ?? '');
  const endDate = String(range.endDate ?? '');
  return {
    startDate,
    startTime: normalizeMinuteTime(range.startTime),
    endDate: endDate === startDate ? '' : endDate,
    endTime: normalizeMinuteTime(range.endTime)
  };
}

export function validateExtractRange(range = {}, options = {}) {
  const normalized = normalizeExtractRange(range);
  const { startDate, startTime, endDate, endTime } = normalized;
  const allowLegacyPartialTimes = options.allowLegacyPartialTimes === true;
  const errors = [];

  if (!startDate && (startTime || endDate || endTime)) {
    errors.push(error('extract_start_date_required', 'extractDate', '抽出時刻または終了日を入力する場合は開始日が必要です'));
  }
  if (startDate && !isValidDate(startDate)) {
    errors.push(error('invalid_date', 'extractDate', '抽出開始日が正しい日付ではありません'));
  }
  if (endDate && !isValidDate(endDate)) {
    errors.push(error('invalid_date', 'extractEndDate', '抽出終了日が正しい日付ではありません'));
  }
  if (startTime && !isValidMinuteTime(startTime)) {
    errors.push(error('invalid_minute_time', 'extractStartTime', '抽出開始時刻が正しくありません'));
  }
  if (endTime && !isValidMinuteTime(endTime)) {
    errors.push(error('invalid_minute_time', 'extractEndTime', '抽出終了時刻が正しくありません'));
  }
  if (!allowLegacyPartialTimes && Boolean(startTime) !== Boolean(endTime)) {
    errors.push(error('extract_partial_time', 'extractRange', '抽出時刻は開始と終了を両方入力してください'));
  }

  const datesValid = startDate && isValidDate(startDate) && (!endDate || isValidDate(endDate));
  if (datesValid) {
    const effectiveEndDate = endDate || startDate;
    if (effectiveEndDate < startDate || (
      startTime && endTime && effectiveEndDate === startDate && endTime < startTime
    )) {
      errors.push(error('extract_end_before_start', 'extractRange', '抽出終了が開始より前です'));
    }
  }

  return errors.length > 0 ? failure(errors) : success(normalized);
}
