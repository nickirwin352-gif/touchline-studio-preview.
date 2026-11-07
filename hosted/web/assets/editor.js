import { clamp, copyAnnotation, isVisible, makeAnnotation, opacityAt, poseAt, translate } from './model.js';
const NS = 'http://www.w3.org/2000/svg';
const C = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, String(value));
    return node;
};
function add(parent, child) { parent.appendChild(child); return child; }
export class TacticalEditor {
    tool = 'select';
    color = '#b7ff66';
    strokeWidth = 4;
    annotations = [];
    selectedId = null;
    currentTime = 0;
    duration = null;
    enabled = false;
    aspect = 16 / 9;
    session = null;
    preview = null;
    svg;
    onCommit;
    onSelect;
    constructor(svg, onCommit, onSelect) {
        this.svg = svg;
        this.onCommit = onCommit;
        this.onSelect = onSelect;
        svg.addEventListener('pointerdown', (event) => this.pointerDown(event));
        svg.addEventListener('pointermove', (event) => this.pointerMove(event));
        svg.addEventListener('pointerup', (event) => this.pointerUp(event));
        svg.addEventListener('pointercancel', () => this.cancel());
        this.render();
    }
    setAnnotations(annotations) { this.annotations = annotations; this.render(); }
    setSelected(id) { this.selectedId = id; this.render(); this.onSelect(id); }
    setTool(tool) { this.tool = tool; this.render(); }
    setTime(time) { this.currentTime = time; this.render(); }
    setVideoInfo(enabled, aspect, duration) {
        this.enabled = enabled;
        this.aspect = aspect > 0 ? aspect : 16 / 9;
        this.duration = duration;
        this.render();
    }
    point(event) {
        const box = this.svg.getBoundingClientRect();
        return { x: clamp((event.clientX - box.left) / box.width, 0, 1), y: clamp((event.clientY - box.top) / box.height, 0, 1) };
    }
    pointerDown(event) {
        if (!this.enabled || event.button !== 0)
            return;
        const point = this.point(event);
        const target = event.target;
        if (this.tool === 'select') {
            const item = target.closest('[data-shape-id]');
            const id = item?.getAttribute('data-shape-id') || null;
            const annotation = this.annotations.find((a) => a.id === id);
            this.setSelected(annotation?.id || null);
            if (!annotation)
                return;
            const handle = target.getAttribute('data-handle');
            this.session = { mode: handle ? 'resize' : 'move', start: point, initial: copyAnnotation(annotation), handle: handle || undefined, moved: false };
        }
        else {
            const annotation = makeAnnotation(this.tool, point, this.currentTime, this.duration, this.color, this.strokeWidth);
            if (annotation.type === 'highlight' || annotation.type === 'spotlight') {
                const radius = annotation.type === 'highlight' ? .047 : .092;
                annotation.x1 = clamp(point.x - radius, 0, 1);
                annotation.x2 = clamp(point.x + radius, 0, 1);
                annotation.y1 = clamp(point.y - radius * this.aspect, 0, 1);
                annotation.y2 = clamp(point.y + radius * this.aspect, 0, 1);
            }
            if (['text', 'highlight', 'spotlight'].includes(annotation.type)) {
                this.onCommit([...this.annotations, annotation]);
                this.tool = 'select';
                this.svg.dispatchEvent(new CustomEvent('touchline-toolchange', { detail: 'select' }));
                this.setSelected(annotation.id);
                return;
            }
            this.setSelected(null);
            this.session = { mode: 'draw', start: point, initial: annotation, moved: false };
            this.preview = annotation;
        }
        this.svg.setPointerCapture(event.pointerId);
        event.preventDefault();
    }
    pointerMove(event) {
        if (!this.session)
            return;
        const s = this.session;
        const p = this.point(event);
        if (Math.abs(p.x - s.start.x) > 0.001 || Math.abs(p.y - s.start.y) > 0.001)
            s.moved = true;
        let next = copyAnnotation(s.initial);
        if (s.mode === 'draw') {
            next.x2 = p.x;
            next.y2 = p.y;
            if (next.type === 'pen') {
                const prior = this.preview?.points || [s.start];
                next.points = [...prior, p].slice(0, 4000);
            }
        }
        else if (s.mode === 'move') {
            const shifted = translate(poseAt(next, this.currentTime), p.x - s.start.x, p.y - s.start.y);
            if (next.keyframes?.length) {
                const keys = next.keyframes.filter(k => Math.abs(k.time - this.currentTime) > .04);
                next = { ...next, keyframes: [...keys, { time: this.currentTime, x: shifted.x1, y: shifted.y1 }].sort((a, b) => a.time - b.time) };
            }
            else
                next = shifted;
        }
        else if (s.mode === 'resize') {
            if (s.handle === 'start') {
                next.x1 = p.x;
                next.y1 = p.y;
            }
            else {
                next.x2 = p.x;
                next.y2 = p.y;
            }
        }
        this.preview = next;
        this.render();
        event.preventDefault();
    }
    pointerUp(event) {
        if (!this.session)
            return;
        const s = this.session;
        let result = this.preview || s.initial;
        if (s.mode === 'draw' && !s.moved) {
            result = { ...result, x2: clamp(s.start.x + 0.1, 0, 1), y2: clamp(s.start.y + 0.08, 0, 1) };
            if (result.type === 'pen')
                result.points = [s.start, { x: result.x2, y: result.y2 }];
        }
        if (s.mode === 'draw')
            this.onCommit([...this.annotations, result]);
        else if (s.moved)
            this.onCommit(this.annotations.map((a) => a.id === s.initial.id ? result : a));
        this.session = null;
        this.preview = null;
        if (this.svg.hasPointerCapture(event.pointerId))
            this.svg.releasePointerCapture(event.pointerId);
        this.render();
    }
    cancel() { this.session = null; this.preview = null; this.render(); }
    render() {
        const H = 1000 / this.aspect;
        this.svg.setAttribute('viewBox', `0 0 1000 ${H}`);
        this.svg.style.pointerEvents = this.enabled ? 'auto' : 'none';
        this.svg.style.cursor = this.tool === 'select' ? 'default' : 'crosshair';
        this.svg.replaceChildren();
        const visible = this.annotations.filter((a) => isVisible(a, this.currentTime));
        for (const ann of visible) {
            const a = this.preview?.id === ann.id ? this.preview : ann;
            this.svg.appendChild(this.shape(poseAt(a, this.currentTime), H, false, opacityAt(a, this.currentTime)));
        }
        if (this.session?.mode === 'draw' && this.preview)
            this.svg.appendChild(this.shape(this.preview, H, true));
        if (this.tool === 'select' && this.selectedId) {
            const selected = (this.preview?.id === this.selectedId ? this.preview : visible.find((a) => a.id === this.selectedId));
            if (selected)
                this.drawHandles(poseAt(selected, this.currentTime), H);
        }
    }
    shape(a, H, draft = false, opacity = 1) {
        const g = C('g', { 'data-shape-id': a.id, opacity: draft ? 0.78 : opacity });
        const X = (n) => n * 1000;
        const Y = (n) => n * H;
        const x1 = X(a.x1), y1 = Y(a.y1), x2 = X(a.x2), y2 = Y(a.y2);
        const stroke = { stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
        if (a.type === 'arrow' || a.type === 'line') {
            add(g, C('line', { x1, y1, x2, y2, ...stroke }));
            add(g, C('line', { x1, y1, x2, y2, stroke: 'transparent', 'stroke-width': 22, 'pointer-events': 'stroke' }));
            if (a.type === 'arrow') {
                const angle = Math.atan2(y2 - y1, x2 - x1);
                const len = Math.max(16, a.width * 4);
                const left = `${x2 - len * Math.cos(angle - Math.PI / 6)},${y2 - len * Math.sin(angle - Math.PI / 6)}`;
                const right = `${x2 - len * Math.cos(angle + Math.PI / 6)},${y2 - len * Math.sin(angle + Math.PI / 6)}`;
                add(g, C('polyline', { points: `${left} ${x2},${y2} ${right}`, fill: 'none', ...stroke }));
            }
        }
        else if (a.type === 'curve') {
            const cx = (x1 + x2) / 2 + (y2 - y1) * Number(a.bend ?? -.18);
            const cy = (y1 + y2) / 2 - (x2 - x1) * Number(a.bend ?? -.18);
            const path = `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
            add(g, C('path', { d: path, fill: 'none', ...stroke }));
            add(g, C('path', { d: path, fill: 'none', stroke: 'transparent', 'stroke-width': 23, 'pointer-events': 'stroke' }));
            const angle = Math.atan2(y2 - cy, x2 - cx);
            const len = Math.max(16, a.width * 4);
            add(g, C('polyline', { points: `${x2 - len * Math.cos(angle - .5)},${y2 - len * Math.sin(angle - .5)} ${x2},${y2} ${x2 - len * Math.cos(angle + .5)},${y2 - len * Math.sin(angle + .5)}`, fill: 'none', ...stroke }));
        }
        else if (a.type === 'zone') {
            add(g, C('rect', { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rx: 7, fill: a.color, 'fill-opacity': .18, ...stroke, 'stroke-dasharray': '12 7' }));
        }
        else if (a.type === 'footmarker') {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.max(9, Math.abs(x2 - x1) / 2), ry = Math.max(6, Math.abs(y2 - y1) / 2);
            add(g, C('ellipse', { cx, cy, rx, ry, fill: a.color, 'fill-opacity': .20, ...stroke }));
            add(g, C('circle', { cx, cy, r: 3.2, fill: '#ffffff', 'pointer-events': 'none' }));
        }
        else if (a.type === 'highlight') {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.max(18, Math.abs(x2 - x1) / 2), ry = Math.max(18, Math.abs(y2 - y1) / 2);
            add(g, C('ellipse', { cx, cy, rx, ry, fill: a.color, 'fill-opacity': .06, ...stroke }));
        }
        else if (a.type === 'spotlight') {
            const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.max(28, Math.abs(x2 - x1) / 2), ry = Math.max(28, Math.abs(y2 - y1) / 2);
            const maskId = `spot-${a.id.replace(/[^a-z0-9]/gi, '')}`;
            const defs = add(g, C('defs'));
            const mask = add(defs, C('mask', { id: maskId }));
            add(mask, C('rect', { width: 1000, height: H, fill: 'white' }));
            add(mask, C('ellipse', { cx, cy, rx, ry, fill: 'black' }));
            add(g, C('rect', { width: 1000, height: H, fill: '#000000', 'fill-opacity': .65, mask: `url(#${maskId})`, 'pointer-events': 'none' }));
            add(g, C('ellipse', { cx, cy, rx, ry, fill: 'transparent', ...stroke }));
        }
        else if (a.type === 'rect') {
            add(g, C('rect', { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1), rx: 3, fill: 'transparent', ...stroke }));
        }
        else if (a.type === 'ellipse') {
            add(g, C('ellipse', { cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, rx: Math.abs(x2 - x1) / 2, ry: Math.abs(y2 - y1) / 2, fill: 'transparent', ...stroke }));
        }
        else if (a.type === 'text') {
            const t = C('text', { x: x1, y: y1, fill: a.color, 'font-size': 18 + a.width * 4, 'font-weight': 750, 'paint-order': 'stroke', stroke: '#0a1016', 'stroke-width': 5, 'stroke-linejoin': 'round' });
            t.textContent = a.text || 'Label';
            add(g, t);
        }
        else if (a.type === 'pen' && a.points.length) {
            add(g, C('polyline', { points: a.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' '), fill: 'none', ...stroke }));
            add(g, C('polyline', { points: a.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(' '), fill: 'none', stroke: 'transparent', 'stroke-width': 22, 'pointer-events': 'stroke' }));
        }
        return g;
    }
    drawHandles(a, H) {
        const group = C('g', { 'data-shape-id': a.id });
        const anchors = a.type === 'text' || a.type === 'pen' ? [] : [{ name: 'start', x: a.x1 * 1000, y: a.y1 * H }, { name: 'end', x: a.x2 * 1000, y: a.y2 * H }];
        if (a.type !== 'text' && a.type !== 'pen') {
            const x = Math.min(a.x1, a.x2) * 1000, y = Math.min(a.y1, a.y2) * H;
            const w = Math.abs(a.x2 - a.x1) * 1000, h = Math.abs(a.y2 - a.y1) * H;
            if (['rect', 'ellipse', 'highlight', 'spotlight', 'zone', 'footmarker'].includes(a.type))
                add(group, C('rect', { x, y, width: w, height: h, fill: 'none', stroke: '#fff', 'stroke-dasharray': '5 7', 'stroke-width': 1.5, opacity: 0.65, 'pointer-events': 'none' }));
        }
        for (const point of anchors)
            add(group, C('circle', { cx: point.x, cy: point.y, r: 8, fill: '#fff', stroke: '#17212c', 'stroke-width': 2, 'data-handle': point.name, style: 'cursor:crosshair' }));
        this.svg.appendChild(group);
    }
}
