/**
 * Recovery score computation.
 *
 * Composite 0-100 score based on:
 *   50% — HRV (today vs 7-day average)
 *   30% — Sleep hours (target: 7hrs)
 *   20% — BiPAP AHI (apnea events/hour; lower = better)
 *
 * Returns an integer 0-100.
 */

/**
 * @param {object} params
 * @param {number|null} params.hrv_ms           HRV in ms (today)
 * @param {number|null} params.hrv_7day_avg     7-day average HRV in ms
 * @param {number|null} params.sleep_hours      Hours slept last night
 * @param {number|null} params.bipap_ahi        AHI score from BiPAP (events/hr). null = unknown.
 * @returns {number} recovery score 0-100
 */
export function computeRecoveryScore({ hrv_ms, hrv_7day_avg, sleep_hours, bipap_ahi }) {
  // HRV component (50 points max)
  // Ratio of today's HRV to 7-day average, capped at 100 points before weighting.
  let hrvScore = 25 // neutral if no data
  if (hrv_ms != null && hrv_7day_avg != null && hrv_7day_avg > 0) {
    hrvScore = Math.min(100, (hrv_ms / hrv_7day_avg) * 100) * 0.5
  }

  // Sleep component (30 points max)
  // Target is 7 hours. Jose averages ~5hrs — chronic deficit already baked in.
  let sleepScore = 15 // neutral if no data
  if (sleep_hours != null) {
    sleepScore = Math.min(100, (sleep_hours / 7) * 100) * 0.3
  }

  // AHI component (20 points max)
  // AHI < 5 = normal (full score). Every 1 event/hr above 0 costs 5 points.
  // null = unknown/no data → neutral 10 points
  let ahiScore = 10 // neutral if no data
  if (bipap_ahi != null) {
    ahiScore = Math.max(0, 100 - bipap_ahi * 5) * 0.2
  }

  return Math.round(hrvScore + sleepScore + ahiScore)
}

/**
 * Returns a short human-readable label for a recovery score.
 */
export function recoveryLabel(score) {
  if (score >= 80) return 'High'
  if (score >= 60) return 'Moderate'
  if (score >= 40) return 'Low'
  return 'Very Low'
}

/**
 * Returns coaching guidance string based on recovery score.
 */
export function recoveryGuidance(score) {
  if (score >= 80) return 'Good to go — full training as planned.'
  if (score >= 60) return 'Proceed with training. Monitor effort; stay at the lower end of target zones.'
  if (score >= 40) return 'Consider reducing intensity. Swap a hard session for easy/recovery if possible.'
  return 'Recovery is poor. Prioritize rest or very easy movement only. Hard training today is counterproductive.'
}
