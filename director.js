/**
 * Veo workflow, smooth tactical zooms and browser-native annotated export.
 * Uses no external services and never uploads source footage.
 */
import { recordAnnotatedClip, validExportRange, zoomStateAt } from './recorder.js';

export function installDirector({
  state,video,getTime,getDuration,pause,seek,save,renderOverlay,renderMarkers,
  renderSource,renderProjects,pickVideo,setVideoSource,pushUndo,notify
}) {
  const $ = id => document.getElementById(id);
  const format = sec => {
    const s=Math.max(0,Math.floor(sec));
    return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  };
  const button = (label,css,handler) => {
    const b=document.createElement('button');b.type='button';b.textContent=label;
    b.className=css;b.addEventListener('click',handler);return b;
  };
  function openVeoDialog() {
    $('veo-link-input').value=state.project?.sourceLink||state.project?.videoUrl||'';
    const dialog=$('veo-dialog');
    if(!dialog.open)dialog.showModal();
    $('veo-link-input').focus();
  }
  function sourceUrl(input) {
    let url;
    try{url=new URL(String(input).trim());}catch{return null;}
    if(url.protocol!=='https:'||url.username||url.password)return null;
    return url;
  }
  function saveVeo() {
    const p=state.project;if(!p)return;
    const url=sourceUrl($('veo-link-input').value);
    if(!url){notify('Paste a valid HTTPS Veo match link or direct video URL.',true);return;}
    const isVeo=url.hostname==='veo.co'||url.hostname.endsWith('.veo.co');
    const isMedia=/\.(mp4|webm|mov|m4v)$/i.test(url.pathname);
    if(isVeo) {
      p.sourceLink=url.toString();renderSource();
      notify('Veo recording linked to this analysis. Attach your video to edit it.');
    }else if(isMedia) {
      p.mediaKind='url';p.mediaName='Online video file';p.videoUrl=url.toString();
      setVideoSource(p.videoUrl);
      $('media-note').textContent='Direct video link — host must allow browser playback';
      $('media-state').textContent='ONLINE VIDEO';
      notify('Direct video URL added');
    }else{
      notify('Use a Veo match link or a direct .mp4 / .webm URL.',true);return;
    }
    save();renderProjects();$('veo-dialog').close();
  }
  function openVeo() {
    const url=sourceUrl($('veo-link-input').value)||sourceUrl(state.project?.sourceLink);
    if(!url || !(url.hostname==='veo.co'||url.hostname.endsWith('.veo.co'))){
      notify('Paste a Veo recording link first.',true);return;
    }
    window.open(url.toString(),'_blank','noopener,noreferrer');
  }
  function addZoom(x,y) {
    const p=state.project;if(!p)return;
    const at=getTime(),hold=Math.min(Number($('zoom-hold').value),getDuration()-at);
    if(hold<.5){notify('Move the playhead earlier to add a zoom.',true);return;}
    p.zooms ||= [];
    p.zooms.push({
      id:crypto.randomUUID(),x,y,at,hold,scale:Number($('zoom-scale').value)
    });
    p.zooms.sort((a,b)=>a.at-b.at);
    renderZooms();renderMarkers();save();seek(Math.min(at+.42,getDuration()));
    notify('Smooth zoom added');
  }
  function paintZoom() {
    const z=zoomStateAt(state.project?.zooms||[],getTime());
    const el=$('visual-layer');if(!el)return;
    el.style.transformOrigin=(z.x*100).toFixed(3)+'% '+(z.y*100).toFixed(3)+'%';
    el.style.transform=z.scale===1?'none':'scale('+z.scale.toFixed(4)+')';
  }
  function renderZooms() {
    const list=$('zoom-list');list.replaceChildren();
    const zooms=state.project?.zooms||[];
    $('zoom-count').textContent=zooms.length+' zooms';
    if(!zooms.length){
      const empty=document.createElement('div');empty.className='empty-panel';
      empty.textContent='No zooms yet. Select Zoom, then click where the camera should focus.';
      list.append(empty);return;
    }
    for(const z of zooms){
      const row=button('','item',()=>seek(Math.min(z.at+.4,getDuration())));
      const icon=document.createElement('span');icon.className='item-icon';icon.textContent='⌕';
      const text=document.createElement('span');text.className='item-detail';
      const title=document.createElement('strong');title.textContent=format(z.at)+' · '+z.scale+'× zoom';
      const detail=document.createElement('small');detail.textContent=z.hold+'s · smooth transition';
      text.append(title,detail);row.append(icon,text);
      const del=button('×','item-x',event=>{
        event.stopPropagation();
        state.project.zooms=state.project.zooms.filter(a=>a.id!==z.id);
        renderZooms();paintZoom();renderMarkers();save();
      });del.title='Delete camera zoom';row.append(del);list.append(row);
    }
  }
  function refreshClipOptions() {
    const select=$('render-range');if(!select)return;
    const old=select.value;select.replaceChildren();
    const first=document.createElement('option');first.value='current';first.textContent='IN / OUT fields above';select.append(first);
    const clips=state.project?.clips||[];
    for(const clip of clips) {
      const option=document.createElement('option');option.value=clip.id;
      option.textContent=clip.title+' ('+format(clip.start)+'–'+format(clip.end)+')';
      select.append(option);
    }
    select.value=clips.some(c=>c.id===old)?old:'current';
  }
  function exportRange() {
    const saved=state.project?.clips.find(c=>c.id===$('render-range').value);
    return saved ? {start:saved.start,end:saved.end,title:saved.title} : {
      start:Number($('clip-in').value),end:Number($('clip-out').value),
      title:$('clip-title').value||'Match analysis'
    };
  }
  async function exportClip() {
    if(state.exporting)return;
    if(!state.project||!state.fileReady||state.project.mediaKind==='url') {
      notify('Choose a local MP4 or WebM video file before exporting.',true);return;
    }
    if(!Number.isFinite(video.duration)||video.readyState<2){
      notify('The video is still loading. Try again when it is ready.',true);return;
    }
    const {start,end,title}=exportRange();
    if(!validExportRange(start,end,video.duration)){
      notify('Choose a clip between 0.25 seconds and 3 minutes.',true);return;
    }
    pause();state.previewEnd=null;state.exporting=true;
    state.exportAbort=new AbortController();
    $('start-render').disabled=true;$('cancel-render').hidden=false;
    $('render-status').textContent='Preparing your video export…';
    try {
      const output=await recordAnnotatedClip({
        video,
        annotations:structuredClone(state.project.annotations||[]),
        zooms:structuredClone(state.project.zooms||[]),
        freezes:structuredClone(state.project.freezes||[]),
        start,end,width:Number($('render-size').value),
        withAudio:$('render-audio').checked,signal:state.exportAbort.signal,
        onProgress:percent=>{
          $('render-status').textContent='Rendering '+percent+'% · Video exports in real time';
        }
      });
      const url=URL.createObjectURL(output.blob),a=document.createElement('a');
      a.href=url;
      const cleanTitle=String(title).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,65)||'clip';
      a.download='touchline-'+cleanTitle+'.'+output.extension;
      document.body.append(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      $('render-status').textContent='✓ Download ready · '+output.extension.toUpperCase()+
        ' · '+(output.blob.size/(1024*1024)).toFixed(1)+' MB'+
        (output.audioIncluded?' · Audio included':' · No audio');
      notify('Annotated video downloaded');
    } catch(err) {
      const cancelled=err?.name==='AbortError';
      $('render-status').textContent=cancelled?'Export cancelled':'Export failed: '+err.message;
      if(!cancelled)notify('Video export failed: '+err.message,true);
    } finally {
      state.exporting=false;state.exportAbort=null;
      $('start-render').disabled=false;$('cancel-render').hidden=true;
      seek(start);renderOverlay();
    }
  }
  function bind() {
    $('attach-veo-file').addEventListener('click',()=>{void pickVideo();});
    $('veo-close').addEventListener('click',()=>$('veo-dialog').close());
    $('veo-file').addEventListener('click',()=>{$('veo-dialog').close();void pickVideo();});
    $('save-veo').addEventListener('click',saveVeo);
    $('veo-open').addEventListener('click',openVeo);
    $('prop-appearance').addEventListener('change',event=>{
      const a=state.project?.annotations.find(q=>q.id===state.selected);
      if(!a)return;
      pushUndo();a.appearance=event.target.value==='pop'?'pop':'fade';
      renderOverlay();save();
    });
    $('start-render').addEventListener('click',()=>{void exportClip();});
    $('cancel-render').addEventListener('click',()=>state.exportAbort?.abort());
  }
  function render() {renderZooms();refreshClipOptions();paintZoom();}
  return {bind,render,addZoom,paintZoom,openVeoDialog,refreshClipOptions};
}
