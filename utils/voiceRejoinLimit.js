//@ts-check

export const MAX_REJOIN_ATTEMPTS = 5;

/**
 * @param {number} attempt
 * @returns {boolean}
 */
export function shouldScheduleRejoinAttempt(attempt) {
  return attempt <= MAX_REJOIN_ATTEMPTS;
}
