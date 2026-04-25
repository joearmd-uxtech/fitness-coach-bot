/**
 * /api/strava-callback
 *
 * One-time OAuth callback to get Strava tokens.
 * Protected by ?secret= query parameter (use HEALTH_SYNC_SECRET value).
 *
 * Usage:
 *   1. Visit /api/strava-callback?secret=YOUR_SECRET in your browser.
 *   2. You'll be redirected to Strava's authorization page.
 *   3. Strava redirects back here with ?code=...
 *   4. Tokens are saved to the Supabase config table automatically.
 *      No tokens are shown in the browser.
 *
 * Authorize URL (constructed automatically on first visit):
 *   https://{your-vercel-app}.vercel.app/api/strava-callback?secret=YOUR_SECRET
 */

import supabase from '../lib/supabase.js'

export default async function handler(req, res) {
  const { code, error, secret, state } = req.query

  // ── Security gate ────────────────────────────────────────────────────────────
  // The secret must match on both the initial visit and the OAuth redirect.
  // We embed the secret in the OAuth state parameter so Strava echoes it back.
  const expectedSecret = process.env.HEALTH_SYNC_SECRET
  const incomingSecret = secret ?? state  // initial visit uses ?secret=, callback uses ?state=
  if (!expectedSecret || incomingSecret !== expectedSecret) {
    return res.status(401).send('Unauthorized')
  }

  if (error) {
    return res.status(400).send(`Strava OAuth error: ${error}`)
  }

  if (!code) {
    // Redirect the user to the Strava authorization page.
    // Embed the secret in the state parameter so it comes back in the callback.
    const params = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      redirect_uri: `https://${req.headers.host}/api/strava-callback`,
      response_type: 'code',
      scope: 'activity:read_all,profile:read_all',
      state: expectedSecret,
    })
    return res.redirect(`https://www.strava.com/oauth/authorize?${params}`)
  }

  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    })

    if (!tokenRes.ok) {
      const text = await tokenRes.text()
      return res.status(500).send(`Token exchange failed: ${tokenRes.status} ${text}`)
    }

    const tokens = await tokenRes.json()

    // Persist the refresh token to the database — never expose it in the browser
    const { error: dbErr } = await supabase
      .from('config')
      .upsert({ key: 'strava_refresh_token', value: tokens.refresh_token, updated_at: new Date().toISOString() })
    if (dbErr) {
      console.error('[strava-callback] Failed to save refresh token:', dbErr.message)
      return res.status(500).send('Token exchange succeeded but failed to save to database. Check Vercel logs.')
    }

    console.log(`[strava-callback] Refresh token saved for athlete ${tokens.athlete?.id}`)

    return res.status(200).send(`
      <html><body style="font-family:sans-serif;padding:2rem;max-width:500px">
        <h2>✅ Strava Connected</h2>
        <p>Athlete: <strong>${tokens.athlete?.firstname} ${tokens.athlete?.lastname}</strong></p>
        <p>Refresh token saved to database. The bot will use it automatically.</p>
        <p style="color:#666;font-size:0.9em">Token expires: ${new Date(tokens.expires_at * 1000).toISOString()}</p>
        <p>You can close this page.</p>
      </body></html>
    `)
  } catch (err) {
    console.error('[strava-callback] Error:', err)
    return res.status(500).send(`Internal error: ${err.message}`)
  }
}
