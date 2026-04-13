/**
 * /api/health-sync
 *
 * Receives POST requests from the "Health Auto Export" iOS app.
 * Upserts daily health metrics into Supabase and recomputes recovery_score.
 *
 * Authentication: x-secret header must match HEALTH_SYNC_SECRET env var.
 *
 * Health Auto Export setup:
 *   Metrics: HRV (SDNN), Resting Heart Rate, Sleep Analysis, Steps, Active Energy
 *   Export URL: https://{your-app}.vercel.app/api/health-sync
 *   Header: x-secret: {HEALTH_SYNC_SECRET}
 *   Schedule: daily at 7am
 */

import supabase from '../lib/supabase.js'
import { computeRecoveryScore } from '../lib/recovery-score.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Auth check
  const secret = req.headers['x-secret']
  if (!secret || secret !== process.env.HEALTH_SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = req.body
    // Health Auto Export sends an object with a "data" array or direct metric objects.
    // Support both formats.
    const metrics = Array.isArray(payload?.data) ? payload.data : [payload]

    let synced = 0

    for (const entry of metrics) {
      const date = extractDate(entry)
      if (!date) continue

      const row = {
        date,
        hrv_ms: extractMetric(entry, ['hrv', 'hrv_sdnn', 'HRV', 'heartRateVariabilitySDNN']),
        resting_heart_rate: extractMetric(entry, ['resting_heart_rate', 'restingHeartRate', 'RestingHeartRate']),
        sleep_hours: extractSleepHours(entry),
        steps: extractMetric(entry, ['steps', 'Steps', 'stepCount']),
        active_calories: extractMetric(entry, ['active_calories', 'activeCalories', 'activeEnergyBurned']),
        source: 'apple_health',
        raw: entry,
      }

      // Compute recovery score using available data
      // (BiPAP AHI may have been manually entered; don't overwrite it)
      const { data: existing } = await supabase
        .from('health_metrics')
        .select('bipap_ahi, bipap_hours')
        .eq('date', date)
        .single()

      // Fetch 7-day HRV average for score computation
      const { data: recentMetrics } = await supabase
        .from('health_metrics')
        .select('hrv_ms')
        .order('date', { ascending: false })
        .limit(7)

      const hrv7dayAvg = recentMetrics?.length
        ? recentMetrics.reduce((s, m) => s + (m.hrv_ms ?? 0), 0) / recentMetrics.length
        : null

      row.recovery_score = computeRecoveryScore({
        hrv_ms: row.hrv_ms,
        hrv_7day_avg: hrv7dayAvg,
        sleep_hours: row.sleep_hours,
        bipap_ahi: existing?.bipap_ahi ?? null,
      })

      // Preserve existing BiPAP data
      if (existing?.bipap_ahi != null) row.bipap_ahi = existing.bipap_ahi
      if (existing?.bipap_hours != null) row.bipap_hours = existing.bipap_hours

      const { error } = await supabase
        .from('health_metrics')
        .upsert(row, { onConflict: 'date' })

      if (error) {
        console.error(`[health-sync] Upsert failed for ${date}:`, error.message)
      } else {
        synced++
      }
    }

    return res.status(200).json({ ok: true, synced })
  } catch (err) {
    console.error('[health-sync] Error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ---------------------------------------------------------------------------
// Helpers — handle Health Auto Export's various field name conventions
// ---------------------------------------------------------------------------

function extractDate(entry) {
  const raw = entry?.date ?? entry?.startDate ?? entry?.Date
  if (!raw) return null
  // Normalize to YYYY-MM-DD
  return raw.slice(0, 10)
}

function extractMetric(entry, keys) {
  for (const key of keys) {
    const val = entry?.[key]
    if (val != null && !isNaN(parseFloat(val))) {
      return parseFloat(val)
    }
    // Health Auto Export sometimes nests under { qty: value }
    if (entry?.[key]?.qty != null) return parseFloat(entry[key].qty)
  }
  return null
}

function extractSleepHours(entry) {
  // Sleep can come as total hours or as individual stages to sum
  const direct = extractMetric(entry, ['sleep_hours', 'sleepHours', 'asleepDuration', 'SleepDuration', 'inBedDuration'])
  if (direct != null) return direct

  // Sum sleep stages if present (in minutes → convert to hours)
  const stages = ['sleepCore', 'sleepDeep', 'sleepREM', 'sleepUnspecified']
  const stageMins = stages.reduce((sum, key) => {
    const val = extractMetric(entry, [key])
    return sum + (val ?? 0)
  }, 0)
  if (stageMins > 0) return +(stageMins / 60).toFixed(2)

  return null
}
