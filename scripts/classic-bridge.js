/**
 * Local companion for the classic Touchline Studio editor on GitHub Pages.
 * The SAME classic UI runs on the connected full Node service for real Veo streaming.
 * Pages alone never pretends to resolve Veo or server-render MP4.
 */
const DB_NAME='touchline-classic-v1', DB_VERSION=1;
const mediaUrls=new Map();
let dbPromise=null;
const now=()=>new Date().toISOString();
const uuid=()=>crypto.randomUUID();
const error=(message,status=400)=>new Response(JSON.stringify({error:message}),{status,headers:{'Content-Type':'application/json'}});
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
function db(){
  if(!dbPromise) dbPromise=new Promise((resolve,reject)=>{
    const q=indexedDB.open(DB_NAME,DB_VERSION);
    q.onupgradeneeded=()=>{
      if(!q.result.objectStoreNames.contains('projects'))q.result.createObjectStore('projects',{keyPath:'id'});
      if(!q.result.objectStoreNames.contains('handles'))q.result.createObjectStore('handles');
    };
    q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);
  });
  return dbPromise;
}
async function action(store,mode,method,...args){
  const d=await db();
  return new Promise((resolve,reject)=>{
    const tx=d.transaction(store,mode),request=tx.objectStore(store)[method](...args);
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
    tx.onerror=()=>reject(tx.error);
  });
}
const list=async()=>await action('projects','readonly','getAll');
const get=async(id)=>await action('projects','readonly','get',id);
const put=async(p)=>{await action('projects','readwrite','put',p);return p;};
const remove=async(id)=>{await action('projects','readwrite','delete',id);};
function freshProject(title='Untitled analysis'){
  const date=now();
  return {schemaVersion:2,id:uuid(),title,duration:null,video:null,videoUrl:null,remoteVideo:null,sourceLink:null,
    annotations:[],freezes:[],zooms:[],clips:[],playlists:[],autoFreezeAnnotations:true,createdAt:date,updatedAt:date};
}
async function localRequest(url,init={}){
  const path=new URL(url,location.origin).pathname;
  const method=(init?.method||'GET').toUpperCase();
  const jsonBody=()=>{
    try{return JSON.parse(init.body||'{}');}catch{return {};}
  };
  if(path==='/api/health')return json({status:'ok',mode:'browser-preview',veoStreaming:false});
  if(path==='/api/projects'){
    if(method==='GET')return json((await list()).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
    if(method==='POST') {const p=freshProject(String(jsonBody().title||'Untitled analysis').slice(0,100));await put(p);return json(p,201);}
  }
  const m=/^\/api\/projects\/([a-zA-Z0-9_-]+)(\/.*)?$/.exec(path);
  if(m){
    const p=await get(m[1]);if(!p)return error('Project not found',404);
    const suffix=m[2]||'';
    if(!suffix){
      if(method==='GET')return json(p);
      if(method==='PATCH'){
        const body=jsonBody();
        const allowed=['title','duration','annotations','freezes','zooms','clips','playlists','autoFreezeAnnotations','sourceLink'];
        for(const key of allowed)if(Object.hasOwn(body,key))p[key]=body[key];
        p.updatedAt=now();await put(p);return json(p);
      }
      if(method==='DELETE'){
        await remove(p.id);const src=mediaUrls.get(p.id);if(src)URL.revokeObjectURL(src);mediaUrls.delete(p.id);
        try{await action('handles','readwrite','delete',p.id);}catch{}
        return json({deleted:true});
      }
    }
    if(suffix==='/video-url'&&method==='PUT'){
      const body=jsonBody(),newUrl=body.url;
      if(newUrl!==null && (typeof newUrl!=='string'||!/^https:\/\//.test(newUrl)))return error('Use a valid HTTPS video URL');
      Object.assign(p,{video:null,remoteVideo:null,videoUrl:newUrl,annotations:[],freezes:[],zooms:[],clips:[],playlists:[],duration:null,updatedAt:now()});
      await put(p);return json(p);
    }
    if(suffix==='/veo-import'&&method==='GET')return json({status:'idle'});
    if(suffix==='/veo-stream' || suffix==='/veo-import')
      return error('Instant Veo playback requires the connected streaming service. Use the “Connect Veo streaming” control above the editor; the original video service is included in this project.',503);
    if(suffix==='/exports')
      return error('MP4 export needs the connected video service. The original FFmpeg exporter is preserved in the hosted editor.',503);
  }
  if(/^\/api\/exports\//.test(path))return error('No hosted video export service is connected.',503);
  return error('This action needs the connected video service.',503);
}
const savedFetch=window.fetch.bind(window);
window.fetch=(resource,init)=>{
  const url=typeof resource==='string'?resource:resource instanceof URL?resource.toString():resource?.url;
  if(typeof url==='string' && url.startsWith('/api/'))return localRequest(url,init);
  return savedFetch(resource,init);
};
async function attachFile(projectId,file,{preserve=false,handle=null}={}){
  const p=await get(projectId);
  if(!p)throw Error('Project not found.');
  if(!file || file.size<1|| !/\.(mp4|mov|m4v|webm)$/i.test(file.name))throw Error('Select MP4, MOV, M4V or WebM footage.');
  const old=mediaUrls.get(projectId);if(old)URL.revokeObjectURL(old);
  const localUrl=URL.createObjectURL(file);mediaUrls.set(projectId,localUrl);
  if(!preserve){
    p.video={id:uuid(),originalName:file.name,storageName:'browser-only',mimeType:file.type||'video/mp4',size:file.size,createdAt:now()};
    p.videoUrl=null;p.remoteVideo=null;p.duration=null;
    p.annotations=[];p.freezes=[];p.zooms=[];p.clips=[];p.playlists=[];
  }else if(p.video){
    p.video.originalName=file.name;p.video.size=file.size;p.video.mimeType=file.type||'video/mp4';
  }
  p.updatedAt=now();await put(p);
  if(handle){try{await action('handles','readwrite','put',handle,projectId);}catch(e){console.warn('Could not persist file handle',e);}}
  return p;
}
async function prepareVideo(p){
  if(!p?.video || mediaUrls.has(p.id))return;
  try{
    const handle=await action('handles','readonly','get',p.id);
    if(handle && await handle.queryPermission({mode:'read'})==='granted'){
      await attachFile(p.id,await handle.getFile(),{preserve:true,handle});
    }
  }catch(e){console.warn('Reconnecting video needs user permission',e);}
}
function displayReconnected(id){
  const src=mediaUrls.get(id),video=document.getElementById('match-video');
  if(!src||!video)return;
  video.src=src;video.load();
  document.getElementById('video-frame')?.classList.add('has-video');
  const description=document.getElementById('video-description');
  if(description)description.textContent='Local footage reconnected · Saved annotations kept';
  const reconnect=document.getElementById('reconnect-match');
  if(reconnect)reconnect.textContent='✓ Footage reconnected';
}
async function pickReconnect(){
  const id=window.TouchlineClassic.currentProject;
  if(!id)return;
  if(typeof showOpenFilePicker==='function'){
    try{
      const [h]=await showOpenFilePicker({multiple:false,types:[{description:'Video',accept:{'video/mp4':['.mp4','.m4v'],'video/webm':['.webm'],'video/quicktime':['.mov']}}]});
      const file=await h.getFile();await attachFile(id,file,{preserve:true,handle:h});
      displayReconnected(id);return;
    }catch(e){if(e?.name==='AbortError')return;}
  }
  const picker=document.createElement('input');picker.type='file';picker.accept='.mp4,.mov,.m4v,.webm';
  picker.onchange=async()=>{
    const file=picker.files?.[0];if(!file)return;
    try{await attachFile(id,file,{preserve:true});displayReconnected(id);}
    catch(e){alert(e.message);}
  };picker.click();
}
function createControls(){
  const actions=document.querySelector('.top-actions');
  if(!actions)return;
  const host=document.createElement('button');host.id='hosted-veo-control';host.className='btn btn-outline';
  host.textContent='◎ Connect Veo streaming';host.title='Open the full editor with real on-demand Veo streaming';
  host.addEventListener('click',()=>{
    const last=localStorage.getItem('touchline-classic-service')||'';
    const raw=prompt('Paste the HTTPS address of your Touchline Studio video service. This opens the original full editor, including instant Veo streaming and MP4 export.',last);
    if(raw===null)return;
    try{
      const url=new URL(raw.trim());
      if(url.protocol!=='https:' ||url.username||url.password||url.pathname!=='/')throw Error();
      localStorage.setItem('touchline-classic-service',url.origin+'/');
      location.assign(url.origin+'/');
    }catch{alert('Please enter the HTTPS root address for your Touchline Studio service (for example https://your-service.example/).');}
  });
  const reconnect=document.createElement('button');reconnect.id='reconnect-match';reconnect.className='btn btn-outline';
  reconnect.textContent='↻ Reconnect footage';reconnect.title='Reopen a local match file while preserving your drawings';
  reconnect.addEventListener('click',()=>{void pickReconnect();});
  actions.prepend(reconnect,host);
  const label=document.querySelector('.workspace-label .muted-pill');if(label)label.textContent='BROWSER';
  const instructions=document.querySelector('.sidebar-bottom small');
  if(instructions)instructions.textContent='Saved in this browser · back up important work';
  const help=document.createElement('p');help.id='classic-browser-note';
  help.textContent='Classic editor restored. Local footage plays on this page. For Veo “Stream instantly” and server MP4 exporting, connect the companion video service once; GitHub Pages cannot run a video proxy.';
  const heading=document.querySelector('.project-heading');
  if(heading)heading.insertAdjacentElement('afterend',help);
}
function bootControls(){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',createControls,{once:true});else createControls();}
bootControls();
window.TouchlineClassic={attachFile,prepareVideo,videoSrc:p=>mediaUrls.get(p.id)||null,
  currentProject:null,reconnect:pickReconnect,localRequest};
