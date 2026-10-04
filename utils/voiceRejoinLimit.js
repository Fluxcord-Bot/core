export const MAX_REJOIN_ATTEMPTS = 5;
export function shouldScheduleRejoinAttempt(attempt) {
  return attempt <= MAX_REJOIN_ATTEMPTS;
}
