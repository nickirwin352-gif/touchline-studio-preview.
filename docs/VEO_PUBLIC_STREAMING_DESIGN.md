# Touchline Studio: public Veo link streaming

## Product goal

Paste an authorised public Veo match link, open its footage **inside** the original Touchline Studio player, seek smoothly, draw/manual-ring on the video timeline, and keep clips and freezes in one workspace. No full-match download or Python setup on the laptop.

This is deliberately **not** a link list, a Veo web embed, a copied full match, or a fake player.

## The real playback path

1. The editor accepts a \`https://app.veo.co/matches/<match-id>/\` URL (with any Veo highlight query preserved as a reference).
2. On a running Touchline backend, \`POST /api/veo/preflight\` parses the canonical match link and resolves the public recording using the Veo support in \`yt-dlp\`.
3. The backend makes a **bounded Range GET** (\`bytes=0-1\`) against the resolved public video, verifies an HTTP 206 response with a valid \`Content-Range\`, and returns only a safe readiness response (\`status\`, \`matchId\`, \`seekable\`). A signed CDN URL is never sent to the editor or saved in project files.
4. If preflight succeeds, the editor asks permission **before replacing a match** and calls its normal \`POST /api/projects/:id/veo-stream\` endpoint. The server reuses the 90-second in-memory preflight result to avoid another extraction, or probes a fresh result if the preflight has expired.
5. The original \`<video>\` element loads \`/api/projects/:id/veo-stream\`. The backend proxies strictly bounded 4 MiB HTTP byte ranges with seek support. It refreshes its temporary signed address when the upstream returns a permission expiry and never uploads or stores a full video as part of streaming.
6. All existing editor controls (play/pause, seek, drawings, player rings, freeze frames, clips and playlists) remain synced to \`video.currentTime\`.

There is **no cross-origin browser fetch of the secret signed URL**, so the original player and annotation overlay remain same-origin.

## What success and failure mean

- **Ready**: video metadata can be resolved *and the CDN responded to a real seek probe*. Playback and browser codec compatibility still need testing with actual matches; this is not a guarantee that all Veo links work.
- **Private / forbidden**: show a clear access error; never ask for a Veo password or try to bypass login.
- **Expired / missing**: explain that the match is no longer available.
- **Non-seekable / invalid Range response**: reject before replacing footage, because tactical clipmaking depends on reliable seeking.
- **Timeout / network / changed Veo format**: return a visible retryable error, keep the previous project intact, and allow the user to open the original link in Veo for viewing.

The readiness check is **read-only**. A failed probe cannot delete the earlier match, its annotations or clips.

## Required infrastructure: one original editor, one host

**GitHub Pages is static.** It cannot run the Node HTTP Range proxy, yt-dlp or FFmpeg. The current GitHub Pages link hosts the visually restored classic UI and the earlier offline prototype, but cannot itself offer this streamed-media feature.

For complete Veo integration, the original Node backend in \`hosted/\` must run on a suitable HTTPS server (for example, the optional paid companion Blueprint already in this repository). The full editor should be served from the **same origin as that backend**, with the GitHub Pages bookmark directing the user there after a one-time configuration. All ongoing source updates can still be made in GitHub and deployed automatically. No manual Python setup on the user's laptop.

Do not make the API anonymously accessible on a public host. Use the existing single-owner password mechanism, TLS, private persistent project storage, and reasonable request/concurrency limits.

## Permissions and terms

Veo says publicly shared recording links are **view-only**: anyone with the URL may watch a public recording, but recipients cannot download it merely because they possess the URL. Watchable does not necessarily mean the user is authorised to save, export, or redistribute the underlying recording. Respect Veo's terms and recording-owner permissions, and only export footage when the user has those rights. This integration does not use private login tokens, cookies, DRM circumvention, or unauthorised download APIs.

Official reference: https://support.veo.com/hc/en-us/articles/4451490513169-How-to-share-Veo-recordings-on-social-media-or-via-link

## Verification before "Veo works" can be claimed

1. Automated tests: URL validation, safe links, read-only preflight, actual Range 206 validation, failure isolation, caching, signed URL secrecy, and regression on clip/annotation edits.
2. Deploy the companion server and confirm its protected \`/api/health\` endpoint works.
3. With explicit permission, try at least two real public Veo match links in the hosted editor, seeking at the beginning, middle and end, pausing, placing a ring and drawing, and reloading.
4. Try a private/inaccessible link and a known non-seekable source, verifying understandable error text and no project data loss.
5. If tests fail because Veo changes its service or sharing rules, report the limitation instead of silently falling back to unrelated functionality.

**Current status:** code and offline tests are present, but no companion host is connected, and real Veo recordings have not been tested end to end. The public GitHub Pages URL alone is not a working third-party Veo stream.

## Diagnosing Veo HTTP 403 in the free Render edition

The Veo extractor first contacts Veo's public-facing match APIs. If Veo returns HTTP 401/403 during that lookup, the recording **has not even been resolved to a video file**. This might mean the Veo recording is private, Veo's extractor API is restricted, or Veo blocks access from the hosted Render IP address. It does **not**, by itself, prove the recording is private.

If the extractor successfully resolves a video address but the CDN then returns 403, that is a **different** failure stage: the media host refused the Touchline video-byte request. In both cases, signed media URLs must stay server-side; do not expose, embed or store them in project files.

To distinguish user permissions from third-party integration restrictions, copy the *same* Veo recording link into a private/incognito browser window while signed out of Veo. If it will not play there, ask the owner to make that specific recording public or grant authorised viewing access. If it plays in a private browser window but Touchline receives 403, that is likely a restriction affecting the external integration or cloud-server IP, and not a user-password problem. View-only public sharing does not automatically entitle other services to retrieve, store or redistribute the video bytes.

The full-editor link dialog provides a **Check link on Veo** button and retains existing footage/annotations when preflight fails. For recordings the user is permitted to download, they can use Veo's own download feature and import the authorised video file. Otherwise, reliable third-party integration requires Veo-supported API or player permissions, not copied cookies or bypassing Veo access controls.
