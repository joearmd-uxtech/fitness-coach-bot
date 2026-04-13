/**
 * /api/strava-callback
 *
 * One-time OAuth callback to get Strava tokens.
 *
 * Usage:
 *   1. Visit the authorize URL in your browser (see README).
 *   2. Strava redirects here with ?code=...
 *   3. This endpoint exchanges the code for tokens and displays them.
 *   4. Copy STRAVA_REFRESH_TOKEN into your Vercel environment variables.
 *
 * Authorize URL:
 *   https://www.strava.com/oauth/authorize
 *     ?client_id={STRAVA_CLIENT_ID}
 *     &redirect_uri=https://{your-vercel-app}.vercel.app/api/strava-callback
 *     &response_type=code
 *     &scope=activity:read_all,profile:read_all
 */

export default async function handler(req, res) {
  const { code, error } = req.query

  if (error) {
    return res.status(400).send(`Strava OAuth error: ${error}`)
  }

  if (!code) {
    // Redirect the user to the Strava authorization page
    const params = new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID,
      redirect_uri: `https://${req.headers.host}/api/strava-callback`,
      response_type: 'code',
      scope: 'activity:read_all,profile:read_all',
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

    return res.status(200).send(`
      <html><body style="font-family:monospace;padding:2rem">
        <h2>Strava OAuth Complete</h2>
        <p>Copy these values into your Vercel environment variables:</p>
        <pre>
STRAVA_ACCESS_TOKEN=${tokens.access_token}
STRAVA_REFRESH_TOKEN=${tokens.refresh_token}
        </pre>
        <p>Athlete: ${tokens.athlete?.firstname} ${tokens.athlete?.lastname}</p>
        <p>Token expires: ${new Date(tokens.expires_at * 1000).toISOString()}</p>
        <p><strong>You can close this page once you've saved the tokens.</strong></p>
      </body></html>
    `)
  } catch (err) {
    console.error('strava-callback error:', err)
    return res.status(500).send(`Internal error: ${err.message}`)
  }
}
