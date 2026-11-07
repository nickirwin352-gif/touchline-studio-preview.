# Touchline Studio — Live Browser Editor

This is the **public, no-install** Touchline Studio preview. The page itself is public, but the footage you open stays in the browser on your computer and is **not uploaded to GitHub**.

## Current editor
- Open local MP4/WebM recordings directly in the browser, plus a practice pitch for quick testing.
- Create fixed coloured rings below players, spotlights, tactical arrows, boxes, lines, circles, freehand strokes and labels.
- Change colour, size, timing, fade and **pop** transitions.
- Add **smooth camera zooms** at any position, with adjustable scale/duration, and freeze holds.
- Tag, preview and organise clip ranges. Use full playback and manual frame stepping.
- Export clips with tactical overlays, zooms and freeze holds using the **browser's MediaRecorder**. Output is **MP4 on browsers that support it, otherwise WebM**. Audio is included when browser video/audio capture supports it. Exports run at roughly playback speed and are limited to 3 minutes to prevent excessive memory use. Local video files are required; cross-origin browser restrictions prevent remote video rendering.
- Save lightweight projects in local browser storage, with JSON backup and restore. Match video files are not included in backups.

## Veo workflow
1. Click **Veo / video link**.
2. Paste the official Veo recording link and save it to the project.
3. Use **Open Veo** to watch the match from its original source.
4. If your Veo account has download permission, open the Veo recording and choose **Download full game**. Attach that MP4 with **Attach match video**.
5. Analyse the local file, apply zooms/drawings/freeze frames, save clips and export your annotated videos.

**What this does not do:** an ordinary Veo sharing link cannot automatically grant a separate static GitHub Pages site access to stream or download the underlying match. Sharing links are view-only. There is no exposed Veo credential, scraping code, secret, unauthorised download proxy, or hidden API in this static editor. Real one-click authenticated import would require Veo's authorised integration support and a secure backend. See Veo's official [sharing](https://support.veo.com/hc/en-us/articles/4451490513169-How-to-share-Veo-recordings-on-social-media-or-via-link) and [downloading](https://support.veo.com/hc/en-us/articles/4451733961361-How-to-download-your-Veo-recordings) guidance.

## Publishing
The **Publish Touchline Studio** GitHub Actions workflow runs syntax checks and browser logic tests, then publishes the static editor to GitHub Pages whenever files change on `main`. After a successful deployment, reload the same website URL to see updates.

## Privacy and browser notes
- The **website and source code are public**, so never commit match files, personal information, logins or API secrets to this repository.
- Project annotations and clip metadata are stored in the local browser, and are not synchronised to other devices. Clearing browser data can delete them; **download JSON backups**.
- Chrome/Edge may remember permission for a chosen match file; in other browsers, use **Reconnect video** after refreshing.
- Export depends on browser-native MediaRecorder, HTML canvas and permitted media codecs. Some browsers only support WebM; others support MP4. Long and high-resolution videos may export more slowly. The desktop edition continues to exist as a separate, private project.
