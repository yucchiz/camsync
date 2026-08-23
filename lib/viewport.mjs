const KEYBOARD_CLOSE_THRESHOLD = 120;
const RESTORED_HEIGHT_TOLERANCE = 48;

function nonNegativeNumber(value) {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function createKeyboardViewportTracker(initialHeight) {
  let expandedHeight = nonNegativeNumber(initialHeight);
  let minimumHeight = expandedHeight;
  let keyboardActive = false;
  let recoveryPending = false;

  return {
    focus(height) {
      const startsNewSession = !keyboardActive;
      const currentHeight = nonNegativeNumber(height);
      expandedHeight = Math.max(expandedHeight, currentHeight);
      minimumHeight = currentHeight || expandedHeight;
      keyboardActive = true;
      recoveryPending = true;
      return startsNewSession;
    },

    blur() {
      keyboardActive = false;
    },

    update({ height, offsetTop }) {
      const currentHeight = nonNegativeNumber(height);

      if (keyboardActive && currentHeight > 0) {
        minimumHeight = minimumHeight > 0
          ? Math.min(minimumHeight, currentHeight)
          : currentHeight;

        const returnedNearExpandedHeight =
          expandedHeight > 0 &&
          currentHeight >= expandedHeight - RESTORED_HEIGHT_TOLERANCE;
        if (
          returnedNearExpandedHeight &&
          currentHeight - minimumHeight >= KEYBOARD_CLOSE_THRESHOLD
        ) {
          keyboardActive = false;
        }
      } else if (!recoveryPending) {
        expandedHeight = Math.max(expandedHeight, currentHeight);
      }

      const normalizedOffset = nonNegativeNumber(offsetTop);
      const recoveryOffset = !keyboardActive && recoveryPending
        ? normalizedOffset
        : 0;

      if (!keyboardActive && recoveryPending && normalizedOffset === 0) {
        recoveryPending = false;
      }

      return {
        keyboardActive,
        offsetTop: recoveryOffset,
      };
    },
  };
}
