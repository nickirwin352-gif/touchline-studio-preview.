# Touchline Studio Classic — original editor restored for GitHub

The uploaded Touchline Studio v1.0.0 ZIP is the design and behaviour reference. The classic editor reuses the updated v1.1 source from the existing private Touchline Studio project, preserving the real Veo streaming route, clip and playlist editor, timeline, director tools, overlays, FFmpeg exporter and single-owner cloud password gate. The public repository contains source only, not private match data.

## The GitHub Pages edition

The public GitHub link opens the original professional editor interface at /classic/, not the small proof-of-concept edition. The previous lightweight browser beta is still at /lite/.

Browser-mode project JSON and annotations are stored in IndexedDB on the current device, and local match footage is played from a browser object URL without uploading the video. After refreshing, use Reconnect footage to select the same match again, preserving your annotations. Most drawing, freeze, zoom, tagging, clip and playlist tools run in this mode.

**Instant Veo streaming and server MP4 exporting cannot work from GitHub Pages alone.** The original Node video service that provides those features is included in the hosted/ directory. It must be deployed once to activate them.

## How the original Veo playback worked

The original Veo streaming service resolves an accessible match URL using yt-dlp, then proxies bounded HTTP video-byte ranges from the signed remote video into its same-origin player. Signed CDN URLs are cached in memory only, never stored with projects. The classic timeline and tactical overlays operate on that playback.

The match must be accessible with proper permission, the extractor must resolve it, and the host must support byte ranges. Private or expired Veo recordings can fail. This is not an official Veo partnership and cannot guarantee that every Veo link will play.

## One-time full video service activation

render.yaml describes a Docker service using a paid Starter plan and persistent disk. Review any charges before approving.

1. In the hosting provider, select the public repository nickirwin352-gif/touchline-studio-preview. and choose the supplied Blueprint.
2. Review the paid Starter plan and persistent-disk charges. Set TOUCHLINE_ACCESS_PASSWORD to a random secret of at least 20 characters directly in the host dashboard; do not paste it into chat or commit it.
3. After the service deployment succeeds, open its HTTPS root and log in with username touchline and the private password. This is the actual same-origin editor with Veo Stream instantly and FFmpeg MP4 exporting.
4. In the GitHub Pages edition, click Connect Veo streaming and paste the full service HTTPS root. The GitHub Pages launcher remembers that URL and sends you straight to the full editor whenever you use your GitHub bookmark.

The server container automatically installs FFmpeg and the small yt-dlp utility. You do not need to install Python, FFmpeg or AI models on your laptop. Once the backend has been linked, commits to the public repo and hosting auto-deploy provide the edit-refresh workflow.

## Privacy

GitHub Pages and this repository are public. Never commit videos, private match URLs, credentials, project JSON or signed URLs to the repository. The hosted editor requires its single-owner password and mounted storage disk; arrange backups of that disk. Local browser data is specific to one browser and can be cleared by the browser.

There is currently no connected live backend, so the GitHub Pages copy cannot truthfully claim that Veo streaming or server-side exports work yet.
