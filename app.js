// Touchline Studio browser edition: all editing stays client-side.
import { installDirector } from './director.js';
// No backend, AI models, authentication or third-party libraries.
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const COLORS = ['#b7ff75', '#ffffff', '#65c8ff', '#fbd36c', '#ff7a91', '#b697ff', '#ffad60'];
const ICONS = { ring:'◎', arrow:'➜', line:'╱', rect:'▱', ellipse:'◯', pen:'✎', text:'T', spotlight:'◉' };
const STORE = 'touchline-browser-projects-v1';
const DB_NAME = 'touchline-browser-v1';
const state = {
  db:null, projects:[], project:null, selected:null, tool:'select',
  color:COLORS[0], mediaUrl:null, fileHandle:null, fileReady:false,
  demoTime:0, demoPlaying:false, tickAt:0, frameId:0,
  drawing:null, moving:null, saveTimer:null, savePromise:Promise.resolve(),
  undo:[], redo:[], freezeSeen:new Set(), freezeActive:false, freezeTimer:null,
  previewEnd:null, lastOverlayAt:0, exporting:false, exportAbort:null
};
let director=null;
const video = typeof document !== 'undefined' ? $('video') : null;
const overlay = typeof document !== 'undefined' ? $('overlay') : null;

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }
export function formatTime(t) {
  const sec = Math.max(0, Math.floor(Number(t) || 0));
  const two = (v) => String(v).padStart(2,'0');
  return sec >= 3600 ? Math.floor(sec/3600) + ':' + two(Math.floor(sec/60)%60) + ':' + two(sec%60) : two(Math.floor(sec/60)) + ':' + two(sec%60);
}
export function opacityAt(a, t) {
  if (t < a.start || t > a.end) return 0;
  const fade = Math.max(0, Number(a.fade)||0);
  return fade ? clamp(Math.min((t-a.start)/fade,(a.end-t)/fade),0,1) : 1;
}
const uid = () => crypto.randomUUID();
const copy = (v) => structuredClone(v);
const now = () => new Date().toISOString();
const isVideo = (p) => p && (p.mediaKind === 'file' || p.mediaKind === 'url');
const duration = () => Math.max(.1,Number(state.project?.duration)||90);
const playhead = () => state.fileReady ? (video.currentTime || 0) : state.demoTime;
const isPlaying = () => state.fileReady ? !video.paused : state.demoPlaying;
const show = (id, visible) => { $(id).hidden = !visible; };
function toast(message, isError=false) {
  const t=$('toast'); t.textContent=message; t.classList.toggle('error',isError); t.classList.add('visible');
  clearTimeout(toast.timer); toast.timer=setTimeout(()=>t.classList.remove('visible'),3600);
}
const projectFactory = () => ({
  id:uid(), title:'Untitled analysis', createdAt:now(), updatedAt:now(),
  duration:90, mediaKind:'demo', mediaName:'', videoUrl:null, sourceLink:null,
  annotations:[], freezes:[], zooms:[], clips:[]
});
function openDB() {
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,1);
    req.onupgradeneeded=()=>{
      if(!req.result.objectStoreNames.contains('projects')) req.result.createObjectStore('projects',{keyPath:'id'});
      if(!req.result.objectStoreNames.contains('handles')) req.result.createObjectStore('handles');
    };
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
  });
}
function dbRequest(store,mode,method,...args) {
  return new Promise((resolve,reject)=>{
    const tx=state.db.transaction(store,mode),req=tx.objectStore(store)[method](...args);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=()=>reject(req.error);
    tx.onerror=()=>reject(tx.error);
  });
}
async function loadAll() {
  if(state.db) return dbRequest('projects','readonly','getAll');
  try { return JSON.parse(localStorage.getItem(STORE)||'[]'); } catch { return []; }
}
async function persist(p) {
  if(state.db) return dbRequest('projects','readwrite','put',p);
  localStorage.setItem(STORE,JSON.stringify(state.projects));
}
async function removeStored(id) {
  if(state.db) { await dbRequest('projects','readwrite','delete',id); await dbRequest('handles','readwrite','delete',id); }
  else localStorage.setItem(STORE,JSON.stringify(state.projects));
}
function queueSave() {
  if(!state.project)return;
  state.project.updatedAt=now();
  $('save-state').textContent='Saving…';
  clearTimeout(state.saveTimer);
  state.saveTimer=setTimeout(()=>{void flushSave();},320);
}
async function flushSave() {
  clearTimeout(state.saveTimer);state.saveTimer=null;
  if(!state.project) return state.savePromise;
  const snapshot=copy(state.project);
  state.savePromise=state.savePromise.catch(()=>{}).then(()=>persist(snapshot));
  try { await state.savePromise; $('save-state').textContent='● Saved in this browser'; }
  catch(err) { $('save-state').textContent='Save failed'; toast('Could not save: '+err.message,true); }
}
function makeButton(label,className,action) {
  const b=document.createElement('button');b.type='button';b.textContent=label;b.className=className;b.addEventListener('click',action);return b;
}
function renderProjects() {
  const list=$('projects');list.replaceChildren();
  for(const p of state.projects.slice().sort((a,b)=>(b.updatedAt||'').localeCompare(a.updatedAt||''))) {
    const row=document.createElement('div');row.className='project-row'+(state.project?.id===p.id?' active':'');
    const button=makeButton('','project-select',()=>{void selectProject(p.id);});
    const glyph=document.createElement('span');glyph.className='project-glyph';glyph.textContent=isVideo(p)?'▶':'▤';
    const meta=document.createElement('span');meta.style.minWidth='0';
    const name=document.createElement('b');name.textContent=p.title;
    const sub=document.createElement('small');sub.textContent=(p.mediaName||'Practice pitch')+' · '+formatTime(p.duration||90);
    meta.append(name,sub);button.append(glyph,meta);
    const del=makeButton('×','project-delete',()=>{void deleteProject(p.id);});del.title='Delete project';
    row.append(button,del);list.append(row);
  }
}
function setNoMedia() {
  state.fileReady=false;
  if(state.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(state.mediaUrl);
  state.mediaUrl=null; video.pause();video.removeAttribute('src');video.load();
  $('stage').classList.remove('with-video');
  $('stage').style.aspectRatio='16 / 9';
  overlay.setAttribute('viewBox','0 0 1000 562.5');
}
async function restoreMedia() {
  const p=state.project;
  setNoMedia();show('reconnect-panel',false);
  state.fileHandle=null;
  if(!p || p.mediaKind==='demo')return;
  if(p.mediaKind==='url' && p.videoUrl) {setVideoSource(p.videoUrl);return;}
  if(p.mediaKind!=='file')return;
  if(state.db) {
    try {
      state.fileHandle=await dbRequest('handles','readonly','get',p.id);
      if(state.fileHandle && (await state.fileHandle.queryPermission({mode:'read'}))==='granted') {
        await loadPickedFile(await state.fileHandle.getFile(),false);return;
      }
    } catch(e) {console.warn('Video file permission was not restored',e);}
  }
  show('reconnect-panel',true);
}
function setVideoSource(src) {
  if(state.mediaUrl?.startsWith('blob:')) URL.revokeObjectURL(state.mediaUrl);
  state.mediaUrl=src;state.fileReady=true;
  $('stage').classList.add('with-video');show('reconnect-panel',false);
  video.src=src;video.load();
}
async function loadPickedFile(file,saveKind=true) {
  if(!file || !file.type.startsWith('video/') && !/\.(mp4|mov|m4v|webm)$/i.test(file.name)) {toast('Choose a video file (MP4 or WebM recommended)',true);return;}
  setVideoSource(URL.createObjectURL(file));
  if(saveKind) {
    state.project.mediaKind='file';state.project.mediaName=file.name;state.project.videoUrl=null;
    queueSave();
  }
  $('media-note').textContent=file.name+' · Local match footage';
  $('media-state').textContent='MATCH FOOTAGE';
}
async function selectProject(id) {
  await flushSave();
  const p=state.projects.find(x=>x.id===id);if(!p)return;
  resetFreeze();state.project=p;state.selected=null;state.undo=[];state.redo=[];
  state.demoTime=0;state.previewEnd=null;
  p.zooms ||= [];
  $('title').value=p.title;
  $('media-note').textContent=p.mediaKind==='file'?(p.mediaName||'Match video')+' · Local footage':p.mediaKind==='url'?'Direct browser video link':'Practice on the demo pitch or add match footage';
  $('media-state').textContent=isVideo(p)?'MATCH FOOTAGE':'DEMO CANVAS';
  renderProjects();
  await restoreMedia();
  renderSource();renderEverything();updateTime();
}
async function createProject() {
  await flushSave();
  const p=projectFactory();state.projects.unshift(p);
  await persist(copy(p));
  await selectProject(p.id);$('title').focus();$('title').select();
}
async function deleteProject(id) {
  const p=state.projects.find(x=>x.id===id);if(!p || !confirm('Delete "'+p.title+'" from this browser? This cannot be undone.'))return;
  clearTimeout(state.saveTimer);await state.savePromise.catch(()=>{});
  state.projects=state.projects.filter(x=>x.id!==id);
  await removeStored(id);
  if(state.project?.id===id) {
    state.project=null; if(state.projects.length)await selectProject(state.projects[0].id); else await createProject();
  } else renderProjects();
  toast('Project removed');
}
async function pickVideo() {
  if(!state.project)return;
  if(typeof window.showOpenFilePicker==='function') {
    try {
      const [handle]=await window.showOpenFilePicker({multiple:false,types:[{description:'Match footage',accept:{'video/mp4':['.mp4','.m4v'],'video/webm':['.webm'],'video/quicktime':['.mov']}}]});
      const file=await handle.getFile();
      state.fileHandle=handle;
      if(state.db) await dbRequest('handles','readwrite','put',handle,state.project.id);
      await loadPickedFile(file,true);
      toast('Match video opened without making a copy');return;
    } catch(err) {
      if(err?.name==='AbortError')return;
      console.warn('File picker fallback',err);
    }
  }
  $('video-file').click();
}
async function reconnectVideo() {
  if(state.fileHandle) {
    try {
      const permission=await state.fileHandle.requestPermission({mode:'read'});
      if(permission==='granted') {await loadPickedFile(await state.fileHandle.getFile(),false);toast('Match video reconnected');return;}
    } catch(e) {console.warn(e);}
  }
  await pickVideo();
}
function renderSource() {
  const p=state.project;
  show('source-panel',!!p?.sourceLink);
  if(p?.sourceLink) {
    $('source-title').textContent='Veo recording linked to this project';
    $('source-desc').textContent=p.mediaKind==='file'&&state.fileReady
      ?'Your match is ready to analyse; the original Veo link is saved.'
      :'Open the recording in Veo and attach an authorised downloaded file.';
  }
}
function attachLink() {
  const p=state.project;if(!p)return;
  const input=prompt('Paste a Veo match URL or a direct HTTPS .mp4 / .webm video URL:',p.sourceLink||p.videoUrl||'');
  if(input===null)return;
  let url;try{url=new URL(input.trim());}catch{toast('Please enter a valid HTTPS link',true);return;}
  if(url.protocol!=='https:'||url.username||url.password){toast('Only HTTPS links without embedded passwords are supported',true);return;}
  const isVeo=url.hostname==='app.veo.co' && url.pathname.startsWith('/matches/');
  const direct=/\.(mp4|webm|m4v|mov)$/i.test(url.pathname);
  if(isVeo){p.sourceLink=url.toString();renderSource();toast('Veo reference saved — attach a video for on-page editing');}
  else if(direct){
    p.mediaKind='url';p.mediaName='Direct video link';p.videoUrl=url.toString();
    setVideoSource(p.videoUrl);$('media-note').textContent='Direct browser video URL — availability depends on video host';
    $('media-state').textContent='ONLINE VIDEO';
    toast('Video URL added (host must allow browser playback)');
  } else {toast('Use an app.veo.co/matches/ link or a direct .mp4/.webm URL',true);return;}
  queueSave();renderProjects();
}
function totalHeight() {
  const view=overlay.viewBox.baseVal;return view?.height||562.5;
}
function coords(event) {
  const r=overlay.getBoundingClientRect();
  return {x:clamp((event.clientX-r.left)/r.width,0,1),y:clamp((event.clientY-r.top)/r.height,0,1)};
}
const createSvg=(tag,attrs={})=>{
  const n=document.createElementNS(SVG,tag);
  for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));
  return n;
};
function renderAnnotation(a,force=false) {
  const W=1000,H=totalHeight(),t=playhead();
  let alpha=opacityAt(a,t);
  if(!isPlaying() && Math.abs(t-a.start)<.06) alpha=1;
  if(force) alpha=Math.max(.72,alpha);
  if(alpha<=0 || !Number.isFinite(alpha))return null;
  const x=a.x*W,y=a.y*H,x2=(a.x2??a.x)*W,y2=(a.y2??a.y)*H,stroke=(a.weight||4)*1.4;
  const g=createSvg('g',{'data-id':a.id,opacity:alpha});
  const base={stroke:a.color,'stroke-width':stroke,fill:'none','stroke-linecap':'round','stroke-linejoin':'round'};
  if(a.type==='ring') {
    g.append(createSvg('ellipse',{cx:x,cy:y,rx:Math.max(10,30+(a.weight||4)*3),ry:Math.max(4,7+(a.weight||4)*1.1),stroke:a.color,'stroke-width':stroke,fill:'none',opacity:'.30'}));
    g.append(createSvg('ellipse',{cx:x,cy:y,rx:Math.max(10,30+(a.weight||4)*3),ry:Math.max(4,7+(a.weight||4)*1.1),stroke:a.color,'stroke-width':Math.max(2,stroke/2),fill:'none'}));
  } else if(a.type==='spotlight'){
    g.append(createSvg('circle',{cx:x,cy:y,r:Math.max(32,(a.weight||4)*11),fill:a.color,'fill-opacity':'.13',stroke:a.color,'stroke-width':stroke}));
  } else if(a.type==='rect'){
    g.append(createSvg('rect',{x:Math.min(x,x2),y:Math.min(y,y2),width:Math.max(1,Math.abs(x2-x)),height:Math.max(1,Math.abs(y2-y)),rx:4,...base}));
  } else if(a.type==='ellipse'){
    g.append(createSvg('ellipse',{cx:(x+x2)/2,cy:(y+y2)/2,rx:Math.max(1,Math.abs(x2-x)/2),ry:Math.max(1,Math.abs(y2-y)/2),...base}));
  } else if(a.type==='pen') {
    const points=(a.points||[]).filter(q=>Number.isFinite(q.x)&&Number.isFinite(q.y)).map(q=>(q.x*W)+','+(q.y*H));
    g.append(createSvg('polyline',{points:points.join(' '),...base}));
  } else if(a.type==='text'){
    const label=createSvg('text',{x,y,fill:a.color,'font-size':22+(a.weight||4)*2,'font-weight':800,'paint-order':'stroke','stroke-width':'4',stroke:'#071018','dominant-baseline':'middle'});
    label.textContent=a.label||'Label';g.append(label);
  } else if(a.type==='line'||a.type==='arrow'){
    g.append(createSvg('line',{x1:x,y1:y,x2,y2,...base}));
    if(a.type==='arrow'){
      const angle=Math.atan2(y2-y,x2-x),size=13+(a.weight||4)*2;
      const p1=[x2-size*Math.cos(angle-.44),y2-size*Math.sin(angle-.44)];
      const p2=[x2-size*Math.cos(angle+.44),y2-size*Math.sin(angle+.44)];
      g.append(createSvg('polygon',{points:x2+','+y2+' '+p1.join(',')+' '+p2.join(','),fill:a.color,stroke:a.color,'stroke-width':1}));
    }
  }
  if(a.appearance==='pop' && ['ring','spotlight','text'].includes(a.type)){
    const progress=clamp((t-a.start)/.32,0,1);
    const scale=(.65+.35*progress)*(1+Math.sin(progress*Math.PI)*.12);
    g.setAttribute('transform','translate('+x+' '+y+') scale('+scale+') translate('+(-x)+' '+(-y)+')');
  }
  if(force) {
    g.append(createSvg('circle',{cx:x,cy:y,r:7,fill:'#ffffff','fill-opacity':'.9',stroke:'#092019','stroke-width':2}));
  }
  return g;
}
function renderOverlay() {
  overlay.replaceChildren();
  const p=state.project;if(!p)return;
  for(const a of p.annotations||[]){
    const el=renderAnnotation(a,a.id===state.selected);
    if(el)overlay.append(el);
  }
  if(state.drawing) {
    const preview=renderAnnotation(state.drawing,true);
    if(preview) {preview.removeAttribute('data-id');preview.style.pointerEvents='none';overlay.append(preview);}
  }
  director?.paintZoom();
}
function ensureVisible(a) {
  const t=playhead();
  if(t<a.start-.01||t>a.end+.01) seekTo(clamp(a.start+.1,0,duration()),false);
}
function selectAnnotation(id) {
  state.selected=id;
  const a=state.project?.annotations.find(q=>q.id===id);
  if(a)ensureVisible(a);
  renderOverlay();renderMarkupList();renderProperties();
}
function pushUndo() {
  state.undo.push(copy(state.project.annotations));
  if(state.undo.length>60)state.undo.shift();
  state.redo=[];
}
function markEdited() {
  renderOverlay();renderMarkupList();renderProperties();renderMarkers();updateCounts();queueSave();
}
function newMarkup(type,x,y) {
  const t=playhead();
  return {id:uid(),type,x,y,x2:x,y2:y,points:[],color:state.color,weight:4,
    label:'',start:Math.max(0,t-.1),end:Math.min(duration(),t+4),fade:.15};
}
function annotate(event) {
  if(event.button!==0)return;
  event.preventDefault();
  if(!state.project)return;
  overlay.setPointerCapture?.(event.pointerId);
  const {x,y}=coords(event);
  if(state.tool==='select'){
    const element=event.target.closest?.('g[data-id]');
    const id=element?.getAttribute('data-id');
    if(id){
      selectAnnotation(id);const a=state.project.annotations.find(z=>z.id===id);
      if(a){pushUndo();state.moving={id,from:{x,y},original:copy(a)};}
    }else selectAnnotation(null);
    return;
  }
  pausePlayback();
  if(state.tool==='zoom'){director?.addZoom(x,y);setTool('select');return;}
  if(['ring','spotlight','text'].includes(state.tool)) {
    const a=newMarkup(state.tool,x,y);
    if(a.type==='text'){
      const label=prompt('Text label:','Player');
      if(label===null)return;
      a.label=label.trim().slice(0,120)||'Label';
    }
    pushUndo();state.project.annotations.push(a);selectAnnotation(a.id);markEdited();return;
  }
  state.drawing=newMarkup(state.tool,x,y);
  if(state.tool==='pen')state.drawing.points=[{x,y}];
  renderOverlay();
}
function movePointer(event) {
  if(state.moving){
    const pt=coords(event),m=state.moving;
    const a=state.project.annotations.find(z=>z.id===m.id);if(!a)return;
    const dx=pt.x-m.from.x,dy=pt.y-m.from.y,orig=m.original;
    a.x=clamp(orig.x+dx,0,1);a.y=clamp(orig.y+dy,0,1);
    a.x2=clamp((orig.x2??orig.x)+dx,0,1);a.y2=clamp((orig.y2??orig.y)+dy,0,1);
    a.points=(orig.points||[]).map(pt=>({x:clamp(pt.x+dx,0,1),y:clamp(pt.y+dy,0,1)}));
    renderOverlay();return;
  }
  if(!state.drawing)return;
  const pt=coords(event);
  if(state.drawing.type==='pen'){
    if(state.drawing.points.length<1500)state.drawing.points.push(pt);
  }else{state.drawing.x2=pt.x;state.drawing.y2=pt.y;}
  renderOverlay();
}
function releasePointer(event) {
  if(state.moving){state.moving=null;markEdited();return;}
  if(!state.drawing)return;
  const a=state.drawing;state.drawing=null;
  if(a.type==='pen' && a.points.length<2)a.points.push({x:clamp(a.x+.008,0,1),y:a.y});
  if(['rect','ellipse','arrow','line'].includes(a.type)){
    if(Math.abs(a.x2-a.x)<.007 && Math.abs(a.y2-a.y)<.007){
      a.x2=clamp(a.x+.10,0,1);a.y2=clamp(a.y+.08,0,1);
    }
  }
  pushUndo();state.project.annotations.push(a);selectAnnotation(a.id);markEdited();
}
function setTool(tool) {
  state.tool=tool;
  document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));
  overlay.classList.toggle('select-tool',tool==='select');
  $('canvas-hint').textContent=tool==='zoom'?'Click a pitch area to add a smooth zoom'
    :tool==='select'?'Click a graphic and drag to reposition it'
    :tool==='ring'?'Click beneath a player to place a fixed ring':'Click or drag on the video to draw';
}
function renderPalette() {
  const render=(id,callback,selected)=>{
    const parent=$(id);parent.replaceChildren();
    COLORS.forEach(color=>{
      const b=makeButton('','swatch'+(selected()===color?' active':''),()=>callback(color));
      b.style.setProperty('--swatch',color);b.setAttribute('aria-label','Colour '+color);b.title=color;parent.append(b);
    });
  };
  render('palette',c=>{state.color=c;renderPalette();},()=>state.color);
  render('property-palette',c=>{
    const a=currentAnnotation();if(!a)return;
    pushUndo();a.color=c;state.color=c;markEdited();renderPalette();
  },()=>currentAnnotation()?.color||state.color);
}
function currentAnnotation(){return state.project?.annotations.find(a=>a.id===state.selected)||null;}
function renderMarkupList(){
  const list=$('markup-list');list.replaceChildren();
  const anns=state.project?.annotations||[];
  if(!anns.length){list.append(makeEmpty('No drawings yet. Choose Player ring or Arrow to begin.'));return;}
  for(const a of anns.slice().reverse()){
    const row=makeButton('','item'+(state.selected===a.id?' active':''),()=>selectAnnotation(a.id));
    const icon=document.createElement('span');icon.className='item-icon';icon.textContent=ICONS[a.type]||'◉';
    const d=document.createElement('span');d.className='item-detail';
    const name=document.createElement('strong');name.textContent=a.type==='text'?(a.label||'Text label'):a.type==='ring'?'Player ring':a.type[0].toUpperCase()+a.type.slice(1);
    const desc=document.createElement('small');desc.textContent=formatTime(a.start)+' – '+formatTime(a.end);
    d.append(name,desc);row.append(icon,d);list.append(row);
  }
}
function makeEmpty(text){const d=document.createElement('div');d.className='empty-panel';d.textContent=text;return d;}
function renderProperties(){
  const a=currentAnnotation();
  show('properties',!!a);show('no-selection',!a);
  if(!a)return;
  $('prop-label').value=a.label||'';
  $('prop-weight').value=a.weight||4;$('weight-output').textContent=String(a.weight||4);
  $('prop-start').value=Number(a.start.toFixed(1));
  $('prop-end').value=Number(a.end.toFixed(1));
  $('prop-fade').value=a.fade||0;$('fade-output').textContent=String(a.fade||0);
  $('prop-appearance').value=a.appearance||'fade';
  renderPalette();
}
function updateProperty(field,raw) {
  const a=currentAnnotation();if(!a)return;
  let value=raw;
  if(field==='weight')value=clamp(Number(value),1,12);
  if(field==='fade')value=clamp(Number(value),0,1.5);
  if(field==='start')value=clamp(Number(value),0,a.end);
  if(field==='end')value=clamp(Number(value),a.start,duration());
  if(field==='label')value=String(value).slice(0,120);
  pushUndo();a[field]=value;renderOverlay();renderMarkupList();renderMarkers();queueSave();
  if(field==='weight')$('weight-output').textContent=String(value);
  if(field==='fade')$('fade-output').textContent=String(value);
}
function removeMarkup(){const a=currentAnnotation();if(!a)return;pushUndo();state.project.annotations=state.project.annotations.filter(x=>x.id!==a.id);state.selected=null;markEdited();}
function undoAction(){
  if(!state.undo.length)return;
  state.redo.push(copy(state.project.annotations));state.project.annotations=state.undo.pop();state.selected=null;markEdited();
}
function redoAction(){
  if(!state.redo.length)return;
  state.undo.push(copy(state.project.annotations));state.project.annotations=state.redo.pop();state.selected=null;markEdited();
}
function resetFreeze() {
  clearTimeout(state.freezeTimer);state.freezeTimer=null;state.freezeSeen.clear();state.freezeActive=false;show('freeze-label',false);
}
function pausePlayback(cancelEffect=true) {
  video.pause();state.demoPlaying=false;
  if(cancelEffect)resetFreeze();
  updatePlayButton();
}
function playPlayback() {
  if(state.freezeActive)return;
  if(state.fileReady){
    video.play().catch(()=>toast('This video cannot be played by the browser',true));
  }else{
    state.demoPlaying=true;state.tickAt=performance.now();
  }
  updatePlayButton();requestFrameLoop();
}
function togglePlayback(){if(isPlaying())pausePlayback();else playPlayback();}
function seekTo(t,reset=true) {
  const next=clamp(t,0,duration());
  if(reset)resetFreeze();
  if(state.fileReady){try{video.currentTime=next;}catch{}}
  else state.demoTime=next;
  updateTime();renderOverlay();
}
function updatePlayButton(){$('play').textContent=isPlaying()?'❚❚':'▶';}
function updateTime() {
  const t=playhead(),max=duration();
  $('current-time').textContent=formatTime(t);$('duration').textContent=formatTime(max);
  $('seek-end').textContent=formatTime(max);$('seek').max=max;
  $('seek').value=clamp(t,0,max);$('seek').style.setProperty('--progress',(clamp(t/max,0,1)*100)+'%');
}
function handlePlaybackTick() {
  if(state.exporting || !state.project || !isPlaying() || state.freezeActive)return;
  const t=playhead();
  if(state.previewEnd!==null && t>=state.previewEnd){
    state.previewEnd=null;pausePlayback();return;
  }
  const f=state.project.freezes.find(f=>!state.freezeSeen.has(f.id) && t>=f.at && t-f.at<.18);
  if(!f)return;
  state.freezeSeen.add(f.id);state.freezeActive=true;
  pausePlayback(false);show('freeze-label',true);
  $('freeze-left').textContent=f.hold+'s';
  state.freezeTimer=setTimeout(()=>{
    state.freezeActive=false;show('freeze-label',false);playPlayback();
  },f.hold*1000);
}
function requestFrameLoop() {
  if(state.frameId)return;
  const loop=(at)=>{
    state.frameId=0;
    if(state.demoPlaying && !state.freezeActive){
      const elapsed=Math.min(.15,(at-state.tickAt)/1000);
      state.tickAt=at;state.demoTime=clamp(state.demoTime+elapsed*Number($('speed').value||1),0,duration());
      if(state.demoTime>=duration()){pausePlayback();state.demoTime=duration();}
    }
    handlePlaybackTick();
    if(at-state.lastOverlayAt>32){renderOverlay();state.lastOverlayAt=at;}
    updateTime();updatePlayButton();
    if(isPlaying() || state.freezeActive)state.frameId=requestAnimationFrame(loop);
  };
  state.tickAt=performance.now();state.frameId=requestAnimationFrame(loop);
}
function addFreeze() {
  const t=playhead(),p=state.project;if(!p)return;
  if(p.freezes.some(f=>Math.abs(f.at-t)<.1)){toast('There is already a freeze at this moment');return;}
  p.freezes.push({id:uid(),at:t,hold:Number($('freeze-duration').value)});
  p.freezes.sort((a,b)=>a.at-b.at);resetFreeze();renderFreezeList();renderMarkers();queueSave();toast('Freeze frame added');
}
function renderFreezeList() {
  const list=$('freeze-list');list.replaceChildren();
  const freezes=state.project?.freezes||[];
  $('freeze-count').textContent=freezes.length+' freezes';
  if(!freezes.length){list.append(makeEmpty('No freeze frames yet.'));return;}
  for(const f of freezes){
    const row=makeButton('','item',()=>{seekTo(f.at);toast('Freeze at '+formatTime(f.at));});
    const icon=document.createElement('span');icon.className='item-icon';icon.textContent='❚❚';
    const text=document.createElement('span');text.className='item-detail';
    const name=document.createElement('strong');name.textContent=formatTime(f.at)+' · '+f.hold+'s hold';
    text.append(name);row.append(icon,text);
    const del=makeButton('×','item-x',(e)=>{e.stopPropagation();state.project.freezes=state.project.freezes.filter(x=>x.id!==f.id);resetFreeze();renderFreezeList();renderMarkers();queueSave();});del.title='Delete freeze';
    row.append(del);list.append(row);
  }
}
function saveClip(start,end,title) {
  const p=state.project;if(!p)return;
  start=clamp(Number(start),0,duration());end=clamp(Number(end),0,duration());
  if(end-start<.1){toast('Clip OUT must be later than IN',true);return;}
  p.clips.push({id:uid(),start,end,title:String(title||'Match clip').trim().slice(0,100)||'Match clip'});
  renderClipList();renderMarkers();queueSave();toast('Clip saved');
}
function quickClip() {
  const t=playhead();saveClip(Math.max(0,t-5),Math.min(duration(),t+5),'Moment at '+formatTime(t));
}
function renderClipList() {
  const list=$('clip-list');list.replaceChildren();
  const clips=state.project?.clips||[];$('clip-count').textContent=clips.length+' clips';director?.refreshClipOptions();
  if(!clips.length){list.append(makeEmpty('No clips yet. Use Save ±5s clip while watching.'));return;}
  for(const c of clips){
    const row=makeButton('','item',()=>{
      seekTo(c.start);state.previewEnd=c.end;playPlayback();toast('Previewing '+c.title);
    });
    const icon=document.createElement('span');icon.className='item-icon';icon.textContent='✂';
    const text=document.createElement('span');text.className='item-detail';
    const name=document.createElement('strong');name.textContent=c.title;
    const subtitle=document.createElement('small');subtitle.textContent=formatTime(c.start)+' – '+formatTime(c.end);
    text.append(name,subtitle);row.append(icon,text);
    const del=makeButton('×','item-x',(e)=>{e.stopPropagation();state.project.clips=state.project.clips.filter(x=>x.id!==c.id);renderClipList();renderMarkers();queueSave();});del.title='Remove clip';
    row.append(del);list.append(row);
  }
}
function renderMarkers() {
  const markers=$('markers');markers.replaceChildren();
  const p=state.project;if(!p)return;
  const append=(time,color)=>{
    const m=document.createElement('span');m.className='marker';m.style.left=(clamp(time/duration(),0,1)*100)+'%';m.style.background=color;
    markers.append(m);
  };
  for(const a of p.annotations)append(a.start,'#b7ff75');
  for(const f of p.freezes)append(f.at,'#ffbf7f');
  for(const c of p.clips)append(c.start,'#7cb9fb');
  for(const z of p.zooms||[])append(z.at,'#ca9cff');
}
function updateCounts(){
  const count=state.project?.annotations.length||0;
  $('count').textContent=count+' MARKUPS';$('side-count').textContent=count+' items';
}
function renderEverything(){
  renderPalette();renderOverlay();renderMarkupList();renderProperties();
  renderFreezeList();renderClipList();renderMarkers();updateCounts();updatePlayButton();director?.render();
}
function tab(which) {
  show('markups-pane',which==='markups');show('clips-pane',which==='clips');
  $('tab-markups').classList.toggle('active',which==='markups');
  $('tab-clips').classList.toggle('active',which==='clips');
}
function downloadBackup() {
  const p=state.project;if(!p)return;
  const payload={format:'touchline-browser-project',version:1,project:copy(p)};
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download='touchline-'+(p.title.toLowerCase().replace(/[^a-z0-9]+/g,'-')||'analysis')+'.json';a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  toast('Project backup downloaded (video file not included)');
}
async function importBackup(file) {
  try {
    if(file.size>4*1024*1024)throw Error('Backup is too large');
    const data=JSON.parse(await file.text());
    if(data?.format!=='touchline-browser-project'||data?.version!==1||!data.project)throw Error('Not a Touchline browser backup');
    const original=data.project;
    if(!Array.isArray(original.annotations)||!Array.isArray(original.freezes)||!Array.isArray(original.clips))throw Error('Invalid backup');
    if(original.annotations.length>2000||original.freezes.length>500||original.clips.length>1000)throw Error('Backup exceeds editor limits');
    const p=projectFactory();
    p.title=String(original.title||'Restored analysis').slice(0,100);
    p.duration=clamp(Number(original.duration),1,86400);
    p.mediaKind='demo';p.mediaName='';p.videoUrl=null;
    if(typeof original.sourceLink==='string'){
      try{const u=new URL(original.sourceLink);if(u.protocol==='https:' && (u.hostname==='veo.co'||u.hostname.endsWith('.veo.co')))p.sourceLink=u.toString();}catch{}
    }
    const nums=(a)=>[a.x,a.y,a.x2??a.x,a.y2??a.y,a.start,a.end,a.weight].every(Number.isFinite);
    p.annotations=original.annotations.filter(a=>a&&ICONS[a.type]&&nums(a)).map(a=>({
      id:uid(),type:a.type,x:clamp(a.x,0,1),y:clamp(a.y,0,1),
      x2:clamp(a.x2??a.x,0,1),y2:clamp(a.y2??a.y,0,1),
      points:(Array.isArray(a.points)?a.points:[]).filter(q=>q&&Number.isFinite(q.x)&&Number.isFinite(q.y)).slice(0,1500).map(q=>({x:clamp(q.x,0,1),y:clamp(q.y,0,1)})),
      color:COLORS.includes(a.color)?a.color:COLORS[0],weight:clamp(a.weight,1,12),
      label:String(a.label||'').slice(0,120),start:clamp(a.start,0,p.duration),end:clamp(a.end,0,p.duration),fade:clamp(a.fade,0,1.5),appearance:a.appearance==='pop'?'pop':'fade'
    })).filter(a=>a.end>=a.start);
    p.freezes=original.freezes.filter(f=>f&&Number.isFinite(f.at)&&Number.isFinite(f.hold)).map(f=>({id:uid(),at:clamp(f.at,0,p.duration),hold:clamp(f.hold,.5,20)}));
    p.zooms=(Array.isArray(original.zooms)?original.zooms:[]).slice(0,500)
      .filter(z=>z&&[z.x,z.y,z.at,z.hold,z.scale].every(Number.isFinite))
      .map(z=>({id:uid(),x:clamp(z.x,0,1),y:clamp(z.y,0,1),at:clamp(z.at,0,p.duration),hold:clamp(z.hold,.5,20),scale:clamp(z.scale,1,3)}));
    p.clips=original.clips.filter(c=>c&&Number.isFinite(c.start)&&Number.isFinite(c.end)).map(c=>({id:uid(),start:clamp(c.start,0,p.duration),end:clamp(c.end,0,p.duration),title:String(c.title||'Clip').slice(0,100)})).filter(c=>c.end>c.start);
    state.projects.unshift(p);await persist(copy(p));await selectProject(p.id);toast('Backup restored. Reattach the video file to continue.');
  }catch(err){toast('Cannot restore backup: '+err.message,true);}
}
function bindUI() {
  $('new-project').addEventListener('click',()=>{void createProject();});
  $('title').addEventListener('input',e=>{state.project.title=e.target.value||'Untitled analysis';queueSave();});
  $('title').addEventListener('change',()=>renderProjects());
  $('pick-file').addEventListener('click',()=>{void pickVideo();});
  $('video-file').addEventListener('change',async e=>{
    if(e.target.files?.[0]){state.fileHandle=null;await loadPickedFile(e.target.files[0]);renderProjects();}
    e.target.value='';
  });
  $('reconnect').addEventListener('click',()=>{void reconnectVideo();});
  $('source-link').addEventListener('click',()=>director?.openVeoDialog());
  $('open-source').addEventListener('click',()=>{
    const url=state.project?.sourceLink;if(url)window.open(url,'_blank','noopener,noreferrer');
  });
  $('export-project').addEventListener('click',downloadBackup);
  $('import-project').addEventListener('click',()=>$('project-json').click());
  $('project-json').addEventListener('change',e=>{if(e.target.files?.[0])void importBackup(e.target.files[0]);e.target.value='';});
  document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>setTool(b.dataset.tool)));
  overlay.addEventListener('pointerdown',annotate);
  overlay.addEventListener('pointermove',movePointer);
  overlay.addEventListener('pointerup',releasePointer);
  overlay.addEventListener('pointercancel',()=>{state.drawing=null;state.moving=null;renderOverlay();});
  $('play').addEventListener('click',togglePlayback);
  $('skip-back').addEventListener('click',()=>seekTo(playhead()-5));
  $('skip-forward').addEventListener('click',()=>seekTo(playhead()+5));
  $('frame-back').addEventListener('click',()=>{pausePlayback();seekTo(playhead()-1/25);});
  $('frame-forward').addEventListener('click',()=>{pausePlayback();seekTo(playhead()+1/25);});
  $('seek').addEventListener('input',e=>seekTo(Number(e.target.value)));
  $('speed').addEventListener('change',e=>{video.playbackRate=Number(e.target.value);});
  video.addEventListener('loadedmetadata',()=>{
    if(!state.project)return;
    if(Number.isFinite(video.duration) && video.duration>0)state.project.duration=video.duration;
    if(video.videoWidth>0 && video.videoHeight>0){
      $('stage').style.aspectRatio=video.videoWidth+' / '+video.videoHeight;
      overlay.setAttribute('viewBox','0 0 1000 '+(1000*video.videoHeight/video.videoWidth));
    }
    $('clip-out').value=Math.min(10,duration()).toFixed(1);
    queueSave();updateTime();renderMarkers();
  });
  video.addEventListener('timeupdate',()=>{handlePlaybackTick();updateTime();renderOverlay();});
  video.addEventListener('play',()=>{updatePlayButton();requestFrameLoop();});
  video.addEventListener('pause',updatePlayButton);
  video.addEventListener('ended',()=>{state.previewEnd=null;resetFreeze();updatePlayButton();});
  video.addEventListener('error',()=>{if(state.project?.mediaKind==='url')toast('The video host may block direct playback. Try an MP4 file instead.',true);});
  $('add-freeze').addEventListener('click',addFreeze);
  $('quick-clip').addEventListener('click',quickClip);
  $('undo').addEventListener('click',undoAction);
  $('redo').addEventListener('click',redoAction);
  $('tab-markups').addEventListener('click',()=>tab('markups'));
  $('tab-clips').addEventListener('click',()=>tab('clips'));
  $('prop-label').addEventListener('change',e=>updateProperty('label',e.target.value));
  $('prop-weight').addEventListener('change',e=>updateProperty('weight',Number(e.target.value)));
  $('prop-start').addEventListener('change',e=>updateProperty('start',Number(e.target.value)));
  $('prop-end').addEventListener('change',e=>updateProperty('end',Number(e.target.value)));
  $('prop-fade').addEventListener('change',e=>updateProperty('fade',Number(e.target.value)));
  $('delete-annotation').addEventListener('click',removeMarkup);
  $('mark-in').addEventListener('click',()=>$('clip-in').value=playhead().toFixed(1));
  $('mark-out').addEventListener('click',()=>$('clip-out').value=playhead().toFixed(1));
  $('save-clip').addEventListener('click',()=>saveClip($('clip-in').value,$('clip-out').value,$('clip-title').value));
  window.addEventListener('keydown',e=>{
    const editing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&!editing){
      e.preventDefault();if(e.shiftKey)redoAction();else undoAction();return;
    }
    if(editing||e.ctrlKey||e.metaKey||e.altKey)return;
    const keys={v:'select','1':'ring',a:'arrow',l:'line',b:'rect',c:'ellipse',p:'pen',t:'text',s:'spotlight',z:'zoom'};
    if(e.key===' '){e.preventDefault();togglePlayback();}
    else if(keys[e.key.toLowerCase()])setTool(keys[e.key.toLowerCase()]);
    else if(e.key==='Delete'||e.key==='Backspace')removeMarkup();
    else if(e.key==='ArrowLeft')seekTo(playhead()-5);
    else if(e.key==='ArrowRight')seekTo(playhead()+5);
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)void flushSave();});
  window.addEventListener('pagehide',()=>{if(state.project)void flushSave();});
}
async function bootstrap() {
  try {state.db=await openDB();}
  catch(err){console.warn('IndexedDB unavailable, using local storage',err);toast('Limited storage mode. Download backups regularly.',true);}
  state.projects=(await loadAll()).filter(p=>p&&p.id&&Array.isArray(p.annotations)&&Array.isArray(p.freezes)&&Array.isArray(p.clips));
  bindUI();
  director=installDirector({
    state,video,getTime:playhead,getDuration:duration,pause:pausePlayback,seek:seekTo,
    save:queueSave,renderOverlay,renderMarkers,renderSource,renderProjects,pickVideo,
    setVideoSource,pushUndo,notify:toast
  });
  director.bind();
  setTool('select');tab('markups');
  if(!state.projects.length){
    const p=projectFactory();state.projects.push(p);await persist(copy(p));
  }
  await selectProject(state.projects[0].id);
}
if(typeof document!=='undefined')void bootstrap().catch(err=>{console.error(err);toast('Editor could not start: '+err.message,true);});
