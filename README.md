# Touchline Studio — Classic Football Analysis

**Existing GitHub editor:** https://nickirwin352-gif.github.io/touchline-studio-preview./

The original-style Touchline Studio interface has manual player rings, arrows, labels, tactical annotation timing, zoom, freezes, clips and playlists. The source and GitHub Pages website are public, but never commit match footage, project data or credentials.

## Try public Veo playback for free (one user)

[**Deploy Touchline Studio — Render Free ($0 web service)**](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fnickirwin352-gif%2Ftouchline-studio-preview..git)

The included [render.yaml](render.yaml) now configures **Render's Free web service**, with no paid disk or local laptop installation. The Docker image includes the actual Node.js streaming server, FFmpeg and yt-dlp. A public Veo match link is resolved on the server, checked for HTTP video seeking, then streamed through the original in-editor player in small byte ranges.

**What to do on Render:** Sign in; review the service configuration and verify it explicitly says **Free / $0** and does not add a disk or other paid resources. Set `TOUCHLINE_ACCESS_PASSWORD` to a unique 20+ character private password *in Render's form*. Do not send this password in chat. The username is `touchline`. Confirm deployment. Render will provide a unique HTTPS `.onrender.com` service address. You may share just that public address (not your password) for the next connection step.

### Free-plan limitations

Render's Free plan is intended for personal experiments, not reliable all-day production use:

- The server sleeps after 15 minutes of inactivity. Opening the site again might take about a minute.
- The server has **ephemeral storage**. Video files you upload to the server and MP4 files awaiting download can vanish if it sleeps, restarts or redeploys.
- To reduce lost work, a **browser-side project snapshot** on the Render-hosted site backs up your drawings, clip metadata, zooms, freezes and Veo reference links in IndexedDB and tries to restore them after a cold start. This is experimental and works only in the **same browser on the same Render URL**, not across devices. Clearing browser data loses this copy too. It does **not** back up uploaded videos or finished exports, and it should not be your sole archive of important analysis.
- Public Veo streams may use significant network bandwidth, CPU and outbound requests. The free service may be slowed or suspended if limits are reached. If your workspace has a payment method, check Render's usage and spending controls to avoid unexpected overage charges.
- The public Veo extractor may stop working if Veo updates access or video delivery. Public sharing is *view-only*; analyse and export recordings only with appropriate permission.

**No Render instance is deployed simply by committing this repository.** You must explicitly create it in your own Render workspace. The GitHub Pages site remains available unchanged until you choose to connect a successful backend.

### Retaining the paid option

The previous Starter-plus-persistent-disk blueprint is preserved separately as [render-paid.yaml](render-paid.yaml), but it is **not** used by the deployment link above. The free deployment never requests a paid disk.

## Current Veo workflow

1. Open the full Render-hosted Touchline Studio editor after deploying it; sign in with your own credentials.
2. Paste a publicly shared `https://app.veo.co/matches/...` recording into **Veo / video link**.
3. Touchline performs a read-only video/seeking preflight test. Existing footage and drawings are kept if the check fails.
4. If supported, watch the match **inside the normal Touchline editor**, draw player rings and arrows, create clips, and seek the recording without downloading the whole game.
5. Verify your actual authorised recording works before relying on this workflow.

More detail: [Public Veo streaming design](docs/VEO_PUBLIC_STREAMING_DESIGN.md) · [Classic editor notes](docs/CLASSIC_EDITOR.md).

The original private Windows project is separate and untouched.
