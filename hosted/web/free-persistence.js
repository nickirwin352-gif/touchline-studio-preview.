/**
 * Local browser snapshots for the optional FREE hosted Touchline server.
 * Only project metadata is retained here, never footage, exports or credentials.
 */
(()=>{
  const originalFetch=window.fetch.bind(window);
  const DB_NAME='touchline-free-projects-v1', STORE='projects';
  let dbPromise=null,restorePromise=null;
  function db(){
    if(!dbPromise)dbPromise=new Promise((resolve,reject)=>{
      const r=indexedDB.open(DB_NAME,1);
      r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains(STORE))r.result.createObjectStore(STORE,{keyPath:'id'});};
      r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
    });
    return dbPromise;
  }
  async function transaction(method,mode,...args){
    const database=await db();
    return new Promise((resolve,reject)=>{
      const tx=database.transaction(STORE,mode);
      const request=tx.objectStore(STORE)[method](...args);
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
      tx.onerror=()=>reject(tx.error);
    });
  }
  const all=()=>transaction('getAll','readonly');
  const put=p=>transaction('put','readwrite',p);
  const del=id=>transaction('delete','readwrite',id);
  const status=originalFetch('/api/free/status',{cache:'no-store'})
    .then(async r=>r.ok?(await r.json()).enabled===true:false).catch(()=>false);
  async function restoreWhenCold(){
    if(restorePromise)return restorePromise;
    restorePromise=(async()=>{
      const snapshots=await all();
      if(!snapshots.length)return;
      const r=await originalFetch('/api/projects',{cache:'no-store'});
      if(!r.ok)throw Error('Cannot check project storage');
      const current=await r.json();
      if(!Array.isArray(current)||current.length)return;
      const restore=await originalFetch('/api/free/restore',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({projects:snapshots})
      });
      if(!restore.ok) {
        const second=await originalFetch('/api/projects',{cache:'no-store'});
        if(!second.ok)throw Error('Unable to restore browser project backups');
        const list=await second.json();
        if(!Array.isArray(list)||list.length===0)throw Error('Project restore was unsuccessful; backup still stored safely in your browser');
      }
    })();
    return restorePromise;
  }
  async function persistResponse(path,method,response){
    if(!response.ok)return;
    let data;
    try{data=await response.clone().json();}catch{return;}
    if(path==='/api/projects' && method==='GET' && Array.isArray(data)) {
      for(const project of data)if(project?.id)await put(project);
    }else if(path==='/api/projects'&&method==='POST'&&data?.id){
      await put(data);
    }else if(/^\/api\/projects\/[0-9a-f-]+(?:\/(?:veo-stream|video-url|video))?$/.test(path)){
      const id=path.split('/')[3];
      if(method==='DELETE'&&path===('/api/projects/'+id))await del(id);
      else if(data?.id===id)await put(data);
    }
  }
  window.fetch=async (resource,options)=>{
    const url=typeof resource==='string'?resource:resource instanceof URL?resource.toString():resource?.url;
    const path=typeof url==='string'&&url.startsWith('/api/')?url.split('?')[0]:null;
    if(!path||!path.startsWith('/api/projects'))return originalFetch(resource,options);
    if(!await status)return originalFetch(resource,options);
    const method=(options?.method||'GET').toUpperCase();
    if(method==='GET'&&path==='/api/projects')await restoreWhenCold();
    const response=await originalFetch(resource,options);
    try{await persistResponse(path,method,response);}catch(err){console.warn('Browser backup error:',err);}
    return response;
  };
  status.then(enabled=>{
    if(!enabled)return;
    const banner=document.createElement('div');
    banner.id='free-hosting-note';banner.setAttribute('role','status');
    banner.textContent='FREE PERSONAL MODE · Drawings, clips and Veo links are backed up in this browser. After inactivity, the free server may take a minute to wake up. Uploaded video files and generated exports are temporary. Clearing browser data also deletes your backup.';
    banner.style.cssText='background:#213328;color:#d8f3d6;border-bottom:1px solid #446d50;padding:10px 16px;font:12px/1.5 system-ui;position:relative;z-index:5;';
    const show=()=>document.body.prepend(banner);
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});
    else show();
  });
})();
