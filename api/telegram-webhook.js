/**
 * /api/telegram-webhook
 *
 * Core Telegram bot handler.
 * Receives webhook POSTs from Telegram, routes to command handlers,
 * falls through to Claude for free-text messages.
 *
 * Register webhook (run once after deploy):
 *   GET https://{your-app}.vercel.app/api/telegram-webhook?register=1
 */

import supabase from '../lib/supabase.js'
import { chat, buildSystemPrompt } from '../lib/claude.js'
import { sendMessage, sendTyping, downloadFileAsBase64, registerWebhook, parseCommand } from '../lib/telegram.js'
import { recommendShoe, formatShoeRoster } from '../lib/shoe-recommender.js'
import { computeRecoveryScore, recoveryLabel, recoveryGuidance } from '../lib/recovery-score.js'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function handler(req, res) {
  // Webhook registration helper
  if (req.method === 'GET' && req.query.register) {
    const webhookUrl = `https://${req.headers.host}/api/telegram-webhook`
    const result = await registerWebhook(webhookUrl)
    return res.status(200).json(result)
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const update = req.body
  const message = update?.message ?? update?.edited_message

  if (!message) {
    return res.status(200).json({ ok: true })
  }

  const chatId = message.chat.id.toString()
  const text = message.text ?? ''
  const photo = message.photo

  // Security: only respond to Jose's chat ID
  if (process.env.TELEGRAM_CHAT_ID && chatId !== process.env.TELEGRAM_CHAT_ID) {
    console.warn(`[webhook] Ignoring message from unknown chat ${chatId}`)
    return res.status(200).json({ ok: true })
  }

  try {
    await sendTyping(chatId)

    // Photo message → /plan handler
    if (photo && photo.length > 0) {
      await handlePlan(chatId, photo)
      return res.status(200).json({ ok: true })
    }

    const parsed = parseCommand(text)
    if (parsed) {
      switch (parsed.command) {
        case 'start':
        case 'help':
          await handleHelp(chatId)
          break
        case 'today':
          await handleToday(chatId)
          break
        case 'shoes':
          await handleShoes(chatId)
          break
        case 'last':
          await handleLast(chatId)
          break
        case 'week':
          await handleWeek(chatId)
          break
        case 'recovery':
          await handleRecovery(chatId)
          break
        case 'plan':
          await sendMessage(chatId, 'Send me a screenshot of your Runna weekly calendar and I\'ll extract the plan.')
          break
        case 'sleep':
          await handleSleep(chatId, parsed.args)
          break
        case 'weight':
          await handleWeight(chatId, parsed.args)
          break
        case 'sync':
          await handleSync(chatId)
          break
        default:
          // Unknown command — let Claude handle it as free text
          await handleFreeText(chatId, text)
      }
    } else if (text.trim()) {
      await handleFreeText(chatId, text)
    }

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[webhook] Error handling message:', err)
    await sendMessage(chatId, `Sorry, something went wrong: ${err.message}`)
    return res.status(200).json({ ok: true })
  }
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleHelp(chatId) {
  const msg = `*Fitness AI Coach*

Commands:
/today — Today's workout plan, shoe recommendation, recovery status
/shoes — Full shoe roster with mileage
/last — Analysis of last completed workout
/week — This week's plan + completion status
/recovery — Recovery score breakdown (HRV, sleep, AHI)
/sleep [hours] [ahi] — Log BiPAP data manually
/weight [kg] — Update current weight
/sync — Manually trigger Strava sync

Or just send me a message — I have your full training context.

Send a *Runna screenshot* to load your weekly plan.`
  await sendMessage(chatId, msg)
}

async function handleToday(chatId) {
  const today = new Date().toISOString().slice(0, 10)

  const [
    { data: planned },
    { data: metrics },
    { data: shoes },
  ] = await Promise.all([
    supabase.from('planned_workouts').select('*').eq('planned_date', today).single(),
    supabase.from('health_metrics').select('*').order('date', { ascending: false }).limit(1).single(),
    supabase.from('shoes').select('*').eq('is_retired', false),
  ])

  // Recovery score
  const { data: recentMetrics } = await supabase
    .from('health_metrics').select('hrv_ms').order('date', { ascending: false }).limit(7)
  const hrv7dayAvg = recentMetrics?.length
    ? recentMetrics.reduce((s, m) => s + (m.hrv_ms ?? 0), 0) / recentMetrics.length
    : null

  const score = metrics
    ? computeRecoveryScore({ hrv_ms: metrics.hrv_ms, hrv_7day_avg: hrv7dayAvg, sleep_hours: metrics.sleep_hours, bipap_ahi: metrics.bipap_ahi })
    : null

  // Shoe recommendation
  const workoutType = planned?.workout_type ?? 'easy_run'
  const { recommended, warnings } = recommendShoe({ workoutType, shoes: shoes ?? [] })

  let msg = `*Today — ${today}*\n\n`

  if (planned) {
    msg += `*Plan:* ${planned.workout_type.replace('_', ' ')}${planned.planned_distance_km ? ` — ${planned.planned_distance_km}km` : ''}\n`
    if (planned.description) msg += `${planned.description}\n`
  } else {
    msg += `No plan found for today. Easy run or rest day.\n`
  }

  msg += `\n*Recovery:* ${score ?? 'N/A'}/100 (${score ? recoveryLabel(score) : 'N/A'})\n`
  if (score) msg += `${recoveryGuidance(score)}\n`

  msg += `\n*Shoe recommendation:* ${recommended.length ? recommended.slice(0, 2).join(' or ') : 'No recommendation available'}\n`

  if (warnings.length) {
    msg += `\n*Alerts:*\n${warnings.map(w => `• ${w}`).join('\n')}\n`
  }

  await sendMessage(chatId, msg)
}

async function handleShoes(chatId) {
  const { data: shoes } = await supabase.from('shoes').select('*').order('is_retired', { ascending: true })
  if (!shoes?.length) {
    return sendMessage(chatId, 'No shoe data found. Run a Strava sync first.')
  }

  const active = shoes.filter(s => !s.is_retired)
  const retired = shoes.filter(s => s.is_retired)

  let msg = `*Shoe Roster*\n\n`
  active.forEach(s => {
    const pct = s.max_km > 0 ? Math.round((s.current_km / s.max_km) * 100) : '?'
    const bar = progressBar(pct)
    const carbonTag = s.carbon_plate ? ' [CARBON]' : ''
    msg += `*${s.nickname}* — ${s.brand} ${s.model}${carbonTag}\n`
    msg += `${bar} ${s.current_km}km / ${s.max_km}km (${pct}%)\n`
    msg += `_${s.use_type} | ${s.heel_drop_mm}mm drop | ${s.cushioning} cushion_\n\n`
  })

  if (retired.length) {
    msg += `_Retired: ${retired.map(s => s.nickname).join(', ')}_`
  }

  await sendMessage(chatId, msg)
}

async function handleLast(chatId) {
  const { data: workout } = await supabase
    .from('workouts')
    .select('*')
    .order('start_date', { ascending: false })
    .limit(1)
    .single()

  if (!workout) {
    return sendMessage(chatId, 'No workouts found. Make sure Strava is synced.')
  }

  // Ask Claude for analysis
  const workoutSummary = formatWorkoutDetail(workout)
  const reply = await chat(chatId, `Analyze my last workout:\n\n${workoutSummary}`)
  await sendMessage(chatId, reply)
}

async function handleWeek(chatId) {
  const weekStart = getWeekStart()
  const weekEnd = getWeekEnd()

  const [{ data: planned }, { data: completed }] = await Promise.all([
    supabase.from('planned_workouts').select('*').gte('planned_date', weekStart).lte('planned_date', weekEnd).order('planned_date'),
    supabase.from('workouts').select('*').gte('start_date', weekStart + 'T00:00:00Z').order('start_date'),
  ])

  if (!planned?.length) {
    return sendMessage(chatId, 'No plan loaded for this week. Send a Runna screenshot to load it.')
  }

  let msg = `*This Week (${weekStart} to ${weekEnd})*\n\n`
  planned.forEach(p => {
    const done = p.completed_workout_id ? '✅' : '⬜'
    const dist = p.planned_distance_km ? ` ${p.planned_distance_km}km` : ''
    msg += `${done} *${p.planned_date}* — ${p.workout_type.replace('_', ' ')}${dist}\n`
    if (p.description) msg += `  _${p.description}_\n`
  })

  const totalPlanned = planned.filter(p => p.planned_distance_km).reduce((s, p) => s + p.planned_distance_km, 0)
  const totalDone = planned.filter(p => p.completed_workout_id).length
  msg += `\n${totalDone}/${planned.length} sessions completed`
  if (totalPlanned > 0) msg += ` | ${totalPlanned.toFixed(1)}km planned total`

  await sendMessage(chatId, msg)
}

async function handleRecovery(chatId) {
  const { data: metrics } = await supabase
    .from('health_metrics')
    .select('*')
    .order('date', { ascending: false })
    .limit(1)
    .single()

  if (!metrics) {
    return sendMessage(chatId, 'No health data available. Make sure Apple Health Auto Export is configured.')
  }

  const { data: recentMetrics } = await supabase
    .from('health_metrics').select('hrv_ms').order('date', { ascending: false }).limit(7)
  const hrv7dayAvg = recentMetrics?.length
    ? Math.round(recentMetrics.reduce((s, m) => s + (m.hrv_ms ?? 0), 0) / recentMetrics.length)
    : null

  const score = computeRecoveryScore({
    hrv_ms: metrics.hrv_ms,
    hrv_7day_avg: hrv7dayAvg,
    sleep_hours: metrics.sleep_hours,
    bipap_ahi: metrics.bipap_ahi,
  })

  const msg = `*Recovery — ${metrics.date}*

*Score: ${score}/100* (${recoveryLabel(score)})

HRV: ${metrics.hrv_ms ?? 'N/A'}ms (7-day avg: ${hrv7dayAvg ?? 'N/A'}ms)
Resting HR: ${metrics.resting_heart_rate ?? 'N/A'}bpm
Sleep: ${metrics.sleep_hours ?? 'N/A'}hrs
BiPAP AHI: ${metrics.bipap_ahi != null ? `${metrics.bipap_ahi} events/hr` : 'N/A'}${metrics.bipap_ahi > 10 ? ' ⚠️' : ''}
Steps: ${metrics.steps?.toLocaleString() ?? 'N/A'}

_${recoveryGuidance(score)}_`

  await sendMessage(chatId, msg)
}

async function handleSleep(chatId, args) {
  const hours = parseFloat(args[0])
  const ahi = parseFloat(args[1])

  if (isNaN(hours)) {
    return sendMessage(chatId, 'Usage: /sleep [hours] [ahi]\nExample: /sleep 6.5 3.2')
  }

  const today = new Date().toISOString().slice(0, 10)
  const updates = { sleep_hours: hours }
  if (!isNaN(ahi)) updates.bipap_ahi = ahi

  const { error } = await supabase
    .from('health_metrics')
    .upsert({ date: today, ...updates, source: 'manual' }, { onConflict: 'date' })

  if (error) {
    return sendMessage(chatId, `Failed to save: ${error.message}`)
  }

  let msg = `Logged for ${today}: ${hours}hrs sleep`
  if (!isNaN(ahi)) msg += `, AHI ${ahi}`
  await sendMessage(chatId, msg)
}

async function handleWeight(chatId, args) {
  const weight = parseFloat(args[0])
  if (isNaN(weight) || weight < 30 || weight > 300) {
    return sendMessage(chatId, 'Usage: /weight [kg]\nExample: /weight 97.5')
  }

  const { error } = await supabase
    .from('athlete_profile')
    .update({ weight_kg: weight, updated_at: new Date().toISOString() })
    .neq('id', '00000000-0000-0000-0000-000000000000') // update all rows (single-row table)

  if (error) {
    return sendMessage(chatId, `Failed to update: ${error.message}`)
  }

  await sendMessage(chatId, `Weight updated to ${weight}kg.`)
}

async function handleSync(chatId) {
  await sendMessage(chatId, 'Triggering Strava sync...')
  try {
    const res = await fetch(`https://${process.env.VERCEL_URL}/api/strava-sync`, { method: 'GET' })
    const data = await res.json()
    if (data.ok) {
      await sendMessage(chatId, `Sync complete. ${data.synced_activities} activities, ${data.synced_shoes} shoes synced.`)
    } else {
      await sendMessage(chatId, `Sync failed: ${data.error}`)
    }
  } catch (err) {
    await sendMessage(chatId, `Sync error: ${err.message}`)
  }
}

async function handlePlan(chatId, photos) {
  await sendMessage(chatId, 'Got it — extracting your Runna plan...')

  // Use the largest photo (last in array = highest resolution)
  const fileId = photos[photos.length - 1].file_id

  try {
    const base64Image = await downloadFileAsBase64(fileId)

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: `Extract the training plan from this Runna screenshot.
Return a JSON array (no markdown, no explanation — raw JSON only) with one object per workout day shown.
Fields per object:
  - date: YYYY-MM-DD (today is ${new Date().toISOString().slice(0, 10)} — use this year for all dates)
  - workout_type: one of "easy_run", "long_run", "tempo", "intervals", "fartlek", "strength", "rest", "cross_training"
  - planned_distance_km: number or null (null for strength/rest/cross-training)
  - description: brief description of the session as shown in Runna (e.g. "Easy 8km + 4x100m strides")
  - plan_week: integer week number if visible, otherwise null`,
          },
        ],
      }],
    })

    const jsonText = response.content[0]?.text?.trim()
    let workouts
    try {
      workouts = JSON.parse(jsonText)
    } catch {
      // Try to extract JSON from markdown code block
      const match = jsonText.match(/```(?:json)?\s*([\s\S]+?)\s*```/)
      workouts = match ? JSON.parse(match[1]) : null
    }

    if (!Array.isArray(workouts) || workouts.length === 0) {
      return sendMessage(chatId, 'Could not parse the plan from that screenshot. Try sending a clearer image.')
    }

    // Upsert into planned_workouts
    const rows = workouts.map(w => ({
      planned_date: w.date,
      plan_week: w.plan_week ?? null,
      workout_type: w.workout_type,
      planned_distance_km: w.planned_distance_km ?? null,
      description: w.description ?? null,
      screenshot_parsed_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('planned_workouts')
      .upsert(rows, { onConflict: 'planned_date' })

    if (error) {
      return sendMessage(chatId, `Plan extracted but save failed: ${error.message}`)
    }

    const summary = workouts.map(w => {
      const dist = w.planned_distance_km ? ` ${w.planned_distance_km}km` : ''
      return `• ${w.date} — ${w.workout_type.replace('_', ' ')}${dist}`
    }).join('\n')

    await sendMessage(chatId, `Plan loaded for ${workouts.length} days:\n\n${summary}`)
  } catch (err) {
    console.error('[handlePlan] Error:', err)
    await sendMessage(chatId, `Failed to parse plan: ${err.message}`)
  }
}

async function handleFreeText(chatId, text) {
  const reply = await chat(chatId, text)
  await sendMessage(chatId, reply)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWorkoutDetail(w) {
  const lines = [
    `Date: ${w.start_date?.slice(0, 10)}`,
    `Type: ${w.activity_type}`,
    `Name: ${w.name ?? 'N/A'}`,
  ]
  if (w.distance_km) lines.push(`Distance: ${w.distance_km.toFixed(2)}km`)
  if (w.duration_seconds) lines.push(`Duration: ${formatDuration(w.duration_seconds)}`)
  if (w.avg_pace_sec_km) lines.push(`Avg pace: ${formatPace(w.avg_pace_sec_km)}/km`)
  if (w.avg_heart_rate) lines.push(`Avg HR: ${w.avg_heart_rate}bpm`)
  if (w.max_heart_rate) lines.push(`Max HR: ${w.max_heart_rate}bpm`)
  if (w.elevation_gain_m) lines.push(`Elevation gain: ${w.elevation_gain_m}m`)
  if (w.perceived_exertion) lines.push(`Suffer score: ${w.perceived_exertion}`)
  if (w.description) lines.push(`Description: ${w.description}`)
  return lines.join('\n')
}

function formatPace(secPerKm) {
  const min = Math.floor(secPerKm / 60)
  const sec = secPerKm % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  return h > 0
    ? `${h}h ${m}m`
    : `${m}m ${s.toString().padStart(2, '0')}s`
}

function progressBar(pct) {
  const filled = Math.round((pct / 100) * 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function getWeekStart() {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  return new Date(new Date().setDate(diff)).toISOString().slice(0, 10)
}

function getWeekEnd() {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? 0 : 7)
  return new Date(new Date().setDate(diff)).toISOString().slice(0, 10)
}
