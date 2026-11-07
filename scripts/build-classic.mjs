import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const out='_site';
await mkdir(out,{recursive:true});
await mkdir(join(out,'lite'),{recursive:true});
await mkdir(join(out,'veo-check'),{recursive:true});
await cp('scripts/veo-embed-check.html',join(out,'veo-check','index.html'));

await cp('hosted/web',join(out,'classic'),{recursive:true});
await cp('scripts/classic-bridge.js',join(out,'classic/bridge.js'));
for(const file of ['index.html','app.js','director.js','recorder.js','styles.css'])
  await cp(file,join(out,'lite',file));
await writeFile(join(out,'.nojekyll'),'');
const originalLite=await readFile(join(out,'lite/index.html'),'utf8');
await writeFile(join(out,'lite/index.html'),originalLite.replaceAll('@@BUILD_SHA@@',process.env.GITHUB_SHA||'local'));
let html=await readFile(join(out,'classic/index.html'),'utf8');
if(!html.includes('src="/assets/app.js"') || !html.includes('href="/styles.css"'))
  throw Error('Expected classic editor template was not found');
html=html.replace('href="/styles.css"','href="./styles.css?build='+(process.env.GITHUB_SHA||'local')+'"');
html=html.replace('src="/assets/app.js"','src="./assets/app.js?build='+(process.env.GITHUB_SHA||'local')+'"');
html=html.replace('PLAYER TRACKING · v1.1','COACHING EDITOR · CLASSIC');
html=html.replace('<script src="/free-persistence.js"></script>', ''); // Paid/Free server-only feature, not GitHub Pages

await writeFile(join(out,'classic/index.html'),html);
let style=await readFile(join(out,'classic/styles.css'),'utf8');
style+=[
'/* GitHub Pages runs browser mode; hosted app uses the original full server UI. */',
'#ai-detect,#ai-control-strip{display:none!important}',
'#classic-browser-note{border:1px solid #4b654e;border-radius:7px;background:#15271f;color:#bbd5c2;padding:12px 15px;font-size:12px;line-height:1.5;margin-bottom:13px}',
'#hosted-veo-control{border-color:#6b9251;color:#cdf7ad}',
'#reconnect-match{font-size:11px}',
'@media(max-width:860px){.top-actions{flex-wrap:wrap}}'
].join('\n');
await writeFile(join(out,'classic/styles.css'),style);
let app=await readFile(join(out,'classic/assets/app.js'),'utf8');
const videoStart=app.indexOf('        video.src = ',app.indexOf('if (p.video) {'));
const videoEnd=app.indexOf('\n',videoStart);
if(videoStart<0||videoEnd<0)throw Error('Classic media source patch target missing');
app="import '../bridge.js';\n"+app.slice(0,videoStart)+"        video.src = window.TouchlineClassic.videoSrc(p) || '';" +app.slice(videoEnd);
const selectStart=app.indexOf('        const loaded = await api(');
const selectEnd=app.indexOf('\n',selectStart);
if(selectStart<0||selectEnd<0)throw Error('Classic project loading patch target missing');
app=app.slice(0,selectEnd)+"\n        await window.TouchlineClassic.prepareVideo(loaded);\n        window.TouchlineClassic.currentProject=loaded.id;"+app.slice(selectEnd);
const uploadAnchor='        await new Promise((resolve, reject) => {\n            const xhr = new XMLHttpRequest();';
const start=app.indexOf(uploadAnchor);
const finish=app.indexOf('\n        isUploading = false;',start);
if(start<0||finish<0)throw Error('Classic video upload patch target missing');
app=app.slice(0,start)+
  "        await window.TouchlineClassic.attachFile(projectId,file);\n"+
  "        text('progress-label','100%');\n"+
  "        el('progress-bar').style.width='100%';"+
  app.slice(finish);
await writeFile(join(out,'classic/assets/app.js'),app);
// Route the user's familiar GitHub bookmark to their hosted full Veo editor.
// Preserve /classic/ as the local-only fallback and /lite/ as the older prototype.
await cp('scripts/launcher.html', join(out, 'index.html'));
console.log('Classic browser editor assembled with original design and local data bridge.');
