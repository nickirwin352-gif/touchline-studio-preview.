export const COLORS = ['#b7ff66', '#5bd8f5', '#ffffff', '#ffcb63', '#fb6d8a'];
export const TOOL_NAMES = { select: 'Select / move', arrow: 'Arrow', line: 'Line', rect: 'Rectangle', ellipse: 'Circle / oval', text: 'Label', pen: 'Freehand', highlight: 'Player highlight', spotlight: 'Spotlight', curve: 'Curved arrow', zone: 'Tactical zone', footmarker: 'AI-tracked foot marker' };
export function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const clamp = (number, low, high) => Math.min(high, Math.max(low, number));
export function timecode(seconds) {
    const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor((value % 3600) / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
export function isVisible(annotation, current) {
    return current >= annotation.start - 0.0001 && current <= annotation.end + 0.0001;
}
export function translate(a, dx, dy) {
    // Move the entire shape while preserving its geometry and staying in frame.
    const xs = [a.x1, a.x2, ...a.points.map((p) => p.x)];
    const ys = [a.y1, a.y2, ...a.points.map((p) => p.y)];
    const x = clamp(dx, -Math.min(...xs), 1 - Math.max(...xs));
    const y = clamp(dy, -Math.min(...ys), 1 - Math.max(...ys));
    return { ...a, x1: a.x1 + x, y1: a.y1 + y, x2: a.x2 + x, y2: a.y2 + y, points: a.points.map((p) => ({ x: p.x + x, y: p.y + y })) };
}
export function poseAt(a, time) {
    const keys = a.keyframes;
    if (!keys?.length)
        return a;
    const sorted = [...keys].sort((x, y) => x.time - y.time);
    let x = sorted[0].x, y = sorted[0].y;
    if (time >= sorted[sorted.length - 1].time) {
        x = sorted[sorted.length - 1].x;
        y = sorted[sorted.length - 1].y;
    }
    else
        for (let i = 1; i < sorted.length; i++) {
            if (time <= sorted[i].time) {
                const a0 = sorted[i - 1], a1 = sorted[i];
                const ratio = clamp((time - a0.time) / Math.max(.00001, a1.time - a0.time), 0, 1);
                x = a0.x + (a1.x - a0.x) * ratio;
                y = a0.y + (a1.y - a0.y) * ratio;
                break;
            }
        }
    return translate({ ...a, keyframes: undefined }, x - a.x1, y - a.y1);
}
export function opacityAt(a, time) {
    const fade = Math.max(0, a.fade || 0);
    if (!fade || time < a.start || time > a.end)
        return 1;
    return clamp(Math.min((time - a.start) / fade, (a.end - time) / fade), 0, 1);
}
export function makeAnnotation(type, p, current, duration, color, width = 4) {
    const end = duration && current + 4 > duration ? Math.max(current, duration) : current + 4;
    const radius = type === 'highlight' ? 0.052 : type === 'spotlight' ? 0.11 : 0;
    return { id: newId(), type, x1: clamp(p.x - radius, 0, 1), y1: clamp(p.y - radius, 0, 1), x2: clamp(p.x + radius, 0, 1), y2: clamp(p.y + radius, 0, 1), points: type === 'pen' ? [p] : [], text: type === 'text' ? 'Player label' : '', color, width, start: current, end, fade: 0 };
}
export function copyAnnotation(a) { return { ...a, points: a.points.map((p) => ({ ...p })), keyframes: a.keyframes?.map(k => ({ ...k })) }; }
export class History {
    past = [];
    future = [];
    current = [];
    constructor(initial = []) { this.reset(initial); }
    reset(initial = []) {
        this.current = structuredClone(initial);
        this.past = [];
        this.future = [];
    }
    commit(next) {
        if (JSON.stringify(next) === JSON.stringify(this.current))
            return;
        this.past.push(structuredClone(this.current));
        if (this.past.length > 60)
            this.past.shift();
        this.current = structuredClone(next);
        this.future = [];
    }
    undo() {
        if (!this.past.length)
            return this.current;
        this.future.push(structuredClone(this.current));
        this.current = this.past.pop();
        return this.current;
    }
    redo() {
        if (!this.future.length)
            return this.current;
        this.past.push(structuredClone(this.current));
        this.current = this.future.pop();
        return this.current;
    }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
}
