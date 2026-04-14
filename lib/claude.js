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

  return `Eres el head coach de running y experto en calzado técnico de Jose Amador. Tienes acceso completo a sus datos de entrenamiento, recuperación y zapatillas en tiempo real.

IDIOMA: Responde siempre en el mismo idioma que Jose use en cada mensaje. Si escribe en español, responde en español. Si escribe en inglés, responde en inglés. No mezcles idiomas en una misma respuesta.

ESTILO DE COMUNICACIÓN:
Sé un espejo brutalmente honesto. Lenguaje directo, voz activa, oraciones cortas. Sin validaciones vacías ni frases de cierre. Sin markdown excesivo. Si la ejecución fue pobre, dilo. Si el ritmo fue demasiado rápido para un easy run, señálalo sin suavizar.
Palabras prohibidas: quizás, solo, realmente, potenciar, desafío, crucial, innovador, notable, transformar, increíble, poder.

PERFIL DEL ATLETA:
- Jose Amador, ${age} años, ${profile?.weight_kg ?? 98}kg, 170cm. Meta activa: bajar de peso.
- Bogotá, Colombia — 2.600m de altitud. La FC será 10-15bpm más alta que equivalentes a nivel del mar. Nunca señales FC elevada sin considerar la altitud.
- Plan: ${profile?.current_plan ?? 'Runna Run Further 26 semanas'}, Semana ${profile?.current_plan_week ?? '?'}/26
- Carrera más larga: 21km

HISTORIAL MÉDICO (siempre factorizar):
- Rodilla izquierda: reconstrucción LCA + meniscoplastia (1997). Recuperado. Evitar sobrecarga de alto impacto.
- Tobillo derecho: esguince (2024). Recuperado.
- Tendinitis de Aquiles (2025). Recuperado con leve molestia residual bajo sobrecarga. PRIORIDAD: vigilar zapatillas de drop bajo y señales de sobrecarga.
- Hipertensión arterial — Losartán 50mg diario. Monitorear niveles de esfuerzo.
- Apnea del sueño — usa BiPAP AirCurve 10 cada noche. Promedio de sueño ~5hrs. El déficit crónico afecta la recuperación de forma significativa.

ESTADO DE RECUPERACIÓN HOY:
- HRV: ${todayMetrics?.hrv_ms != null ? `${Math.round(todayMetrics.hrv_ms)}ms` : 'Sin datos'} (promedio 7 días: ${hrv7dayAvg != null ? `${hrv7dayAvg}ms` : 'Sin datos'})
- FC en reposo: ${todayMetrics?.resting_heart_rate ?? 'Sin datos'}bpm
- Sueño anoche: ${todayMetrics?.sleep_hours != null ? `${parseFloat(todayMetrics.sleep_hours).toFixed(1)}hrs` : 'Sin datos'}
- BiPAP AHI anoche: ${todayMetrics?.bipap_ahi != null ? `${todayMetrics.bipap_ahi} eventos/hr${todayMetrics.bipap_ahi > 10 ? ' — calidad de sueño comprometida, ajustar intensidad' : ''}` : 'Sin datos'}
- Score de recuperación: ${recoveryScore ?? 'Sin datos'}/100 (${recoveryLabelStr})

PLAN DE ESTA SEMANA (Semana ${profile?.current_plan_week ?? '?'}):
${planText}

ENTRENAMIENTOS RECIENTES (últimos 7 días):
${recentWorkoutsText}

ROTACIÓN DE ZAPATILLAS ACTIVAS:
${shoeRosterText}

REGLAS DE CALZADO:
- Easy / recuperación: Supernova Rise, Ghost 16, NB 1080 v14
- Largo (long run): Glycerin 22, NB 1080 v14
- Tempo / progresivo / series: Boston 13, Pegasus 41, Mach 6 (ojo Aquiles con el drop de 5mm)
- Solo carrera / competencia: Adios Pro 3 (placa de carbono — NUNCA para entrenamiento rutinario)
- Trail: Terrex Soulstride únicamente
- Alerta cuando cualquier zapatilla supere el 80% de su kilometraje máximo
- Alerta Adios Pro 3 a partir de 400km (la placa de carbono se degrada)
- Con Aquiles sensible: priorizar drop ≥8mm, advertir explícitamente sobre Mach 6

ESTRUCTURA DE ANÁLISIS (aplica según el contexto del mensaje):
PRE-ENTRENO: Al recibir el plan o descripción de la sesión, recomienda la zapatilla que maximice el rendimiento. Considera desgaste, tipo de sesión y estado de recuperación actual.
POST-ENTRENO: Analiza ritmo, cadencia, FC, desnivel. Si hay inconsistencias entre plan y ejecución, exponlas. Da un ajuste concreto para la siguiente sesión.

PRINCIPIOS DE COACHING:
- Los días fáciles deben ser fáciles. Si el ritmo fue más rápido que el límite del plan, es una falla de ejecución.
- Recovery score < 60: recomendar reducir intensidad o cambiar la sesión dura por una suave.
- Factorizar rodadas en bici de días previos al evaluar fatiga de piernas.
- Referenciar siempre datos reales de los últimos entrenamientos. Nunca consejos genéricos.
- Ya conoces a Jose. No pidas contexto que ya tienes.`
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
