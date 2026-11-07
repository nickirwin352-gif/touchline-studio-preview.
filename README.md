# Touchline Studio — Classic football analysis

**Your editor:** https://nickirwin352-gif.github.io/touchline-studio-preview./

This project is the original-style Touchline Studio football editor, with coloured player rings, arrows, timed telestration, freeze frames, camera zooms, clips, playlists and video export. The source repository and GitHub Pages website are public; private match footage and credentials should never be committed to GitHub.

## One-click deploy: Veo streaming and MP4 export

The GitHub Pages version can edit local footage, but cannot run a Veo streaming server. For **paste a publicly shared Veo link → play inside the editor**, deploy the included video backend on Render.

[**Deploy the full Touchline Studio to Render**](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fnickirwin352-gif%2Ftouchline-studio-preview..git)

The included [`render.yaml`](render.yaml) configures:
- Docker, Node.js, yt-dlp and FFmpeg automatically on the host; **nothing to install on your laptop**
- Starter web server and a 10 GB persistent disk (about **US$9.50/month** together at Render's current listed prices, plus possible bandwidth usage)
- Automatic GitHub `main` branch deployments
- One login with username **`touchline`** and your own secret password

**During deployment:** Review the recurring charges and approve them only if acceptable. Set `TOUCHLINE_ACCESS_PASSWORD` to a unique password of at least 20 characters **inside Render's dashboard**, not in GitHub or chat. Do not share your password with anyone. Keep the disk attached so project data survives restarts.

Once Render shows its live HTTPS URL ending in `.onrender.com`, the full editor should be at that link. Share **only the public service URL** with your assistant to replace the GitHub Pages bookmark's destination with your full editor. Never share the secret password. Veo playback still needs testing against real, authorised public Veo links; deployment alone is not proof of compatibility.

## What public Veo playback does

With the full backend running, Paste Veo link in the editor performs an availability and video seek check before replacing your existing match. On success, the stream plays in the actual Touchline video timeline via small byte-range responses; no full-match download is required. Access-denied and non-seekable recordings show a clear error and preserve your earlier match and annotations. Signed video URLs remain server-side. Some public Veo links may still fail if Veo changes its delivery system or access rules.

[Detailed Veo public streaming design](docs/VEO_PUBLIC_STREAMING_DESIGN.md) · [Classic editor setup and limitations](docs/CLASSIC_EDITOR.md)

## Other ways to use Touchline Studio

- **GitHub Pages Classic:** full original-style workspace for local videos and local browser projects. Veo streaming and server-side MP4 export are unavailable until the full backend is deployed.
- **Previous lightweight prototype:** https://nickirwin352-gif.github.io/touchline-studio-preview./lite/
- **Full Render editor:** one secure hosted editor for public Veo playback, match projects, timed drawings and FFmpeg-based MP4 export, after deployment and verification.

The earlier private Windows development repository remains separate and untouched.
