/**
 * Shoe recommendation logic.
 *
 * Given a workout type and current health context, returns:
 *   - recommended: array of shoe nicknames (in priority order)
 *   - warnings: array of alert strings (mileage, Achilles, carbon plate, etc.)
 */

/**
 * @param {object} params
 * @param {string}  params.workoutType        'easy_run' | 'long_run' | 'tempo' | 'intervals' | 'trail' | 'race' | 'fartlek'
 * @param {object[]} params.shoes             Active shoe rows from the DB
 * @param {boolean} [params.achillesFlaring]  true if Achilles is currently aggravated
 * @returns {{ recommended: string[], warnings: string[] }}
 */
export function recommendShoe({ workoutType, shoes, achillesFlaring = false }) {
  const active = shoes.filter(s => !s.is_retired)
  const warnings = []

  // Map workout type to use_type candidates (ordered by preference)
  const candidateUseTypes = getCandidateUseTypes(workoutType)

  // Filter shoes matching the candidates
  let candidates = active.filter(s => candidateUseTypes.includes(s.use_type))

  // Achilles guard: deprioritize low heel-drop shoes if Achilles is flaring
  if (achillesFlaring) {
    const flagged = candidates.filter(s => s.heel_drop_mm != null && s.heel_drop_mm < 8)
    if (flagged.length > 0) {
      warnings.push(
        `Achilles concern: avoid ${flagged.map(s => s.nickname).join(', ')} (low heel drop ≤5mm). Prefer ≥8mm drop.`
      )
      // Move low-drop shoes to end of list so they're last resort, not removed entirely
      candidates = [
        ...candidates.filter(s => !s.heel_drop_mm || s.heel_drop_mm >= 8),
        ...flagged,
      ]
    }
  }

  // Carbon plate guard: race shoes only for races
  if (workoutType !== 'race') {
    const carbonShoes = candidates.filter(s => s.carbon_plate)
    carbonShoes.forEach(s => {
      warnings.push(`${s.nickname} (${s.brand} ${s.model}) has a carbon plate — reserve for races only, not training.`)
    })
    candidates = candidates.filter(s => !s.carbon_plate)
  }

  // Mileage warnings for all active shoes (not just candidates)
  active.forEach(s => {
    if (s.is_retired) return
    const pct = s.max_km > 0 ? s.current_km / s.max_km : 0
    if (s.carbon_plate && s.current_km >= 400) {
      warnings.push(
        `${s.nickname} (carbon plate) is at ${s.current_km}km/${s.max_km}km — carbon plate may be degraded. Use sparingly.`
      )
    } else if (pct >= 0.9) {
      warnings.push(
        `${s.nickname} is at ${Math.round(pct * 100)}% of max life (${s.current_km}km/${s.max_km}km). Consider retiring soon.`
      )
    } else if (pct >= 0.8) {
      warnings.push(
        `${s.nickname} is at ${Math.round(pct * 100)}% of max life (${s.current_km}km/${s.max_km}km). Watch mileage.`
      )
    }
  })

  const recommended = candidates.map(s => s.nickname)

  return { recommended, warnings }
}

/**
 * Returns ordered list of shoe use_types to search, given a workout type.
 */
function getCandidateUseTypes(workoutType) {
  switch (workoutType) {
    case 'easy_run':
    case 'recovery':
      return ['easy', 'versatile']
    case 'long_run':
      return ['long', 'easy']
    case 'tempo':
    case 'progressive':
      return ['tempo', 'versatile']
    case 'intervals':
    case 'fartlek':
      return ['tempo', 'versatile']
    case 'trail':
      return ['trail']
    case 'race':
      return ['race', 'tempo']
    default:
      return ['easy', 'versatile', 'tempo', 'long']
  }
}

/**
 * Returns a formatted shoe roster string for use in the Claude system prompt or /shoes command.
 */
export function formatShoeRoster(shoes) {
  const active = shoes.filter(s => !s.is_retired)
  return active.map(s => {
    const pct = s.max_km > 0 ? Math.round((s.current_km / s.max_km) * 100) : '?'
    const carbonTag = s.carbon_plate ? ' [CARBON]' : ''
    return `• ${s.nickname} — ${s.brand} ${s.model} | ${s.use_type} | ${s.current_km}km / ${s.max_km}km (${pct}%)${carbonTag}`
  }).join('\n')
}
