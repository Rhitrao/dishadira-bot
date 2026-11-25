# Disha Dira Tarot: the Android app (ticket 60)

A Capacitor shell around the tarot game the Worker serves at `/tarot`. The app opens the game
(`capacitor.config.json` → `server.url`, the test game by default), so every change to the game reaches
the app without a new install. What the app adds: an icon on the phone, a full-screen ritual, and the
daily reminder (`@capacitor/local-notifications`, set from the home screen, nothing sent to us).

- Build: GitHub → Actions → **Android app** → Run workflow (test or live). Download the APK from the
  run's Artifacts, copy it to an Android phone and open it (allow "install unknown apps" once).
- Log in: tap **Continue with WhatsApp**, send the pre-typed `TAROT <code>`, come back to the app.
- Icons and splash: `assets/` (drawn from the card back's lotus), made into Android sizes with
  `npx @capacitor/assets generate --android`.
- Not yet: Google Play billing, a release signing key, the Play Store listing, iOS. See the app plan.
