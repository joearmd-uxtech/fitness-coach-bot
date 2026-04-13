/**
 * Claude API wrapper.
 *
 * Builds the dynamic system prompt from Supabase data and handles
 * multi-turn conversation with persistent chat history.
 */

import Anthropic from '@anthropic-ai/sdk'
import supabase from './supabase.js'
import { computeRecoveryScore, recoveryLabel, recoveryGuidance } from './recovery-score.js'
import { formatShoeRoster } from './shoe-recommender.js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 1024
const HISTORY_LIMIT = 20 // messages to load from DB per session

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

export async function buildSystemPrompt() {
  // Load all context in parallel
  const [
    { data: profile },
    { data: shoes },
    { data: todayMetrics },
    { data: recentWorkouts },
    { data: plannedWorkouts },
  ] = await Promise.all([
    supabase.from('athlete_profile').select('*').limit(1).single(),
    supabase.from('shoes').select('*').eq('is_retired', false),
    supabase.from('health_metrics').select('*').order('date', { ascending: false }).limit(1).single(),
    supabase
      .from('workouts')
      .select('*')
      .order('start_date', { ascending: false })
      .limit(7),
    supabase
      .from('planned_workouts')
      .select('*')
      .gte('planned_date', getWeekStart())
      .lte('planned_date', getWeekEnd())
      .order('planned_date', { ascending: true }),
  ])

  // Compute 7-day HRV average
  const { data: recentMetrics } = await supabase
    .from('health_metrics')
    .select('hrv_ms')
    .order('date', { ascending: false })
    .limit(7)
  const hrv7dayAvg = recentMetrics?.length
    ? Math.round(recentMetrics.reduce((sum, m) => sum + (m.hrv_ms ?? 0), 0) / recentMetrics.length)
    : null

  // Recovery score
  let recoveryScore = null
  let recoveryLabelStr = 'Unknown'
  let recoveryGuide = ''
  if (todayMetrics) {
    recoveryScore = computeRecoveryScore({
      hrv_ms: todayMetrics.hrv_ms,
      hrv_7day_avg: hrv7dayAvg,
      sleep_hours: todayMetrics.sleep_hours,
      bipap_ahi: todayMetrics.bipap_ahi,
    })
    recoveryLabelStr = recoveryLabel(recoveryScore)
    recoveryGuide = recoveryGuidance(recoveryScore)
  }

  // Format recent workouts
  const recentWorkoutsText = recentWorkouts?.length
    ? recentWorkouts.map(w => formatWorkoutLine(w)).join('\n')
    : 'No recent workouts found.'

  // Format this week's plan
  const planText = plannedWorkouts?.length
    ? plannedWorkouts.map(p => formatPlannedLine(p)).join('\n')
    : 'No plan loaded for this week. Jose should send a Runna screenshot with /plan.'

  // Format shoe roster
  const shoeRosterText = shoes?.length ? formatShoeRoster(shoes) : 'No shoe data available.'

  const age = profile ? new Date().getFullYear() - profile.birth_year : 44

  return `You are Jose's personal running coach and fitness advisor. You have full context about his health, training history, and goals. Be direct, specific, and reference actual data — never generic advice.

## Athlete Profile
- Name: Jose Amador, born ${profile?.birth_year ?? 1981}, ${age} years old
- Weight: ${profile?.weight_kg ?? 98}kg, Height: ${profile?.height_cm ?? 170}cm — weight loss is an active goal
- Location: Bogotá, Colombia — altitude 2,600m (impacts HR, pace, and recovery significantly)
- Current training: ${profile?.current_plan ?? 'Runna Run Further 26-week plan'}, Week ${profile?.current_plan_week ?? '?'}/26
- Longest run ever: ${profile?.longest_run_km ?? 21}km

## Medical & Injury Context (always factor into recommendations)
- Left knee: ACL reconstruction + meniscoplasty (1997) — recovered, but avoid high-impact overload
- Right ankle: sprain (2024) — recovered
- Achilles tendinitis (2025) — therapy complete, slight residual discomfort under overload. PRIORITY concern — flag low heel-drop shoes and overload signs.
- High blood pressure — Losartan 50mg daily. Monitor exertion levels.
- Sleep apnea — uses BiPAP nightly. Sleep quality is often poor despite hours in bed.
- Average sleep: ~5 hours. Chronic sleep deficit affects recovery significantly.

## Today's Recovery Status
- HRV: ${todayMetrics?.hrv_ms ?? 'N/A'}ms (7-day avg: ${hrv7dayAvg ?? 'N/A'}ms)
- Resting HR: ${todayMetrics?.resting_heart_rate ?? 'N/A'}bpm
- Sleep last night: ${todayMetrics?.sleep_hours ?? 'N/A'}hrs
- BiPAP AHI last night: ${todayMetrics?.bipap_ahi != null ? `${todayMetrics.bipap_ahi} events/hr` : 'N/A'}${todayMetrics?.bipap_ahi > 10 ? ' ⚠️ Poor sleep quality — factor into intensity' : ''}
- Recovery score: ${recoveryScore ?? 'N/A'}/100 (${recoveryLabelStr})
- Guidance: ${recoveryGuide}

## This Week's Plan (Week ${profile?.current_plan_week ?? '?'})
${planText}

## Recent Workouts (last 7 days)
${recentWorkoutsText}

## Shoe Roster (active only)
${shoeRosterText}

## Shoe Recommendation Rules
- Achilles concern: prefer heel drop ≥8mm. Flag Hoka Mach 6 (5mm drop) explicitly if Achilles is flaring.
- Easy/recovery runs: Supernova Rise, Ghost 16, NB 1080 v14
- Long runs: Glycerin 22, NB 1080 v14
- Tempo/workout: Boston 13, Hoka Mach 6 (watch Achilles), Pegasus 41
- Race only: Adios Pro 3 (carbon plate — do NOT recommend for training)
- Trail: Terrex Soulstride only
- Alert when any shoe exceeds 80% of max_km
- Alert on Adios Pro 3 after 400km (carbon plate degrades faster)

## Coaching Principles
- Altitude (2,600m): HR runs 10-15bpm higher than sea-level equivalents. Never flag elevated HR as a problem without accounting for altitude.
- If recovery_score < 60: recommend reducing intensity or swapping a hard session
- If AHI > 10 last night: flag poor sleep quality explicitly and factor into readiness
- Factor in cycling rides from previous days when assessing leg fatigue
- Jose is on a structured 26-week plan — respect the plan's intent (easy days should be easy)
- Be direct and specific, not generic. Reference actual numbers from recent workouts.
- You already know Jose — don't ask for context he's already given you.`
}

// ---------------------------------------------------------------------------
// Chat function
// ---------------------------------------------------------------------------

/**
 * Sends a message and gets a response, with persistent chat history.
 *
 * @param {string} sessionId     Telegram chat_id
 * @param {string} userMessage   The user's message text
 * @param {object} [imageBlock]  Optional Claude image content block (for /plan screenshots)
 * @returns {string} Assistant reply text
 */
export async function chat(sessionId, userMessage, imageBlock = null) {
  // Load recent history from DB
  const { data: history } = await supabase
    .from('chat_history')
    .select('role, content')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)

  const messages = (history ?? []).reverse() // oldest first

  // Build user content
  const userContent = imageBlock
    ? [imageBlock, { type: 'text', text: userMessage }]
    : userMessage

  messages.push({ role: 'user', content: userContent })

  // Build system prompt fresh for each request
  const systemPrompt = await buildSystemPrompt()

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: systemPrompt,
    messages,
  })

  const reply = response.content[0]?.text ?? 'Sorry, I could not generate a response.'

  // Persist both turns to DB
  await supabase.from('chat_history').insert([
    { session_id: sessionId, role: 'user', content: typeof userContent === 'string' ? userContent : userMessage },
    { session_id: sessionId, role: 'assistant', content: reply },
  ])

  return reply
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWorkoutLine(w) {
  const date = w.start_date ? w.start_date.slice(0, 10) : '?'
  const dist = w.distance_km ? `${w.distance_km.toFixed(1)}km` : ''
  const pace = w.avg_pace_sec_km ? `@ ${formatPace(w.avg_pace_sec_km)}/km` : ''
  const hr = w.avg_heart_rate ? `avg HR ${w.avg_heart_rate}bpm` : ''
  const parts = [date, w.activity_type, dist, pace, hr].filter(Boolean)
  return `• ${parts.join(' | ')}${w.name ? ` — ${w.name}` : ''}`
}

function formatPlannedLine(p) {
  const done = p.completed_workout_id ? '✓' : '○'
  const dist = p.planned_distance_km ? `${p.planned_distance_km}km` : ''
  const parts = [p.planned_date, p.workout_type, dist].filter(Boolean)
  return `${done} ${parts.join(' | ')}${p.description ? ` — ${p.description}` : ''}`
}

function formatPace(secPerKm) {
  const min = Math.floor(secPerKm / 60)
  const sec = secPerKm % 60
  return `${min}:${sec.toString().padStart(2, '0')}`
}

function getWeekStart() {
  const d = new Date()
  const day = d.getDay() // 0=Sun
  const diff = d.getDate() - day + (day === 0 ? -6 : 1) // Mon
  return new Date(d.setDate(diff)).toISOString().slice(0, 10)
}

function getWeekEnd() {
  const d = new Date()
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? 0 : 7) // Sun
  return new Date(d.setDate(diff)).toISOString().slice(0, 10)
}
