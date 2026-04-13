/**
 * /api/strava-sync
 *
 * Vercel cron job — runs daily at 6am Bogotá (11am UTC).
 * Syncs the last 7 days of activities + gear from Strava into Supabase.
 */

import supabase from '../lib/supabase.js'
import {
  refreshAccessToken,
  fetchRecentActivities,
  fetchAthleteProfile,
  fetchGear,
  normalizeActivity,
  normalizeShoe,
  normalizeBike,
} from '../lib/strava.js'

export default async function handler(req, res) {
  // Allow both Vercel cron (GET) and manual triggers (GET/POST)
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    console.log('[strava-sync] Starting sync...')

    // 1. Refresh access token
    const accessToken = await refreshAccessToken()
    console.log('[strava-sync] Token refreshed')

    // 2. Fetch activities from last 7 days
    const afterUnix = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000)
    const activities = await fetchRecentActivities(accessToken, afterUnix)
    console.log(`[strava-sync] Fetched ${activities.length} activities`)

    // 3. Upsert workouts
    const workoutRows = activities.map(normalizeActivity)
    if (workoutRows.length > 0) {
      const { error: workoutsError } = await supabase
        .from('workouts')
        .upsert(workoutRows, { onConflict: 'id' })
      if (workoutsError) throw new Error(`Workouts upsert failed: ${workoutsError.message}`)
    }

    // 4. Try to match completed workouts to planned_workouts by date
    for (const row of workoutRows) {
      if (!row.start_date) continue
      const activityDate = row.start_date.slice(0, 10)
      const { data: planned } = await supabase
        .from('planned_workouts')
        .select('id')
        .eq('planned_date', activityDate)
        .is('completed_workout_id', null)
        .limit(1)
        .single()
      if (planned) {
        await supabase
          .from('planned_workouts')
          .update({ completed_workout_id: row.id })
          .eq('id', planned.id)
      }
    }

    // 5. Fetch athlete profile for gear list
    const athlete = await fetchAthleteProfile(accessToken)

    // 6. Sync shoes
    const shoeGear = athlete.shoes ?? []
    for (const gear of shoeGear) {
      try {
        const detailed = await fetchGear(accessToken, gear.id)
        const shoeRow = normalizeShoe(detailed)

        // Only update km + last_synced — preserve manual metadata (nickname, use_type, etc.)
        const { error } = await supabase
          .from('shoes')
          .update({
            current_km: shoeRow.current_km,
            last_synced_at: shoeRow.last_synced_at,
          })
          .eq('id', shoeRow.id)

        if (error) {
          // Shoe not in our table yet — insert with basic info
          await supabase.from('shoes').upsert(shoeRow, { onConflict: 'id' })
        }
      } catch (gearErr) {
        console.warn(`[strava-sync] Could not sync shoe ${gear.id}: ${gearErr.message}`)
      }
    }

    // 7. Sync bikes
    const bikeGear = athlete.bikes ?? []
    for (const gear of bikeGear) {
      try {
        const detailed = await fetchGear(accessToken, gear.id)
        const bikeRow = normalizeBike(detailed)
        const { error } = await supabase
          .from('bikes')
          .update({ current_km: bikeRow.current_km })
          .eq('id', bikeRow.id)
        if (error) {
          await supabase.from('bikes').upsert(bikeRow, { onConflict: 'id' })
        }
      } catch (gearErr) {
        console.warn(`[strava-sync] Could not sync bike ${gear.id}: ${gearErr.message}`)
      }
    }

    console.log('[strava-sync] Sync complete')
    return res.status(200).json({
      ok: true,
      synced_activities: workoutRows.length,
      synced_shoes: shoeGear.length,
      synced_bikes: bikeGear.length,
    })
  } catch (err) {
    console.error('[strava-sync] Error:', err)
    return res.status(500).json({ error: err.message })
  }
}
