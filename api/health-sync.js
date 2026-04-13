/**
 * /api/health-sync
 *
 * Receives POST requests from the "Health Auto Export" iOS app (v2 format).
 * Upserts daily health metrics into Supabase and recomputes recovery_score.
 *
 * v2 payload shape:
 * {
 *   data: {
 *     metrics: [
 *       { name: "heart_rate_variability_sdnn", units: "ms", data: [ { date: "2026-04-13 00:00:00 -0500", qty: 42.3 } ] },
 *       { name: "resting_heart_rate", units: "count/min", data: [ ... ] },
 *       ...
 *     ]
 *   }
 * }
 */

import supabase from '../lib/supabase.js'
import { computeRecoveryScore } from '../lib/recovery-score.js'

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const secret = req.headers['x-secret']
  if (!secret || secret !== process.env.HEALTH_SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const payload = req.body
    console.log('[health-sync] keys:', Object.keys(payload ?? {}))

    let synced = 0

    // ── V2 format: { data: { metrics: [...] } } ──────────────────────────────
    if (payload?.data?.metrics && Array.isArray(payload.data.metrics)) {
      synced = await syncV2(payload.data.metrics)

    // ── V1 format: { data: [ {date, hrv, ...}, ... ] } ───────────────────────
    } else if (Array.isArray(payload?.data)) {
      for (const entry of payload.data) {
        if (await upsertDayV1(entry)) synced++
      }

    // ── Single object fallback ────────────────────────────────────────────────
    } else {
      if (await upsertDayV1(payload)) synced++
    }

    return res.status(200).json({ ok: true, synced })
  } catch (err) {
    console.error('[health-sync] Error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ---------------------------------------------------------------------------
// V2 parser — pivots metric arrays into per-day rows
// ---------------------------------------------------------------------------

// Maps Health Auto Export metric names → our DB columns
const METRIC_MAP = {
  heart_rate_variability_sdnn: 'hrv_ms',
  heart_rate_variability:      'hrv_ms',   // Health Auto Export actual name
  resting_heart_rate:          'resting_heart_rate',
  step_count:                  'steps',
  steps:                       'steps',
  active_energy_burned:        'active_calories',
  active_energy:               'active_calories', // Health Auto Export actual name
  basal_energy_burned:         null, // ignore basal/resting energy
  resting_energy:              null,
  respiratory_rate:            null, // not in our schema yet
  // Sleep analysis comes as separate stage entries — handled below
  sleep_analysis:              'sleep_raw',
  asleep:                      'sleep_raw',
  in_bed:                      null, // ignore in_bed, use asleep
}

async function syncV2(metrics) {
  // Build a map: date → { column: value }
  const dayMap = {}

  // Log all metric names received so we can see exact field names
  console.log('[health-sync] metric names received:', metrics.map(m => m.name).join(', '))

  for (const metric of metrics) {
    const col = METRIC_MAP[metric.name?.toLowerCase()]
    if (col === undefined) continue // unknown metric, skip
    if (!Array.isArray(metric.data)) continue

    // Log first data point of each metric so we can see structure
    if (metric.data.length > 0) {
      console.log(`[health-sync] sample "${metric.name}":`, JSON.stringify(metric.data[0]))
    }

    for (const point of metric.data) {
      const date = normalizeDate(point.date ?? point.startDate)
      if (!date) continue
      if (!dayMap[date]) dayMap[date] = {}

      const qty = point.qty ?? point.value ?? point.Qty

      if (col === 'sleep_raw') {
        // Accumulate sleep hours (qty is in hours from Health Auto Export)
        dayMap[date].sleep_hours = (dayMap[date].sleep_hours ?? 0) + (parseFloat(qty) || 0)
      } else if ((col === 'steps' || col === 'active_calories') && qty != null) {
        // Integer columns — must round
        dayMap[date][col] = Math.round(parseFloat(qty))
      } else if (col !== null && qty != null) {
        dayMap[date][col] = parseFloat(qty)
      }
    }
  }

  let synced = 0
  for (const [date, fields] of Object.entries(dayMap)) {
    if (Object.keys(fields).length === 0) continue
    if (await upsertDay(date, fields)) synced++
  }
  return synced
}

// ---------------------------------------------------------------------------
// V1 parser — flat daily objects
// ---------------------------------------------------------------------------

async function upsertDayV1(entry) {
  const date = normalizeDate(entry?.date ?? entry?.startDate ?? entry?.Date)
  if (!date) return false

  const fields = {
    hrv_ms:             extractQty(entry, ['hrv', 'hrv_sdnn', 'HRV', 'heartRateVariabilitySDNN', 'heart_rate_variability_sdnn']),
    resting_heart_rate: extractQty(entry, ['resting_heart_rate', 'restingHeartRate', 'RestingHeartRate']),
    sleep_hours:        extractSleepHoursV1(entry),
    steps:              extractQty(entry, ['steps', 'Steps', 'stepCount', 'step_count']),
    active_calories:    extractQty(entry, ['active_calories', 'activeCalories', 'activeEnergyBurned', 'active_energy_burned']),
  }

  return upsertDay(date, fields)
}

// ---------------------------------------------------------------------------
// Shared upsert
// ---------------------------------------------------------------------------

async function upsertDay(date, fields) {
  // Fetch existing row to preserve BiPAP data
  const { data: existing } = await supabase
    .from('health_metrics')
    .select('bipap_ahi, bipap_hours')
    .eq('date', date)
    .single()

  // Fetch 7-day HRV avg for recovery score
  const { data: recent } = await supabase
    .from('health_metrics')
    .select('hrv_ms')
    .order('date', { ascending: false })
    .limit(7)

  const hrv7dayAvg = recent?.length
    ? recent.reduce((s, m) => s + (m.hrv_ms ?? 0), 0) / recent.length
    : null

  const row = {
    date,
    ...fields,
    source: 'apple_health',
    raw: fields,
  }

  // Preserve existing BiPAP data
  if (existing?.bipap_ahi != null)    row.bipap_ahi    = existing.bipap_ahi
  if (existing?.bipap_hours != null)  row.bipap_hours  = existing.bipap_hours

  row.recovery_score = computeRecoveryScore({
    hrv_ms:       row.hrv_ms ?? null,
    hrv_7day_avg: hrv7dayAvg,
    sleep_hours:  row.sleep_hours ?? null,
    bipap_ahi:    row.bipap_ahi ?? null,
  })

  const { error } = await supabase
    .from('health_metrics')
    .upsert(row, { onConflict: 'date' })

  if (error) {
    console.error(`[health-sync] upsert failed ${date}:`, error.message)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeDate(raw) {
  if (!raw) return null
  // Handle "2026-04-13 07:00:00 -0500" or ISO strings
  return String(raw).slice(0, 10)
}

function extractQty(entry, keys) {
  for (const key of keys) {
    const val = entry?.[key]
    if (val != null && !isNaN(parseFloat(val))) return parseFloat(val)
    if (entry?.[key]?.qty != null) return parseFloat(entry[key].qty)
  }
  return null
}

function extractSleepHoursV1(entry) {
  const direct = extractQty(entry, ['sleep_hours', 'sleepHours', 'asleepDuration', 'SleepDuration'])
  if (direct != null) return direct
  const stages = ['sleepCore', 'sleepDeep', 'sleepREM', 'sleepUnspecified']
  const mins = stages.reduce((s, k) => s + (extractQty(entry, [k]) ?? 0), 0)
  return mins > 0 ? +(mins / 60).toFixed(2) : null
}
