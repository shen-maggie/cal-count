# FastCal

Calorie tracking + intermittent fasting, as an installable web app (PWA). No server: everything is stored on your phone.

## Put it on GitHub Pages
1. On github.com, create a new **public** repo (this one is `cal-count`).
2. Click **Add file → Upload files**, drag in everything in this folder (keep the `icons` folder), and commit.
3. Go to **Settings → Pages**, set Source to **Deploy from a branch**, branch `main`, folder `/ (root)`, Save.
4. After a minute your app is at `https://<your-username>.github.io/cal-count/`.

## Install on iPhone
Open that link in **Safari** → Share → **Add to Home Screen**. Open it from the Home Screen icon, then go to Settings → Enable notifications.

## AI photo logging
Settings → AI photo logging. Pick a provider:
- **Google Gemini (free tier)**: get a key at aistudio.google.com. Free-tier inputs may be used by Google to improve its products.
- **Anthropic Claude (paid, ~1–2¢ per photo)**: get a key at console.anthropic.com.

Keys are stored only on your phone and sent only to that provider.

## Updating
After editing files, bump `VERSION` in `sw.js` so phones pick up the new version.
