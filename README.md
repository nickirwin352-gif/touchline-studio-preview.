# Touchline Studio — public browser preview

A lightweight football-analysis editor that opens directly in your browser. No Python, model downloads, server, or video uploads are needed.

**This repository contains only the browser preview.** The full Windows source code and experimental tracking work remain in the separate private development repository.

## What you can do
- Open your own MP4 or WebM video locally, or practise on the demo football pitch
- Add coloured player rings, arrows, lines, boxes, circles, spotlights, freehand strokes and labels
- Adjust drawing colours, position, timing and fade
- Create freeze-frame holds, timeline markers and quick clips
- Save projects in this browser and export/import JSON project backups
- Save Veo watch URLs as reference links, or open direct browser-playable HTTPS video URLs

## Limitations
- Veo watch-page links open in Veo; they cannot be streamed directly on GitHub Pages.
- MP4 export with annotations remains in the original desktop edition during this first beta.
- Browsers cannot automatically open local video files after every refresh without permission; a **Reconnect video** action is provided.
- Project data is local to this browser and is not synced; download backups regularly.
- This website is **public**, but footage is **not uploaded to GitHub** by the editor. Do not commit match videos or sensitive project files.

## Publishing on GitHub Pages

The repository includes a GitHub Actions workflow to build and publish this editor when a change lands on the `main` branch. To activate it once:

1. Open **Settings → Pages** in this repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. The workflow named **Publish Touchline Studio** will run on each future update; run it manually once from **Actions** if needed.
4. When it finishes, use GitHub Pages' **Visit site** button and bookmark the address. Refresh after future deployments.

GitHub may have stored the repository name with a trailing full stop. If so, the Pages URL may also contain that full stop. Renaming the repository later is possible in **Settings → General**.

## Local development
```sh
npm test
```

Only Node.js is used for code tests. No Node.js installation is required to use the published website.
