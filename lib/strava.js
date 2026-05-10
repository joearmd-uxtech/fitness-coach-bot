/**
 * Strava API wrapper
 * Handles token refresh, activity fetching, and gear sync.
 */

import supabase from './supabase.js'

const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'
const STRAVA_API_BASE = 'https://www.strava.com/api/v3'

/**
 * Refreshes the Strava access token using the stored refresh token.
 * Reads the refresh token from the Supabase config table first (written by
 * strava-callback.js and updated on rotation); falls back to the env var for
 * the initial bootstrap before any OAuth flow has been completed.
 *
 * If Strava rotates the refresh token (it does every 6 hours), the new token
 * is persisted back to the config table automatically.
 *
 * Returns a fresh access token (valid for 6 hours).
 */
export async function refreshAccessToken() {
  // 1. Prefer DB-stored token (stays current across rotations)
  let refreshToken = process.env.STRAVA_REFRESH_TOKEN
  try {
    const { data } = await supabase
      .from('config')
      .select('value')
      .eq('key', 'strava_refresh_token')
      .single()
    if (data?.value) refreshToken = data.value
  } catch (_) {
    // DB unavailable — fall back to env var silently
  }

  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Strava token refresh failed: ${res.status} ${text}`)
  }
  const data = await res.json()

  // 2. If Strava rotated the refresh token, persist the new one
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    try {
      await supabase
        .from('config')
        .upsert({ key: 'strava_refresh_token', value: data.refresh_token, updated_at: new Date().toISOString() })
      console.log('[strava] Refresh token rotated — new token saved to DB')
    } catch (_) {
      console.warn('[strava] Could not persist rotated refresh token:', _?.message)
    }
  }

  return data.access_token
}

/**
 * Fetches recent activities after a given Unix timestamp.
 * Defaults to the last 7 days.
 */
export async function fetchRecentActivities(accessToken, afterUnix = null) {
  const after = afterUnix ?? Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000)
  const url = `${STRAVA_API_BASE}/athlete/activities?after=${after}&per_page=30`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Strava activities fetch failed: ${res.status} ${text}`)
  }
  return res.json()
}

/**
 * Fetches the athlete profile including gear list.
 */
export async function fetchAthleteProfile(accessToken) {
  const res = await fetch(`${STRAVA_API_BASE}/athlete`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Strava athlete fetch failed: ${res.status} ${text}`)
  }
  return res.json()
}

/**
 * Fetches detailed gear info for a single gear ID.
 */
export async function fetchGear(accessToken, gearId) {
  const res = await fetch(`${STRAVA_API_BASE}/gear/${gearId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Strava gear fetch failed (${gearId}): ${res.status} ${text}`)
  }
  return res.json()
}

/**
 * Converts a raw Strava activity object into a workouts table row.
 */
export function normalizeActivity(raw) {
  const distanceKm = raw.distance ? raw.distance / 1000 : null

  // Average pace in sec/km (only meaningful for runs)
  let avgPaceSecKm = null
  if (distanceKm && raw.moving_time && raw.type?.includes('Run')) {
    avgPaceSecKm = Math.round(raw.moving_time / distanceKm)
  }

  // Try to extract plan week from Strava activity name/description
  // Runna appends tags like "Run Further Plan · Week 22/26"
  let runnaPlanWeek = null
  const weekMatch = (raw.description ?? '').match(/Week\s+(\d+)\/\d+/i)
  if (weekMatch) runnaPlanWeek = parseInt(weekMatch[1], 10)

  return {
    id: raw.id,
    activity_type: raw.type,
    name: raw.name ?? null,
    description: raw.description ?? null,
    start_date: raw.start_date,
    distance_km: distanceKm,
    duration_seconds: raw.moving_time ?? null,
    avg_pace_sec_km: avgPaceSecKm,
    avg_heart_rate: raw.average_heartrate ? Math.round(raw.average_heartrate) : null,
    max_heart_rate: raw.max_heartrate ? Math.round(raw.max_heartrate) : null,
    elevation_gain_m: raw.total_elevation_gain ? Math.round(raw.total_elevation_gain) : null,
    calories: raw.calories ?? null,
    perceived_exertion: raw.suffer_score ?? null,
    gear_id: raw.gear_id ?? null,
    runna_plan_week: runnaPlanWeek,
    strava_raw: raw,
  }
}

/**
 * Normalizes a Strava gear object into a shoes table row.
 * Only handles shoes — bikes are handled separately.
 *
 * Always uses gear.distance (raw meters) to derive km — never converted_distance,
 * which is in miles when the athlete's Strava account uses imperial units.
 */
export function normalizeShoe(gear) {
  // gear.distance is always meters regardless of athlete locale
  const currentKm = gear.distance != null ? gear.distance / 1000 : 0
  return {
    id: gear.id,
    nickname: gear.name ?? gear.nickname ?? null,
    current_km: currentKm,
    last_synced_at: new Date().toISOString(),
  }
}

/**
 * Normalizes a Strava gear object into a bikes table row.
 * Same imperial-safe distance handling as normalizeShoe.
 */
export function normalizeBike(gear) {
  const currentKm = gear.distance != null ? gear.distance / 1000 : 0
  return {
    id: gear.id,
    nickname: gear.name ?? gear.nickname ?? null,
    current_km: currentKm,
  }
}
