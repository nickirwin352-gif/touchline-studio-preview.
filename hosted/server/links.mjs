// Linked media are validated, but the server NEVER fetches arbitrary URLs.
// This avoids SSRF and avoids attempting to bypass Veo's access controls.
function parseHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || value.trim().length === 0) {
    throw Object.assign(new Error('Enter a link of no more than 2048 characters'), { status: 400 });
  }
  let url;
  try { url = new URL(value.trim()); }
  catch { throw Object.assign(new Error('Enter a valid HTTPS link'), { status: 400 }); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw Object.assign(new Error('Only HTTPS links without embedded credentials are supported'), { status: 400 });
  }
  return url;
}
export function validateVeoLink(value) {
  const url = parseHttpsUrl(value);
  if (!['veo.co', 'veo.com'].some((base) => url.hostname === base || url.hostname.endsWith(`.${base}`))) {
    throw Object.assign(new Error('This is not a Veo link. Use an app.veo.co / veo.co link, or paste a direct video-file URL.'), { status: 400 });
  }
  return url.toString();
}
export function validateVideoUrl(value) {
  const url = parseHttpsUrl(value);
  if (!/\.(mp4|m4v|mov|webm)$/i.test(url.pathname)) {
    throw Object.assign(new Error('Direct video links must end in .mp4, .m4v, .mov or .webm (before any ? parameters). Veo watch pages are not video files.'), { status: 400 });
  }
  return url.toString();
}
