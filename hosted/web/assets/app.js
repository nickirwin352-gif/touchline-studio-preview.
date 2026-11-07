import { TacticalEditor } from './editor.js';
import { formatClipClock, parseClipClock, CLIP_PRESETS, quickClipRange } from './clip-ui.js';
import { poseAt, makeAnnotation, COLORS, History, TOOL_NAMES, clamp, timecode, newId } from './model.js';
const el = (id) => {
    const value = document.getElementById(id);
    if (!value)
        throw new Error(`Missing element: ${id}`);
    return value;
};
const text = (id, value) => { el(id).textContent = value; };
const video = el('match-video');
const frame = el('video-frame');
const visual = el('video-visual');
const overlay = document.getElementById('drawing-overlay');
const titleInput = el('project-title');
const fileInput = el('file-input');
const seek = el('seek');
const uploadScreen = el('upload-progress');
const annotationList = el('annotation-list');
const propertiesForm = el('properties-form');
const propertiesEmpty = el('properties-empty');
const propText = el('prop-text');
const propWidth = el('prop-width');
const propStart = el('prop-start');
const propEnd = el('prop-end');
let projects = [];
let project = null;
let currentTime = 0;
let previewClip = null;
let editingClipId = null;
let selectedPlaylistId = null;
let activePlayback = null;
let exportJobId = null;
let freezeTimer = null;
const freezeSeen = new Set();
let inFreeze = false;
let lastPlaybackTime = 0;
function cancelFreeze() {
    if (freezeTimer)
        clearTimeout(freezeTimer);
    freezeTimer = null;
    inFreeze = false;
    el('freeze-indicator').hidden = true;
}
let isUploading = false;
let monitoringImportId = null;
let saveTimer = null;
let saveQueue = Promise.resolve();
let dirty = false;
let toastTimer = null;
const history = new History();
const hasFootage = (p) => !!(p?.video || p?.videoUrl || p?.remoteVideo);
async function api(path, init) {
    const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
    const data = await res.json();
    if (!res.ok)
        throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
}
function notify(message, error = false) {
    const toast = el('toast');
    toast.textContent = message;
    toast.classList.toggle('error', error);
    toast.classList.add('visible');
    if (toastTimer)
        clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('visible'), 3700);
}
function saveLabel(value) { text('save-status', `● ${value}`); }
function markDirty() {
    dirty = true;
    saveLabel('Unsaved changes');
    if (saveTimer)
        clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveNow(); }, 700);
}
async function saveNow() {
    if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
    }
    if (!project || !dirty) {
        await saveQueue;
        return;
    }
    const id = project.id;
    const patch = { title: titleInput.value.trim() || 'Untitled analysis', duration: project.duration,
        annotations: structuredClone(history.current), autoFreezeAnnotations: project.autoFreezeAnnotations ?? true, freezes: structuredClone(project.freezes || []), zooms: structuredClone(project.zooms || []), clips: structuredClone(project.clips || []), playlists: structuredClone(project.playlists || []) };
    dirty = false;
    saveLabel('Saving…');
    const task = async () => {
        try {
            const saved = await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
            const index = projects.findIndex((p) => p.id === id);
            if (index !== -1)
                projects[index] = saved;
            if (project?.id === id) {
                project.updatedAt = saved.updatedAt;
                if (!dirty)
                    saveLabel('Saved locally');
            }
            renderProjects();
        }
        catch (error) {
            if (project?.id === id) {
                dirty = true;
                saveLabel('Save failed');
            }
            notify(`Could not save: ${error.message}`, true);
        }
    };
    saveQueue = saveQueue.then(task, task);
    await saveQueue;
}
function renderProjects() {
    const list = el('project-list');
    list.replaceChildren();
    text('project-count', String(projects.length));
    for (const p of projects.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
        const wrapper = document.createElement('div');
        wrapper.className = 'project-row';
        wrapper.style.display = 'flex';
        wrapper.style.alignItems = 'center';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `project-item ${project?.id === p.id ? 'active' : ''}`;
        button.style.flex = '1';
        button.style.minWidth = '0';
        const icon = document.createElement('span');
        icon.className = 'project-item-icon';
        icon.textContent = hasFootage(p) ? '▶' : p.sourceLink ? '↗' : '▤';
        const details = document.createElement('span');
        details.style.minWidth = '0';
        const name = document.createElement('span');
        name.className = 'project-item-name';
        name.textContent = p.title;
        const sub = document.createElement('span');
        sub.className = 'project-item-sub';
        sub.textContent = p.video ? timecode(p.duration || 0) + ' · Match footage' : p.remoteVideo ? timecode(p.duration || 0) + ' · Veo streaming' : p.videoUrl ? timecode(p.duration || 0) + ' · Video link' : p.sourceLink ? 'Veo link saved · Attach footage' : 'No footage imported';
        details.append(name, sub);
        button.append(icon, details);
        button.addEventListener('click', () => { void selectProject(p.id); });
        wrapper.append(button);
        // Explicit delete action, requiring confirmation. Never deletes shared/source footage outside the app's data directory.
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove-project';
        remove.title = `Delete ${p.title}`;
        remove.setAttribute('aria-label', `Delete ${p.title}`);
        remove.textContent = '×';
        remove.style.cssText = 'background:none;border:0;color:#728697;font-size:17px;padding:5px;';
        remove.addEventListener('click', () => { void removeProject(p); });
        wrapper.append(remove);
        list.append(wrapper);
    }
}
function configureVideo(p) {
    clearAiCandidates();
    video.pause();
    cancelFreeze();
    freezeSeen.clear();
    lastPlaybackTime = 0;
    visual.style.transform = 'none';
    activePlayback = null;
    video.removeAttribute('src');
    video.load();
    currentTime = 0;
    const playable = hasFootage(p);
    frame.classList.toggle('has-video', playable);
    if (p.video) {
        video.src = `/api/videos/${p.video.id}`;
        text('video-description', p.video.originalName + ' · ' + formatSize(p.video.size));
        text('resolution', 'LOADING VIDEO');
    }
    else if (p.remoteVideo) {
        video.src = `/api/projects/${p.id}/veo-stream`;
        text('video-description', 'Veo remote playback · Download is not required');
        text('resolution', 'CONNECTING TO VEO');
    }
    else if (p.videoUrl) {
        video.src = p.videoUrl;
        text('video-description', 'External video · Streamed from source (not stored locally)');
        text('resolution', 'LOADING LINK');
    }
    else {
        text('video-description', p.sourceLink ? 'Veo link saved · Import an authorised video file to annotate' : 'Add match footage to start your analysis');
        text('resolution', 'NO FOOTAGE');
    }
    frame.style.aspectRatio = '16 / 9';
    editor.setVideoInfo(playable, 16 / 9, p.duration);
    editor.setTime(0);
    video.playbackRate = Number(el('play-speed').value);
    updatePlayback();
    renderSourceStrip();
}
function formatSize(bytes) {
    if (bytes < 1024 ** 2)
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
async function selectProject(id) {
    if (isUploading)
        return;
    await saveNow();
    try {
        const loaded = await api(`/api/projects/${id}`);
        const index = projects.findIndex((entry) => entry.id === loaded.id);
        if (index >= 0)
            projects[index] = loaded;
        else
            projects.unshift(loaded);
        loaded.freezes ??= [];
        loaded.zooms ??= [];
        loaded.autoFreezeAnnotations ??= true;
        loaded.clips ??= []; // v0.4 and earlier projects did not have clip fields.
        loaded.playlists ??= [];
        project = loaded;
        editingClipId = null;
        selectedPlaylistId = null;
        clearClipForm();
        history.reset(loaded.annotations);
        editor.selectedId = null;
        editor.setAnnotations(history.current);
        titleInput.value = loaded.title;
        dirty = false;
        saveLabel('Saved locally');
        configureVideo(loaded);
        renderAll();
        void resumeVeoImport(loaded.id);
    }
    catch (error) {
        notify(`Cannot open project: ${error.message}`, true);
    }
}
async function newProject() {
    if (isUploading)
        return;
    await saveNow();
    try {
        const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Untitled analysis' }) });
        projects.unshift(created);
        await selectProject(created.id);
        titleInput.focus();
        titleInput.select();
    }
    catch (error) {
        notify(error.message, true);
    }
}
async function removeProject(p) {
    if (isUploading || !confirm(`Delete “${p.title}” and its locally imported video?\n\nThis cannot be undone.`))
        return;
    if (project?.id === p.id) {
        if (saveTimer)
            clearTimeout(saveTimer);
        saveTimer = null;
        dirty = false;
    }
    try {
        await api(`/api/projects/${p.id}`, { method: 'DELETE' });
        projects = projects.filter((item) => item.id !== p.id);
        if (project?.id === p.id) {
            project = null;
            if (projects.length)
                await selectProject(projects[0].id);
            else
                await newProject();
        }
        else
            renderProjects();
        notify('Project deleted');
    }
    catch (error) {
        notify(error.message, true);
    }
}
let activeAiJob = null;
let aiRequestProject = null;
const aiLayer = document.getElementById('ai-detections');
const aiNS = 'http://www.w3.org/2000/svg';
function clearAiCandidates() {
    aiLayer.replaceChildren();
    aiLayer.setAttribute('hidden', '');
    el('ai-clear').hidden = true;
}
function setAiBusy(busy) {
    el('ai-detect').disabled = busy;
    el('ai-cancel').hidden = !busy;
    el('ai-seconds').disabled = busy;
}
function aiInfo(message) { text('ai-status', message); }
function showAiPeople(people, sourceTime) {
    clearAiCandidates();
    if (!people.length) {
        aiInfo('No visible people detected on that frame. Try another moment with players in clearer view.');
        return;
    }
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    const H = 1000 / aspect;
    aiLayer.setAttribute('viewBox', `0 0 1000 ${H}`);
    aiLayer.removeAttribute('hidden');
    el('ai-clear').hidden = false;
    people.forEach((person, index) => {
        if (!Array.isArray(person.box) || person.box.length !== 4 || !person.box.every(n => Number.isFinite(n) && n >= 0 && n <= 1))
            return;
        const [x1, y1, x2, y2] = person.box;
        const group = document.createElementNS(aiNS, 'g');
        group.setAttribute('class', 'ai-detection-target');
        group.setAttribute('role', 'button');
        group.setAttribute('tabindex', '0');
        group.setAttribute('aria-label', `Track detected person ${index + 1}`);
        const rect = document.createElementNS(aiNS, 'rect');
        for (const [attr, v] of Object.entries({ x: x1 * 1000, y: y1 * H, width: (x2 - x1) * 1000, height: (y2 - y1) * H, rx: 3 }))
            rect.setAttribute(attr, String(v));
        rect.setAttribute('fill', '#b7ff66');
        rect.setAttribute('fill-opacity', '.08');
        rect.setAttribute('stroke', '#b7ff66');
        rect.setAttribute('stroke-width', '2');
        const circle = document.createElementNS(aiNS, 'circle');
        circle.setAttribute('cx', String(person.foot.x * 1000));
        circle.setAttribute('cy', String(person.foot.y * H));
        circle.setAttribute('r', '8');
        circle.setAttribute('fill', '#b7ff66');
        circle.setAttribute('stroke', '#07141b');
        circle.setAttribute('stroke-width', '2');
        const hit = document.createElementNS(aiNS, 'rect');
        hit.setAttribute('x', String((x1 - .01) * 1000));
        hit.setAttribute('y', String((y1 - .01) * H));
        hit.setAttribute('width', String((x2 - x1 + .02) * 1000));
        hit.setAttribute('height', String((y2 - y1 + .02) * H));
        hit.setAttribute('fill', 'transparent');
        const choose = (event) => { event.preventDefault(); event.stopPropagation(); void runAiTrack(sourceTime, person.foot.x, person.foot.y); };
        group.addEventListener('click', choose);
        group.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') {
            choose(event);
        } });
        group.append(rect, circle, hit);
        aiLayer.append(group);
    });
    aiInfo(`${people.length} person(s) detected, including possible referees. Click the correct player's box to follow their feet.`);
}
function putTrackedFootMarker(result) {
    const points = result.points;
    if (!project || !Array.isArray(points) || points.length < 3 || points.length > 100)
        throw new Error('Tracker returned no usable positions');
    if (points.some(p => ![p.time, p.x, p.y].every(n => Number.isFinite(n)) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1))
        throw new Error('Tracker returned invalid positions');
    const sorted = [...points].sort((a, b) => a.time - b.time), first = sorted[0], last = sorted[sorted.length - 1];
    if (last.time - first.time < .15)
        throw new Error('Track was too short to save');
    const rx = .013, ry = .019;
    const x1 = clamp(first.x - rx, 0, 1), y1 = clamp(first.y - ry, 0, 1);
    const marker = { id: newId(), type: 'footmarker', x1, y1, x2: clamp(first.x + rx, 0, 1), y2: clamp(first.y + ry, 0, 1), points: [], text: '', color: '#b7ff66', width: 4, start: first.time, end: Math.min(project.duration || 86400, last.time + .07), fade: 0,
        keyframes: sorted.map(p => ({ time: p.time, x: clamp(x1 + p.x - first.x, 0, 1), y: clamp(y1 + p.y - first.y, 0, 1) })) };
    autoFreezeForAnnotation(marker.start);
    history.commit([...history.current, marker]);
    editor.setAnnotations(history.current);
    editor.setSelected(marker.id);
    markDirty();
    renderAll();
    const stopped = result.reason !== 'completed';
    aiInfo(stopped ? `Partial track saved: ${result.reason}. Review the foot marker before exporting.` : `Foot marker saved for ${sorted.length} detected frames. Review before exporting.`);
    notify(stopped ? 'Partial track saved — check where tracking stopped' : 'Player foot marker added and saved');
}
async function runAi(mode, time, x, y) {
    if (!project || !hasFootage(project))
        return notify('Open video footage before using AI player tracking.', true);
    if (activeAiJob)
        return notify('Another AI analysis is running. Cancel it first.', true);
    video.pause();
    cancelFreeze();
    if (mode === 'detect')
        clearAiCandidates();
    const id = project.id;
    try {
        const req = { mode, time: Number(time.toFixed(3)), ...(mode === 'track' ? { x, y, seconds: Number(el('ai-seconds').value) } : {}) };
        const job = await api(`/api/projects/${id}/ai-track`, { method: 'POST', body: JSON.stringify(req) });
        activeAiJob = job.id;
        aiRequestProject = id;
        setAiBusy(true);
        aiInfo(job.phase);
        for (let i = 0; i < 750; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (activeAiJob !== job.id)
                return;
            const progress = await api(`/api/ai-jobs/${job.id}`);
            if (progress.status === 'running') {
                aiInfo(`${progress.phase} (${Math.round(progress.percent)}%)`);
                continue;
            }
            activeAiJob = null;
            aiRequestProject = null;
            setAiBusy(false);
            if (progress.status === 'completed' && progress.result && project?.id === id) {
                if (progress.result.mode === 'detect')
                    showAiPeople(progress.result.people, progress.result.time);
                else {
                    clearAiCandidates();
                    putTrackedFootMarker(progress.result);
                }
            }
            else if (progress.status === 'failed') {
                aiInfo(progress.error || 'Player detection failed');
                notify(progress.error || 'Player detection failed', true);
            }
            else if (progress.status === 'cancelled')
                aiInfo('AI analysis cancelled.');
            return;
        }
        throw new Error('AI tracking took too long. Cancel and try a shorter selection.');
    }
    catch (error) {
        aiInfo(error.message);
        notify(error.message, true);
    }
    finally {
        if (!activeAiJob) {
            setAiBusy(false);
            aiRequestProject = null;
        }
    }
}
async function runAiTrack(time, x, y) {
    clearAiCandidates();
    await runAi('track', time, x, y);
}
const editor = new TacticalEditor(overlay, (annotations) => {
    const oldIds = new Set(history.current.map(a => a.id));
    const newlyAdded = annotations.find(a => !oldIds.has(a.id));
    if (newlyAdded)
        autoFreezeForAnnotation(newlyAdded.start);
    history.commit(annotations);
    editor.setAnnotations(history.current);
    markDirty();
    renderAll();
}, (id) => { renderAnnotationList(); renderProperties(id); });
function selectTool(tool) {
    if (tool !== 'select') {
        video.pause();
        showInspectorTab('annotations');
    }
    editor.setTool(tool);
    document.querySelectorAll('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
    updatePlayback();
}
function renderColors(containerId, selected, onSelect) {
    const container = el(containerId);
    container.replaceChildren();
    COLORS.forEach((color) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'color-swatch' + (color === selected ? ' active' : '');
        button.style.setProperty('--swatch', color);
        button.title = `Colour ${color}`;
        button.setAttribute('aria-label', `Colour ${color}`);
        button.addEventListener('click', () => onSelect(color));
        container.append(button);
    });
}
function renderAnnotationList() {
    annotationList.replaceChildren();
    const items = history.current.slice().reverse();
    text('annotation-count', `${items.length} ANNOTATION${items.length === 1 ? '' : 'S'}`);
    text('right-count', `${items.length} item${items.length === 1 ? '' : 's'}`);
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No annotations yet. Choose a drawing tool to begin.';
        annotationList.append(empty);
        return;
    }
    const glyph = { footmarker: '◉', arrow: '➜', line: '╱', rect: '▭', ellipse: '◯', pen: '✎', text: 'T', highlight: '◎', spotlight: '◉', curve: '↝', zone: '▧' };
    items.forEach((a) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `annotation-item ${editor.selectedId === a.id ? 'active' : ''}`;
        const ic = document.createElement('div');
        ic.className = 'annotation-glyph';
        ic.textContent = glyph[a.type];
        ic.style.color = a.color;
        const details = document.createElement('div');
        details.className = 'annotation-info';
        const name = document.createElement('span');
        name.className = 'annotation-name';
        name.textContent = a.type === 'text' ? a.text || 'Text label' : TOOL_NAMES[a.type];
        const timestamp = document.createElement('span');
        timestamp.className = 'annotation-time';
        timestamp.textContent = `${timecode(a.start)} — ${timecode(a.end)}`;
        details.append(name, timestamp);
        button.append(ic, details);
        button.addEventListener('click', () => { selectTool('select'); seekVideo(a.start); editor.setSelected(a.id); });
        annotationList.append(button);
    });
}
function renderProperties(id) {
    const item = history.current.find((a) => a.id === id);
    propertiesEmpty.hidden = !!item;
    propertiesForm.hidden = !item;
    if (!item)
        return;
    propText.value = item.text;
    propText.disabled = item.type !== 'text';
    propText.previousElementSibling?.toggleAttribute('hidden', item.type !== 'text');
    propText.hidden = item.type !== 'text';
    propWidth.value = String(item.width);
    text('width-label', `${item.width}px`);
    propStart.value = formatClipClock(item.start);
    propEnd.value = formatClipClock(item.end);
    el('prop-fade').value = String(item.fade || 0);
    text('fade-label', `${(item.fade || 0).toFixed(1)}s`);
    el('bend-wrap').hidden = item.type !== 'curve';
    el('prop-bend').value = String(item.bend ?? -.18);
    el('add-keyframe').disabled = !['highlight', 'spotlight', 'ellipse', 'text'].includes(item.type);
    text('keyframe-hint', `${item.keyframes?.length || 0} keyframe(s). Move the video forward and drag the selected highlight to follow the player.`);
    renderColors('prop-colors', item.color, (color) => updateSelected((a) => ({ ...a, color })));
}
function updateSelected(updater) {
    if (!editor.selectedId)
        return;
    const before = history.current.find(a => a.id === editor.selectedId);
    const next = history.current.map((a) => a.id === editor.selectedId ? updater(a) : a);
    history.commit(next);
    const after = history.current.find(a => a.id === editor.selectedId);
    if (before && after && Math.abs(before.start - after.start) > .001) {
        pruneOrphanedAutoFreezes();
        autoFreezeForAnnotation(after.start);
    }
    editor.setAnnotations(history.current);
    renderAll();
    markDirty();
}
// Clip and playlist data contain only IDs, tags, timestamps and notes; no copied video bytes.
const clips = () => project?.clips ?? [];
const playlists = () => project?.playlists ?? [];
const clipById = (id) => (previewClip?.id === id ? previewClip : clips().find((c) => c.id === id));
const selectedPlaylist = () => playlists().find((p) => p.id === selectedPlaylistId);
const clipInput = (id) => el(id);
function showInspectorTab(tab) {
    el('clips-pane').hidden = tab !== 'clips';
    el('annotations-pane').hidden = tab !== 'annotations';
    for (const kind of ['clips', 'annotations']) {
        const button = el(`tab-${kind}`);
        button.classList.toggle('active', tab === kind);
        button.setAttribute('aria-selected', String(tab === kind));
    }
}
function clearClipForm() {
    editingClipId = null;
    if (previewClip && activePlayback?.clipIds.includes(previewClip.id)) {
        activePlayback = null;
        video.pause();
    }
    previewClip = null;
    if (!document.getElementById('clip-in'))
        return;
    clipInput('clip-in').value = '00:00';
    clipInput('clip-out').value = '00:00';
    el('clip-preset').value = '';
    clipInput('clip-title').value = '';
    clipInput('clip-category').value = 'General';
    clipInput('clip-notes').value = '';
    text('save-clip', '＋ Save clip');
    text('clip-editing-status', '');
    text('clip-status', 'Mark IN and OUT while reviewing the match');
}
function editClip(clip) {
    activePlayback = null;
    video.pause();
    editingClipId = clip.id;
    clipInput('clip-in').value = formatClipClock(clip.start);
    clipInput('clip-out').value = formatClipClock(clip.end);
    clipInput('clip-title').value = clip.title;
    el('clip-preset').value = CLIP_PRESETS.some(item => item.label === clip.title) ? clip.title : 'custom';
    clipInput('clip-category').value = clip.category;
    clipInput('clip-notes').value = clip.notes;
    text('save-clip', '✓ Update clip');
    text('clip-editing-status', 'Editing saved clip');
    text('clip-status', `${timecode(clip.start)} – ${timecode(clip.end)} · ${(clip.end - clip.start).toFixed(1)}s`);
    seekVideo(clip.start);
    renderClipLibrary();
    el('clip-maker').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function markPoint(which) {
    if (!hasFootage(project) || !Number.isFinite(video.duration))
        return notify('Load the match before marking clips.', true);
    clipInput(`clip-${which}`).value = formatClipClock(video.currentTime);
    renderTrimHint();
}
function readClipRange() {
    const start = parseClipClock(clipInput('clip-in').value);
    const end = parseClipClock(clipInput('clip-out').value);
    const duration = video.duration;
    if (!hasFootage(project) || !Number.isFinite(duration) || duration <= 0)
        throw new Error('Open playable footage and load its duration first.');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration + 0.05 || end > 86400) {
        throw new Error('Set an IN time before the OUT time, both within the match duration.');
    }
    return { start, end: Math.min(end, duration) };
}
function renderTrimHint() {
    try {
        const start = parseClipClock(clipInput('clip-in').value), end = parseClipClock(clipInput('clip-out').value);
        text('clip-status', end > start ? `${formatClipClock(start)} – ${formatClipClock(end)} · ${Math.round(end - start)} seconds` : 'Mark IN and OUT while reviewing the match');
    }
    catch {
        text('clip-status', 'Enter time as MM:SS, e.g. 12:35');
    }
}
function saveClip() {
    if (!project)
        return;
    try {
        const { start, end } = readClipRange();
        const name = clipInput('clip-title').value.trim();
        if (!name || name.length > 100)
            return notify('Give this clip a title (up to 100 characters).', true);
        const category = clipInput('clip-category').value.trim() || 'General';
        if (category.length > 40)
            return notify('Category is too long.', true);
        const notes = clipInput('clip-notes').value.trim();
        const existing = editingClipId ? clipById(editingClipId) : undefined;
        const now = new Date().toISOString();
        const clip = { id: existing?.id || newId(), title: name, start, end, category, notes,
            createdAt: existing?.createdAt || now, updatedAt: now };
        project.clips = existing ? clips().map(c => c.id === clip.id ? clip : c) : [...clips(), clip];
        markDirty();
        clearClipForm();
        renderAll();
        notify(existing ? 'Clip updated and saved' : 'Clip created — no video duplication');
    }
    catch (error) {
        notify(error.message, true);
    }
}
/** One button saves the moment with five seconds either side, without filling the trim form. */
function quickSaveMoment(tagged) {
    if (!project || !hasFootage(project))
        return notify('Open match footage first.', true);
    let range;
    try {
        range = quickClipRange(video.currentTime, video.duration);
    }
    catch (e) {
        return notify(e.message, true);
    }
    const preset = el('clip-preset').value;
    const selected = CLIP_PRESETS.find(item => item.label === preset);
    const custom = clipInput('clip-title').value.trim();
    if (tagged && !selected && !custom)
        return notify('Choose a football event in the dropdown or enter a custom name before tagging.', true);
    const title = (selected?.label || custom || `Match moment ${formatClipClock(video.currentTime)}`).slice(0, 100);
    const category = selected?.category || (clipInput('clip-category').value.trim() || 'General').slice(0, 40);
    const now = new Date().toISOString();
    const clip = { id: newId(), title, start: range.start, end: range.end, category, notes: clipInput('clip-notes').value.trim().slice(0, 500), createdAt: now, updatedAt: now };
    project.clips = [...clips(), clip];
    const chosen = selectedPlaylist();
    if (chosen)
        project.playlists = playlists().map(p => p.id === chosen.id ? { ...p, clipIds: [...p.clipIds, clip.id], updatedAt: now } : p);
    // Keep the selection visible for rapid repeated tagging; don't overwrite manual trim data.
    clipInput('clip-in').value = formatClipClock(range.start);
    clipInput('clip-out').value = formatClipClock(range.end);
    editingClipId = null;
    markDirty();
    renderAll();
    notify(`${tagged ? 'Event tagged' : 'Clip saved'}: ${title} · ${formatClipClock(range.start)}–${formatClipClock(range.end)}${chosen ? ' · added to playlist' : ''}`);
}
function deleteClip(id) {
    if (!project || !confirm('Delete this clip from this match and all playlists? The original video stays untouched.'))
        return;
    project.clips = clips().filter(c => c.id !== id);
    project.playlists = playlists().map(p => ({ ...p, clipIds: p.clipIds.filter(x => x !== id), updatedAt: new Date().toISOString() }));
    if (editingClipId === id)
        clearClipForm();
    if (activePlayback?.clipIds.includes(id))
        stopClipPlayback();
    markDirty();
    renderAll();
    notify('Clip removed from library and playlists');
}
function createPlaylist() {
    if (!project)
        return;
    const name = clipInput('playlist-title').value.trim();
    if (!name || name.length > 100)
        return notify('Enter a playlist name (up to 100 characters).', true);
    const now = new Date().toISOString();
    const item = { id: newId(), title: name, clipIds: [], createdAt: now, updatedAt: now };
    project.playlists = [...playlists(), item];
    selectedPlaylistId = item.id;
    clipInput('playlist-title').value = '';
    markDirty();
    renderClipLibrary();
    notify('Empty playlist created');
}
function updatePlaylist(id, updater) {
    if (!project)
        return;
    project.playlists = playlists().map(p => p.id === id ? { ...updater(p), updatedAt: new Date().toISOString() } : p);
    markDirty();
    renderClipLibrary();
}
function addToPlaylist(id) {
    const item = selectedPlaylist();
    if (!item)
        return notify('Create or select a playlist first.', true);
    updatePlaylist(item.id, p => ({ ...p, clipIds: [...p.clipIds, id] }));
    notify('Clip added to playlist');
}
function changeQueue(index, direction) {
    const item = selectedPlaylist();
    if (!item)
        return;
    const queue = [...item.clipIds];
    if (direction === 'remove')
        queue.splice(index, 1);
    else {
        const next = index + (direction === 'up' ? -1 : 1);
        if (next < 0 || next >= queue.length)
            return;
        [queue[index], queue[next]] = [queue[next], queue[index]];
    }
    if (activePlayback?.playlistId === item.id)
        stopClipPlayback();
    updatePlaylist(item.id, p => ({ ...p, clipIds: queue }));
}
function stopClipPlayback() {
    cancelFreeze();
    freezeSeen.clear();
    activePlayback = null;
    previewClip = null;
    video.pause();
    text('clip-status', 'Playback stopped');
    renderClipLibrary();
}
function playSequence(ids, first = 0, playlistId = null) {
    if (!hasFootage(project) || !Number.isFinite(video.duration))
        return notify('Load playable footage before playing clips.', true);
    if (!ids.length || ids.some(id => !clipById(id)) || first >= ids.length)
        return notify('This playlist contains no playable clips.', true);
    if (previewClip && !ids.includes(previewClip.id))
        previewClip = null;
    activePlayback = { clipIds: [...ids], index: first, playlistId };
    void playActiveClip();
}
async function playActiveClip() {
    cancelFreeze();
    freezeSeen.clear();
    if (!activePlayback)
        return;
    const item = clipById(activePlayback.clipIds[activePlayback.index]);
    if (!item)
        return stopClipPlayback();
    video.pause();
    video.currentTime = item.start;
    lastPlaybackTime = item.start;
    text('clip-status', `Playing ${item.title} · ${activePlayback.index + 1} / ${activePlayback.clipIds.length}`);
    renderClipLibrary();
    try {
        await video.play();
    }
    catch {
        stopClipPlayback();
        notify('Unable to play this segment from the source.', true);
    }
}
function checkClipBoundary() {
    if (!activePlayback || video.paused || video.seeking)
        return;
    const item = clipById(activePlayback.clipIds[activePlayback.index]);
    if (!item || video.currentTime < item.end - 0.06)
        return;
    video.pause();
    if (activePlayback.index + 1 < activePlayback.clipIds.length) {
        activePlayback.index++;
        void playActiveClip();
    }
    else {
        video.currentTime = item.end;
        activePlayback = null;
        previewClip = null;
        text('clip-status', 'Clip / playlist finished');
        renderClipLibrary();
    }
}
function renderClipLibrary() {
    const matchClips = clips();
    const matchPlaylists = playlists();
    text('clip-count', `${matchClips.length} clip${matchClips.length === 1 ? '' : 's'}`);
    text('playlist-count', `${matchPlaylists.length} playlist${matchPlaylists.length === 1 ? '' : 's'}`);
    const filter = clipInput('clip-filter').value.toLowerCase().trim();
    const clipList = el('clip-list');
    clipList.replaceChildren();
    const matching = matchClips.filter(c => (c.title + ' ' + c.category + ' ' + c.notes).toLowerCase().includes(filter)).sort((a, b) => a.start - b.start);
    if (!matching.length) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = matchClips.length ? 'No clips match your filter.' : 'No clips yet. Use Mark IN and Mark OUT on the timeline, then Save clip.';
        clipList.append(empty);
    }
    for (const item of matching) {
        const line = document.createElement('div');
        line.className = `clip-entry ${editingClipId === item.id ? 'editing' : ''}`;
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'clip-entry-main';
        main.title = 'Edit this clip';
        const name = document.createElement('span');
        name.className = 'clip-entry-title';
        name.textContent = item.title;
        const meta = document.createElement('span');
        meta.className = 'clip-entry-meta';
        meta.textContent = `${item.category} · ${timecode(item.start)}–${timecode(item.end)} · ${(item.end - item.start).toFixed(1)}s`;
        main.append(name, meta);
        main.addEventListener('click', () => editClip(item));
        const buttons = document.createElement('div');
        buttons.className = 'clip-entry-controls';
        const play = document.createElement('button');
        play.textContent = '▶';
        play.title = 'Play this clip';
        play.setAttribute('aria-label', `Play ${item.title}`);
        play.addEventListener('click', () => playSequence([item.id]));
        const add = document.createElement('button');
        add.textContent = '+';
        add.title = 'Add to selected playlist';
        add.setAttribute('aria-label', `Add ${item.title} to playlist`);
        add.addEventListener('click', () => addToPlaylist(item.id));
        const remove = document.createElement('button');
        remove.textContent = '×';
        remove.className = 'clip-remove';
        remove.title = 'Delete clip';
        remove.setAttribute('aria-label', `Delete ${item.title}`);
        remove.addEventListener('click', () => deleteClip(item.id));
        buttons.append(play, add, remove);
        line.append(main, buttons);
        clipList.append(line);
    }
    const chooser = el('playlist-select');
    chooser.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a playlist';
    chooser.append(placeholder);
    if (selectedPlaylistId && !matchPlaylists.some(p => p.id === selectedPlaylistId))
        selectedPlaylistId = null;
    for (const p of matchPlaylists) {
        const option = document.createElement('option');
        option.value = p.id;
        option.textContent = `${p.title} (${p.clipIds.length})`;
        chooser.append(option);
    }
    chooser.value = selectedPlaylistId || '';
    const queueEl = el('playlist-queue');
    queueEl.replaceChildren();
    const playlist = selectedPlaylist();
    for (const id of ['play-playlist', 'stop-playlist', 'rename-playlist', 'delete-playlist'])
        el(id).disabled = !playlist;
    if (!playlist || !playlist.clipIds.length) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = playlist ? 'Playlist is empty. Select it, then use + beside any clip above.' : 'Create or choose a playlist.';
        queueEl.append(empty);
        return;
    }
    playlist.clipIds.forEach((id, i) => {
        const clip = clipById(id);
        if (!clip)
            return;
        const line = document.createElement('div');
        line.className = `clip-entry ${activePlayback?.playlistId === playlist.id && activePlayback.index === i ? 'queue-row-now' : ''}`;
        const main = document.createElement('button');
        main.type = 'button';
        main.className = 'clip-entry-main';
        const title = document.createElement('span');
        title.className = 'clip-entry-title';
        title.textContent = `${i + 1}. ${clip.title}`;
        const meta = document.createElement('span');
        meta.className = 'clip-entry-meta';
        meta.textContent = `${timecode(clip.start)}–${timecode(clip.end)}`;
        main.append(title, meta);
        main.addEventListener('click', () => playSequence(playlist.clipIds, i, playlist.id));
        const actions = document.createElement('div');
        actions.className = 'queue-actions';
        for (const [sym, direction, title] of [['↑', 'up', 'Move earlier'], ['↓', 'down', 'Move later'], ['×', 'remove', 'Remove from playlist']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = sym;
            button.title = title;
            button.setAttribute('aria-label', `${title}: ${clip.title}`);
            button.disabled = direction === 'up' && i === 0 || direction === 'down' && i === playlist.clipIds.length - 1;
            button.addEventListener('click', () => changeQueue(i, direction));
            actions.append(button);
        }
        line.append(main, actions);
        queueEl.append(line);
    });
}
function renderExportChoices() {
    const selector = el('export-target');
    const old = selector.value;
    selector.replaceChildren();
    const first = document.createElement('option');
    first.value = '';
    first.textContent = 'Choose saved clip or playlist…';
    selector.append(first);
    const clipGroup = document.createElement('optgroup');
    clipGroup.label = 'Clips';
    for (const clip of clips()) {
        const option = document.createElement('option');
        option.value = `clip:${clip.id}`;
        option.textContent = `${clip.title} (${formatClipClock(clip.start)}–${formatClipClock(clip.end)})`;
        clipGroup.append(option);
    }
    selector.append(clipGroup);
    const playlistGroup = document.createElement('optgroup');
    playlistGroup.label = 'Playlists';
    for (const item of playlists()) {
        const option = document.createElement('option');
        option.value = `playlist:${item.id}`;
        option.textContent = `${item.title} (${item.clipIds.length} clips)`;
        playlistGroup.append(option);
    }
    selector.append(playlistGroup);
    selector.value = old;
    if (!selector.value && editingClipId)
        selector.value = `clip:${editingClipId}`;
    el('start-export').disabled = !!exportJobId || !hasFootage(project) || !clips().length;
}
function renderExportProgress(job) {
    el('export-progress').hidden = false;
    text('export-phase', job.status === 'failed' ? job.error || 'Export failed' : job.phase);
    text('export-percent', `${(job.percent || 0).toFixed(1)}%`);
    el('export-progress-fill').style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
    el('export-cancel').hidden = job.status !== 'running';
    const download = el('export-download');
    download.hidden = job.status !== 'completed';
    if (job.status === 'completed') {
        download.href = `/api/exports/${job.id}/download`;
        download.setAttribute('download', job.name);
    }
}
async function startVideoExport() {
    if (!project || exportJobId)
        return;
    const target = el('export-target').value;
    if (!target)
        return notify('Choose a saved clip or playlist to export.', true);
    await saveNow();
    if (dirty)
        return notify('Save your project before exporting.', true);
    const [kind, id] = target.split(':');
    try {
        const request = { ...(kind === 'clip' ? { clipId: id } : { playlistId: id }), quality: el('export-quality').value, annotations: el('export-annotations').checked };
        const job = await api(`/api/projects/${project.id}/exports`, { method: 'POST', body: JSON.stringify(request) });
        exportJobId = job.id;
        renderExportProgress(job);
        renderExportChoices();
        notify('MP4 export started');
        await trackExport(job.id);
    }
    catch (e) {
        notify(e.message, true);
    }
}
async function trackExport(id) {
    try {
        for (let i = 0; i < 1800; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const job = await api(`/api/exports/${id}`);
            renderExportProgress(job);
            if (job.status !== 'running') {
                if (job.status === 'completed')
                    notify('Export ready — click Download MP4');
                else
                    notify(job.error || 'Export cancelled', job.status === 'failed');
                break;
            }
        }
    }
    catch (e) {
        notify(`Export status unavailable: ${e.message}`, true);
    }
    finally {
        if (exportJobId === id)
            exportJobId = null;
        renderExportChoices();
    }
}
function insertTacticalTemplate() {
    if (!project || !hasFootage(project))
        return notify('Load match footage before inserting tactical annotations.', true);
    const time = Number(video.currentTime.toFixed(2)), type = el('template-select').value;
    const make = (tool, x1, y1, x2, y2, text = '') => {
        const a = makeAnnotation(tool, { x: x1, y: y1 }, time, project?.duration || null, editor.color, 4);
        return { ...a, x1, y1, x2, y2, ...(text ? { text } : {}) };
    };
    let shapes = [];
    if (type === 'press')
        shapes = [make('zone', .36, .31, .65, .67), make('curve', .67, .43, .49, .54), make('text', .4, .28, .4, .28, 'PRESSING TRAP')];
    else if (type === 'pass')
        shapes = [make('highlight', .28, .57, .38, .67), make('curve', .36, .58, .7, .3), make('text', .49, .25, .49, .25, 'PASSING LANE')];
    else
        shapes = [make('zone', .3, .3, .72, .74), make('line', .36, .45, .67, .45), make('line', .36, .6, .67, .6), make('text', .36, .28, .36, .28, 'COMPACT BLOCK')];
    autoFreezeForAnnotation(time);
    history.commit([...history.current, ...shapes]);
    editor.setAnnotations(history.current);
    selectTool('select');
    editor.setSelected(shapes.at(-1)?.id || null);
    markDirty();
    renderAll();
    notify('Editable tactical template added. Drag the shapes onto the real positions.');
}
function freezes() { return project?.freezes || []; }
function zooms() { return project?.zooms || []; }
function renderDirectorEffects() {
    const list = el('effects-list');
    list.replaceChildren();
    const items = [...freezes().map(f => ({ type: 'freeze', at: f.at, id: f.id, detail: `${timecode(f.at)} · hold ${f.hold}s`, name: f.label || 'Freeze frame' })), ...zooms().map(z => ({ type: 'zoom', at: z.start, id: z.id, detail: `${timecode(z.start)}–${timecode(z.end)} · ${z.scale}×`, name: 'Camera zoom' }))].sort((a, b) => a.at - b.at);
    if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'list-empty';
        empty.textContent = 'No freeze frames or zooms. Add one at the playhead.';
        list.append(empty);
        return;
    }
    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'effect-row';
        const label = document.createElement('div');
        label.className = 'effect-name';
        label.textContent = `${item.type === 'freeze' ? '❚❚' : '⌕'} ${item.name}`;
        const sub = document.createElement('small');
        sub.textContent = item.detail;
        label.append(sub);
        const jump = document.createElement('button');
        jump.textContent = 'Go';
        jump.title = 'Seek to effect';
        jump.addEventListener('click', () => seekVideo(item.at));
        const del = document.createElement('button');
        del.textContent = '×';
        del.title = 'Delete effect';
        del.addEventListener('click', () => {
            if (!project)
                return;
            if (item.type === 'freeze')
                project.freezes = freezes().filter(f => f.id !== item.id);
            else
                project.zooms = zooms().filter(z => z.id !== item.id);
            cancelFreeze();
            freezeSeen.clear();
            markDirty();
            renderAll();
            updatePlayback();
        });
        row.append(label, jump, del);
        list.append(row);
    }
}
function pruneOrphanedAutoFreezes() {
    if (!project)
        return;
    project.freezes = freezes().filter(f => f.label !== 'Automatic analysis hold' || history.current.some(a => Math.abs(a.start - f.at) < .35));
}
function autoFreezeForAnnotation(at) {
    if (!project || !hasFootage(project) || project.autoFreezeAnnotations === false)
        return;
    if (!Number.isFinite(at) || freezes().length >= 200 || freezes().some(f => Math.abs(f.at - at) < .35))
        return;
    project.freezes = [...freezes(), { id: newId(), at: Number(at.toFixed(2)), hold: 3, label: 'Automatic analysis hold' }].sort((a, b) => a.at - b.at);
    // A cluster of arrows/circles at the same tactical moment produces just one freeze.
    freezeSeen.clear();
}
function addFreezeAtPlayhead() {
    if (!project || !hasFootage(project) || !Number.isFinite(video.duration))
        return notify('Open playable match footage first.', true);
    const hold = Number(el('freeze-hold').value);
    if (!Number.isFinite(hold) || hold < .5 || hold > 20)
        return notify('Freeze duration must be 0.5–20 seconds.', true);
    const at = Number(video.currentTime.toFixed(2));
    if (freezes().some(f => Math.abs(f.at - at) < .25))
        return notify('There is already a freeze frame at this time.', true);
    project.freezes = [...freezes(), { id: newId(), at, hold, label: 'Tactical freeze' }].sort((a, b) => a.at - b.at);
    video.pause();
    markDirty();
    renderAll();
    notify(`Freeze added at ${timecode(at)} for ${hold} seconds. Draw on this frame, then export your clip.`);
}
function addZoomAtPlayhead() {
    if (!project || !hasFootage(project) || !Number.isFinite(video.duration))
        return notify('Open playable match footage first.', true);
    const at = Number(video.currentTime.toFixed(2)), end = Math.min(video.duration, at + 4);
    if (end <= at + .1)
        return notify('Move the playhead earlier before adding zoom.', true);
    const selected = history.current.find(a => a.id === editor.selectedId);
    const pos = selected ? poseAt(selected, at) : null;
    const x = pos ? clamp((pos.x1 + pos.x2) / 2, 0, 1) : .5, y = pos ? clamp((pos.y1 + pos.y2) / 2, 0, 1) : .5;
    project.zooms = [...zooms(), { id: newId(), start: at, end, x, y, scale: Number(el('zoom-scale').value) }];
    markDirty();
    renderAll();
    updatePlayback();
    notify('Zoom added for four seconds. Select a player circle before zooming to centre on them.');
}
function applyZoomPreview(at) {
    const z = zooms().slice().reverse().find(effect => at >= effect.start && at <= effect.end);
    if (z) {
        const tx = clamp(50 - z.scale * z.x * 100, 100 * (1 - z.scale), 0);
        const ty = clamp(50 - z.scale * z.y * 100, 100 * (1 - z.scale), 0);
        visual.style.transformOrigin = '0 0';
        visual.style.transform = `translate(${tx}%,${ty}%) scale(${z.scale})`;
    }
    else {
        visual.style.transformOrigin = '50% 50%';
        visual.style.transform = 'none';
    }
}
function checkFreezeTrigger(at, from) {
    if (!project || video.paused || video.seeking)
        return;
    const f = freezes().find(f => !freezeSeen.has(f.id) && at >= f.at && from <= f.at + .02);
    if (!f)
        return;
    freezeSeen.add(f.id);
    inFreeze = true;
    video.pause();
    const label = el('freeze-indicator');
    label.hidden = false;
    text('freeze-counter', `${f.hold}s tactical pause · drawings remain visible`);
    // This hold is a presentation timeline event: video time stops while the selected frame remains.
    freezeTimer = setTimeout(() => {
        freezeTimer = null;
        inFreeze = false;
        label.hidden = true;
        if (!project || !hasFootage(project))
            return;
        if (video.currentTime <= f.at + .2)
            video.currentTime = Math.min(video.duration, f.at + .06);
        void video.play().catch(() => notify('Unable to resume video after freeze.', true));
    }, Math.round(f.hold * 1000));
}
function renderAll() {
    renderProjects();
    renderAnnotationList();
    renderProperties(editor.selectedId);
    renderDirectorEffects();
    el('auto-freeze').checked = project?.autoFreezeAnnotations !== false;
    el('undo').disabled = !history.canUndo;
    el('redo').disabled = !history.canRedo;
    renderTimelineMarkers();
    renderClipLibrary();
    renderExportChoices();
}
function renderTimelineMarkers() {
    const markers = el('timeline-markers');
    markers.replaceChildren();
    const clipMarkers = el('clip-timeline-markers');
    clipMarkers.replaceChildren();
    const duration = video.duration || project?.duration || 0;
    const effects = el('effect-timeline-markers');
    effects.replaceChildren();
    if (!duration || !Number.isFinite(duration))
        return;
    for (const f of project?.freezes || []) {
        const m = document.createElement('div');
        m.className = 'freeze-marker';
        m.style.left = `${100 * f.at / duration}%`;
        m.title = `Freeze ${timecode(f.at)}`;
        effects.append(m);
    }
    for (const z of project?.zooms || []) {
        const m = document.createElement('div');
        m.className = 'zoom-marker';
        m.style.left = `${100 * z.start / duration}%`;
        m.style.width = `${100 * (z.end - z.start) / duration}%`;
        effects.append(m);
    }
    history.current.forEach((a) => {
        const marker = document.createElement('div');
        marker.className = 'timeline-marker';
        marker.style.left = `${clamp((a.start / duration) * 100, 0, 100)}%`;
        marker.title = `${TOOL_NAMES[a.type]} at ${timecode(a.start)}`;
        markers.append(marker);
    });
    for (const clip of project?.clips || []) {
        const segment = document.createElement('div');
        segment.className = `clip-timeline-segment ${editingClipId === clip.id ? 'active' : ''}`;
        segment.style.left = `${clamp(clip.start / duration * 100, 0, 100)}%`;
        segment.style.width = `${clamp((clip.end - clip.start) / duration * 100, 0, 100)}%`;
        segment.title = `${clip.title}: ${timecode(clip.start)}–${timecode(clip.end)}`;
        clipMarkers.append(segment);
    }
}
function updatePlayback() {
    const duration = Number.isFinite(video.duration) ? video.duration : project?.duration || 0;
    const current = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    currentTime = current;
    text('current-time', timecode(current));
    text('total-time', timecode(duration));
    text('timeline-end', `${String(Math.floor(duration / 60)).padStart(2, '0')}:${String(Math.floor(duration % 60)).padStart(2, '0')}`);
    text('timeline-start', '00:00');
    el('play').textContent = video.paused && !inFreeze ? '▶' : 'Ⅱ';
    el('play').disabled = !(hasFootage(project));
    el('play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    for (const id of ['back-5', 'forward-5', 'frame-back', 'frame-next'])
        el(id).disabled = !(hasFootage(project));
    const pct = duration ? clamp(current / duration, 0, 1) : 0;
    seek.value = String(Math.round(pct * 1000));
    seek.style.setProperty('--seek-percent', `${pct * 100}%`);
    editor.setTime(current);
    applyZoomPreview(current);
    const previous = lastPlaybackTime;
    lastPlaybackTime = current;
    if (!inFreeze)
        checkFreezeTrigger(current, previous);
    if (!inFreeze)
        checkClipBoundary();
}
function seekVideo(at) {
    cancelFreeze();
    freezeSeen.clear();
    clearAiCandidates();
    if (activePlayback) {
        activePlayback = null;
        previewClip = null;
        renderClipLibrary();
    }
    if (!(hasFootage(project)) || !Number.isFinite(video.duration))
        return;
    video.currentTime = clamp(at, 0, video.duration);
    lastPlaybackTime = video.currentTime;
    updatePlayback();
}
function renderSourceStrip() {
    const strip = el('source-strip');
    const hasVeo = !!project?.sourceLink;
    const hasRemote = !!project?.videoUrl;
    strip.hidden = !hasVeo && !hasRemote;
    if (!project)
        return;
    if (hasVeo) {
        text('source-title', project.remoteVideo ? 'Streaming directly from Veo' : hasFootage(project) ? 'Veo source linked to this analysis' : 'Veo match link saved');
        text('source-message', project.remoteVideo ? 'Playing only the portions of the remote recording needed for viewing. Internet access is required; original footage remains on Veo.' : hasFootage(project)
            ? 'The original Veo page is saved as a reference for this video.'
            : 'To load footage here, choose Paste link and import this accessible match using yt-dlp, or attach an authorised MP4.');
    }
    else if (hasRemote) {
        text('source-title', 'Direct video-file link');
        text('source-message', 'Playing from an external HTTPS address. Video is not stored locally and may become unavailable.');
    }
    el('open-source').hidden = !hasVeo;
    text('attach-source', project.video ? 'Replace video file' : 'Attach video file');
    el('remove-source').setAttribute('aria-label', hasVeo ? 'Remove Veo link' : 'Remove remote video');
}
function openLinkDialog() {
    if (isUploading)
        return;
    el('link-modal').hidden = false;
    const veoStatus = el('veo-link-status');
    veoStatus.hidden = true;
    veoStatus.textContent = '';
    const input = el('link-input');
    input.value = project?.sourceLink || project?.videoUrl || '';
    input.focus();
}
function closeLinkDialog() { el('link-modal').hidden = true; }

function openPublicVeo() {
    const raw = el('link-input').value.trim();
    try {
        const link = new URL(raw);
        if (link.protocol !== 'https:' || link.hostname !== 'app.veo.co' || link.port ||
            link.username || link.password || !/^\/matches\/[A-Za-z0-9_-]+\/?$/.test(link.pathname)) {
            throw new Error('Use a public https://app.veo.co/matches/... link.');
        }
        window.open(link.toString(), '_blank', 'noopener,noreferrer');
    }
    catch {
        const status = el('veo-link-status');
        status.hidden = false;
        status.textContent = 'Paste a valid Veo match link first, then open it in a private browser window while signed out.';
    }
}
function isDirectVideoLink(value) {
    try {
        return /\.(mp4|m4v|mov|webm)$/i.test(new URL(value).pathname);
    }
    catch {
        return false;
    }
}
async function resumeVeoImport(id) {
    if (monitoringImportId || project?.id !== id)
        return;
    try {
        const status = await api(`/api/projects/${id}/veo-import`);
        if (status.status === 'running')
            void watchVeoImport(id);
    }
    catch { /* Older or temporarily unavailable server: the UI remains usable. */ }
}
function importProgress(status) {
    uploadScreen.hidden = false;
    text('upload-title', 'Importing Veo match');
    text('upload-file-label', status.phase || 'Contacting Veo');
    text('progress-label', `${(status.percent || 0).toFixed(1)}%`);
    el('progress-bar').style.width = `${Math.min(100, Math.max(0, status.percent || 0))}%`;
    text('upload-help', status.progressDetail
        ? `${status.progressDetail}. The full match is being saved locally; keep this page open.`
        : 'Connecting to the video service. The full match may be several GB; importing uses disk space and bandwidth.');
    el('cancel-veo-import').hidden = false;
}
async function watchVeoImport(id) {
    if (monitoringImportId)
        return;
    monitoringImportId = id;
    isUploading = true;
    let errors = 0;
    try {
        while (true) {
            let status;
            try {
                status = await api(`/api/projects/${id}/veo-import`);
                errors = 0;
            }
            catch (error) {
                if (++errors >= 5)
                    throw error;
                await new Promise((resolve) => setTimeout(resolve, 1300));
                continue;
            }
            if (status.status !== 'running') {
                if (status.status === 'completed')
                    notify('Veo footage imported and ready to analyse');
                else if (status.status === 'failed')
                    notify(status.error || 'Veo import failed', true);
                else if (status.status === 'cancelled')
                    notify('Veo import cancelled; existing video kept.');
                break;
            }
            importProgress(status);
            await new Promise((resolve) => setTimeout(resolve, 1300));
        }
    }
    catch (error) {
        notify(`Could not check Veo import: ${error.message}`, true);
    }
    finally {
        monitoringImportId = null;
        isUploading = false;
        uploadScreen.hidden = true;
        el('cancel-veo-import').hidden = true;
        if (project?.id === id)
            await selectProject(id);
    }
}
async function saveLink() {
    if (!project || isUploading)
        return;
    const raw = el('link-input').value.trim();
    const direct = isDirectVideoLink(raw);
const id = project.id;
    await saveNow();
    isUploading = true;
    const veoStatus = el('veo-link-status');
    el('save-link').disabled = true;
    try {
        if (!direct && document.querySelector('input[name="veo-mode"]:checked')?.value !== 'download') {
            veoStatus.hidden = false;
            veoStatus.textContent = 'Checking public video playback and seeking…';
            text('save-link', 'Checking Veo…');
            await api('/api/veo/preflight', { method: 'POST', body: JSON.stringify({ url: raw }) });
            veoStatus.textContent = '✓ Public recording found. Seeking is supported.';
        }
        if (hasFootage(project) && !confirm('The checked video is ready. Replace the previous match and clear its drawings, clips and playlists?')) return;
        if (direct) {
            await api(`/api/projects/${id}/video-url`, { method: 'PUT', body: JSON.stringify({ url: raw }) });
            closeLinkDialog();
            isUploading = false;
            await selectProject(id);
            notify('Direct video link added. Browser playback depends on the host.');
        }
        else {
            const mode = document.querySelector('input[name="veo-mode"]:checked')?.value || 'stream';
            if (mode === 'download') {
                await api(`/api/projects/${id}/veo-import`, { method: 'POST', body: JSON.stringify({ url: raw }) });
                closeLinkDialog();
                isUploading = false;
                void watchVeoImport(id);
            }
            else {
                text('save-link', 'Connecting…');
                await api(`/api/projects/${id}/veo-stream`, { method: 'POST', body: JSON.stringify({ url: raw }) });
                closeLinkDialog();
                isUploading = false;
                await selectProject(id);
                notify('Veo match added for instant streaming — no full download required');
            }
        }
    }
    catch (error) {
        veoStatus.hidden = false;
        veoStatus.textContent = 'Veo link could not be played: ' + error.message;
        isUploading = false;
        notify(`Could not import link: ${error.message}`, true);
    }
    finally {
        isUploading = false;
        el('save-link').disabled = false;
        text('save-link', 'Open match');
    }
}
async function removeSource() {
    if (!project || isUploading)
        return;
    const id = project.id;
    const veo = !!project.sourceLink;
    if (veo && project.remoteVideo && !confirm('Remove this streamed Veo recording and its annotations, clips and playlists? This cannot be undone.'))
        return;
    if (!veo && (!project.videoUrl || !confirm('Remove this linked video and its annotations, clips and playlists?')))
        return;
    await saveNow();
    isUploading = true;
    try {
        if (veo && project.remoteVideo)
            await api(`/api/projects/${id}/veo-stream`, { method: 'DELETE' });
        else if (veo)
            await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ sourceLink: null }) });
        else
            await api(`/api/projects/${id}/video-url`, { method: 'PUT', body: JSON.stringify({ url: null }) });
        isUploading = false;
        await selectProject(id);
        notify(veo ? 'Veo reference removed' : 'External video removed');
    }
    catch (error) {
        isUploading = false;
        notify(error.message, true);
    }
}
function openImport() { if (!isUploading)
    fileInput.click(); }
async function importFile(file) {
    if (!project || isUploading)
        return;
    const allowed = /\.(mp4|mov|m4v|webm)$/i.test(file.name);
    if (!allowed)
        return notify('Please select MP4, MOV, M4V or WebM footage.', true);
    if (!file.size || file.size > 8 * 1024 ** 3)
        return notify('Video must be between 1 byte and 8 GiB.', true);
    if ((hasFootage(project)) && !confirm('Replacing this video also clears its annotations, clips and playlists. Continue?'))
        return;
    await saveNow();
    isUploading = true;
    uploadScreen.hidden = false;
    text('upload-title', 'Importing match footage');
    text('upload-help', 'Keep this window open while the video is copied to local storage.');
    el('cancel-veo-import').hidden = true;
    text('upload-file-label', file.name + ' · ' + formatSize(file.size));
    text('progress-label', '0%');
    el('progress-bar').style.width = '0%';
    const projectId = project.id;
    try {
        await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', `/api/projects/${projectId}/video`);
            xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
            xhr.upload.onprogress = (event) => {
                if (event.lengthComputable) {
                    const percent = Math.min(100, Math.round((event.loaded / event.total) * 100));
                    text('progress-label', `${percent}%`);
                    el('progress-bar').style.width = `${percent}%`;
                }
            };
            xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300)
                    resolve();
                else {
                    let message = `Video import failed (${xhr.status})`;
                    try {
                        message = JSON.parse(xhr.responseText).error || message;
                    }
                    catch { }
                    reject(new Error(message));
                }
            };
            xhr.onerror = () => reject(new Error('Connection was lost during upload'));
            xhr.send(file); // Browser streams file bytes; no JS FileReader buffering.
        });
        isUploading = false;
        uploadScreen.hidden = true;
        await selectProject(projectId);
        notify('Match footage imported and stored locally');
    }
    catch (error) {
        isUploading = false;
        uploadScreen.hidden = true;
        notify(error.message, true);
    }
}
function undo() {
    if (!history.canUndo)
        return;
    history.undo();
    pruneOrphanedAutoFreezes();
    editor.setAnnotations(history.current);
    renderAll();
    markDirty();
}
function redo() {
    if (!history.canRedo)
        return;
    const prior = new Set(history.current.map(a => a.id));
    history.redo();
    for (const ann of history.current)
        if (!prior.has(ann.id))
            autoFreezeForAnnotation(ann.start);
    editor.setAnnotations(history.current);
    renderAll();
    markDirty();
}
function editableFocus() {
    const target = document.activeElement;
    return !!target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}
function registerEvents() {
    el('ai-detect').addEventListener('click', () => { if (!video.videoWidth)
        return notify('Video must finish loading before detection.', true); selectTool('select'); void runAi('detect', video.currentTime); });
    el('ai-clear').addEventListener('click', () => { clearAiCandidates(); aiInfo('Player selection cleared. Pause and select Detect players again.'); });
    el('ai-cancel').addEventListener('click', () => { if (activeAiJob)
        void api(`/api/ai-jobs/${activeAiJob}`, { method: 'DELETE' }).then(() => { activeAiJob = null; setAiBusy(false); aiInfo('AI analysis cancelled.'); }).catch(e => notify(e.message, true)); });
    el('add-freeze').addEventListener('click', addFreezeAtPlayhead);
    el('auto-freeze').addEventListener('change', e => { if (!project)
        return; project.autoFreezeAnnotations = e.target.checked; markDirty(); notify(project.autoFreezeAnnotations ? 'New drawings will create a 3-second freeze' : 'Automatic freeze disabled'); });
    el('quick-clip').addEventListener('click', () => quickSaveMoment(false));
    el('quick-tag').addEventListener('click', () => quickSaveMoment(true));
    el('add-zoom').addEventListener('click', addZoomAtPlayhead);
    el('insert-template').addEventListener('click', insertTacticalTemplate);
    el('add-keyframe').addEventListener('click', () => {
        if (!editor.selectedId)
            return;
        const a = history.current.find(x => x.id === editor.selectedId);
        if (!a || !['highlight', 'spotlight', 'ellipse', 'text'].includes(a.type))
            return notify('Select a player highlight or label first.', true);
        const now = Number(video.currentTime.toFixed(2));
        if (now < a.start || now > a.end)
            return notify('Extend this annotation’s start/end time before tracking at the current moment.', true);
        const posed = poseAt(a, now);
        updateSelected(a => ({ ...a, keyframes: [...(a.keyframes || [{ time: a.start, x: a.x1, y: a.y1 }]).filter(k => Math.abs(k.time - now) > .04), { time: now, x: posed.x1, y: posed.y1 }].sort((x, y) => x.time - y.time) }));
        notify('Tracking keyframe added. Advance the video and drag the highlight to its next position.');
    });
    el('tab-clips').addEventListener('click', () => showInspectorTab('clips'));
    el('tab-annotations').addEventListener('click', () => showInspectorTab('annotations'));
    el('mark-in').addEventListener('click', () => markPoint('in'));
    el('mark-out').addEventListener('click', () => markPoint('out'));
    for (const id of ['clip-in', 'clip-out']) {
        clipInput(id).addEventListener('input', renderTrimHint);
        clipInput(id).addEventListener('blur', () => { try {
            clipInput(id).value = formatClipClock(parseClipClock(clipInput(id).value));
        }
        catch { } renderTrimHint(); });
    }
    const preset = el('clip-preset');
    for (const item of CLIP_PRESETS) {
        const option = document.createElement('option');
        option.value = item.label;
        option.textContent = item.label;
        preset.append(option);
    }
    preset.addEventListener('change', () => {
        if (preset.value === 'custom') {
            clipInput('clip-title').value = '';
            clipInput('clip-title').focus();
            return;
        }
        const item = CLIP_PRESETS.find(e => e.label === preset.value);
        if (item) {
            clipInput('clip-title').value = item.label;
            clipInput('clip-category').value = item.category;
        }
    });
    el('start-export').addEventListener('click', () => { void startVideoExport(); });
    el('export-cancel').addEventListener('click', () => { if (exportJobId)
        void api(`/api/exports/${exportJobId}`, { method: 'DELETE' }).catch((e) => notify(e.message, true)); });
    el('preview-range').addEventListener('click', () => {
        try {
            const { start, end } = readClipRange();
            if (!project)
                return;
            const temp = { id: newId(), start, end, title: clipInput('clip-title').value.trim() || 'Preview', category: 'General', notes: '', createdAt: '', updatedAt: '' };
            // Preview does not create or persist a clip; uses an independent segment.
            previewClip = temp;
            activePlayback = { clipIds: [temp.id], index: 0, playlistId: null };
            void playActiveClip();
        }
        catch (error) {
            notify(error.message, true);
        }
    });
    el('reset-clip').addEventListener('click', () => { clearClipForm(); renderAll(); });
    el('save-clip').addEventListener('click', saveClip);
    clipInput('clip-filter').addEventListener('input', renderClipLibrary);
    el('create-playlist').addEventListener('click', createPlaylist);
    clipInput('playlist-title').addEventListener('keydown', (event) => { if (event.key === 'Enter')
        createPlaylist(); });
    el('playlist-select').addEventListener('change', (event) => { selectedPlaylistId = event.target.value || null; renderClipLibrary(); });
    el('play-playlist').addEventListener('click', () => { const p = selectedPlaylist(); if (p)
        playSequence(p.clipIds, 0, p.id); });
    el('stop-playlist').addEventListener('click', stopClipPlayback);
    el('rename-playlist').addEventListener('click', () => {
        const p = selectedPlaylist();
        if (!p)
            return;
        const name = prompt('Rename playlist', p.title)?.trim();
        if (!name)
            return;
        if (name.length > 100)
            return notify('Playlist title is too long.', true);
        updatePlaylist(p.id, p => ({ ...p, title: name }));
    });
    el('delete-playlist').addEventListener('click', () => {
        const p = selectedPlaylist();
        if (!project || !p || !confirm(`Delete playlist “${p.title}”? Saved clips will remain.`))
            return;
        if (activePlayback?.playlistId === p.id)
            stopClipPlayback();
        project.playlists = playlists().filter(item => item.id !== p.id);
        selectedPlaylistId = null;
        markDirty();
        renderClipLibrary();
        notify('Playlist deleted; clips were kept');
    });
    el('new-project').addEventListener('click', () => { void newProject(); });
    el('save-project').addEventListener('click', () => { void saveNow().then(() => notify('Project saved')); });
    for (const id of ['import-top', 'import-empty', 'attach-source'])
        el(id).addEventListener('click', openImport);
    for (const id of ['add-link', 'add-link-empty'])
        el(id).addEventListener('click', openLinkDialog);
    for (const id of ['close-link', 'cancel-link'])
        el(id).addEventListener('click', closeLinkDialog);
    el('link-form').addEventListener('submit', (event) => { event.preventDefault(); void saveLink(); });
    el('open-public-veo').addEventListener('click', openPublicVeo);
    el('open-source').addEventListener('click', () => { if (project?.sourceLink)
        window.open(project.sourceLink, '_blank', 'noopener,noreferrer'); });
    el('remove-source').addEventListener('click', () => { void removeSource(); });
    el('cancel-veo-import').addEventListener('click', () => {
        if (monitoringImportId)
            void api(`/api/projects/${monitoringImportId}/veo-import`, { method: 'DELETE' })
                .then(() => text('upload-file-label', 'Cancelling import…'))
                .catch((error) => notify(error.message, true));
    });
    el('link-modal').addEventListener('click', (event) => { if (event.target === el('link-modal') && !isUploading)
        closeLinkDialog(); });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !el('link-modal').hidden && !isUploading)
        closeLinkDialog(); });
    fileInput.addEventListener('change', () => { if (fileInput.files?.[0])
        void importFile(fileInput.files[0]); fileInput.value = ''; });
    titleInput.addEventListener('input', () => { if (project) {
        project.title = titleInput.value;
        renderProjects();
        markDirty();
    } });
    overlay.addEventListener('touchline-toolchange', () => selectTool('select'));
    document.querySelectorAll('[data-tool]').forEach((button) => {
        button.addEventListener('click', () => selectTool(button.dataset.tool));
    });
    const refreshColors = () => renderColors('color-tools', editor.color, (color) => { editor.color = color; refreshColors(); });
    refreshColors();
    el('play').addEventListener('click', () => { if (inFreeze) {
        cancelFreeze();
        return;
    } void (video.paused ? video.play().catch(() => notify('Video cannot be decoded by this browser', true)) : Promise.resolve(video.pause())); });
    el('back-5').addEventListener('click', () => seekVideo(video.currentTime - 5));
    el('forward-5').addEventListener('click', () => seekVideo(video.currentTime + 5));
    el('frame-back').addEventListener('click', () => { video.pause(); seekVideo(video.currentTime - 1 / 25); });
    el('frame-next').addEventListener('click', () => { video.pause(); seekVideo(video.currentTime + 1 / 25); });
    el('play-speed').addEventListener('change', (event) => { video.playbackRate = Number(event.target.value); });
    seek.addEventListener('input', () => { const duration = video.duration; if (Number.isFinite(duration))
        seekVideo((Number(seek.value) / 1000) * duration); });
    video.addEventListener('loadedmetadata', () => {
        if (!project || !hasFootage(project))
            return;
        const ratio = video.videoWidth / video.videoHeight;
        if (Number.isFinite(ratio) && ratio > 0) {
            frame.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
            editor.setVideoInfo(true, ratio, video.duration);
            text('resolution', `${video.videoWidth} × ${video.videoHeight}`);
        }
        if (Number.isFinite(video.duration) && video.duration > 0 && Math.abs((project.duration || 0) - video.duration) > 0.01) {
            project.duration = video.duration;
            markDirty();
        }
        updatePlayback();
        renderTimelineMarkers();
        renderClipLibrary();
    });
    video.addEventListener('timeupdate', updatePlayback);
    video.addEventListener('seeked', () => { if (!inFreeze)
        lastPlaybackTime = video.currentTime; });
    video.addEventListener('ended', () => {
        if (!activePlayback)
            return;
        if (activePlayback.index + 1 < activePlayback.clipIds.length) {
            activePlayback.index++;
            void playActiveClip();
        }
        else {
            activePlayback = null;
            previewClip = null;
            text('clip-status', 'Clip / playlist finished');
            renderClipLibrary();
        }
    });
    video.addEventListener('play', () => { clearAiCandidates(); updatePlayback(); });
    video.addEventListener('pause', updatePlayback);
    video.addEventListener('error', () => {
        if (project?.remoteVideo)
            notify('Veo streaming failed. Check internet access and that yt-dlp can resolve this match. Try reconnecting or use Download full match.', true);
        else if (project?.videoUrl)
            notify('External video could not play. The host may block playback, the link may have expired, or the codec is unsupported. Import a local MP4 instead.', true);
        else if (project?.video)
            notify('Unable to play this codec in your browser. Convert to H.264 MP4 with FFmpeg.', true);
    });
    el('undo').addEventListener('click', undo);
    el('redo').addEventListener('click', redo);
    propText.addEventListener('change', () => { updateSelected((a) => ({ ...a, text: propText.value.slice(0, 120) })); });
    propWidth.addEventListener('change', () => { updateSelected((a) => ({ ...a, width: Number(propWidth.value) })); });
    propWidth.addEventListener('input', () => text('width-label', `${propWidth.value}px`));
    propStart.addEventListener('change', () => {
        let value;
        try {
            value = parseClipClock(propStart.value);
        }
        catch {
            return renderProperties(editor.selectedId);
        }
        if (!Number.isFinite(value) || value < 0)
            return renderProperties(editor.selectedId);
        updateSelected((a) => { const start = Math.min(value, a.end); return { ...a, start, keyframes: a.keyframes?.filter(k => k.time >= start) }; });
    });
    propEnd.addEventListener('change', () => {
        let value;
        try {
            value = parseClipClock(propEnd.value);
        }
        catch {
            return renderProperties(editor.selectedId);
        }
        if (!Number.isFinite(value) || value < 0)
            return renderProperties(editor.selectedId);
        updateSelected((a) => { const end = Math.max(a.start, value); return { ...a, end, keyframes: a.keyframes?.filter(k => k.time <= end) }; });
    });
    el('prop-fade').addEventListener('input', e => text('fade-label', `${e.target.value}s`));
    el('prop-fade').addEventListener('change', e => updateSelected(a => ({ ...a, fade: Number(e.target.value) })));
    el('prop-bend').addEventListener('change', e => updateSelected(a => ({ ...a, bend: Number(e.target.value) })));
    el('delete-annotation').addEventListener('click', () => {
        if (!editor.selectedId)
            return;
        history.commit(history.current.filter((a) => a.id !== editor.selectedId));
        pruneOrphanedAutoFreezes();
        editor.setSelected(null);
        editor.setAnnotations(history.current);
        renderAll();
        markDirty();
    });
    window.addEventListener('keydown', (event) => {
        if (editableFocus())
            return;
        const command = event.metaKey || event.ctrlKey;
        if (command && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey)
                redo();
            else
                undo();
            return;
        }
        if (!command && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            quickSaveMoment(false);
            return;
        }
        if (!command && event.key.toLowerCase() === 'g') {
            event.preventDefault();
            quickSaveMoment(true);
            return;
        }
        if (!command && event.key.toLowerCase() === 'i') {
            event.preventDefault();
            markPoint('in');
            return;
        }
        if (!command && event.key.toLowerCase() === 'o') {
            event.preventDefault();
            markPoint('out');
            return;
        }
        if (!command && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            addFreezeAtPlayhead();
            return;
        }
        if (event.key === ' ' && (hasFootage(project))) {
            event.preventDefault();
            el('play').click();
            return;
        }
        if (event.key === 'ArrowRight') {
            event.preventDefault();
            seekVideo(video.currentTime + 5);
            return;
        }
        if (event.key === 'ArrowLeft') {
            event.preventDefault();
            seekVideo(video.currentTime - 5);
            return;
        }
        if (['Delete', 'Backspace'].includes(event.key) && editor.selectedId) {
            event.preventDefault();
            el('delete-annotation').click();
            return;
        }
        const shortcuts = { v: 'select', a: 'arrow', l: 'line', r: 'rect', c: 'ellipse', p: 'pen', t: 'text', h: 'highlight', s: 'spotlight' };
        if (!command && shortcuts[event.key.toLowerCase()])
            selectTool(shortcuts[event.key.toLowerCase()]);
    });
    window.addEventListener('beforeunload', (event) => { if (dirty || isUploading) {
        event.preventDefault();
        event.returnValue = '';
    } });
}
async function init() {
    registerEvents();
    try {
        projects = await api('/api/projects');
        if (projects.length)
            await selectProject(projects[0].id);
        else {
            const created = await api('/api/projects', { method: 'POST', body: JSON.stringify({ title: 'Untitled analysis' }) });
            projects = [created];
            await selectProject(created.id);
        }
    }
    catch (error) {
        notify(`Unable to initialise the application: ${error.message}`, true);
    }
}
void init();
