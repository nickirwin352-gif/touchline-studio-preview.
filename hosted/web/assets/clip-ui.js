/** UI timecode is minutes:seconds, while the saved project keeps numeric seconds. */
export function formatClipClock(seconds) {
    const whole = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
    return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
export function parseClipClock(raw) {
    const value = raw.trim();
    const parts = value.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^\d{1,3}$/.test(p)))
        throw new Error('Use MM:SS (for example 12:35), or HH:MM:SS.');
    const numbers = parts.map(Number);
    if (numbers.at(-1) >= 60 || (parts.length === 3 && numbers[1] >= 60))
        throw new Error('Seconds must be below 60. Use MM:SS.');
    const seconds = parts.length === 2 ? numbers[0] * 60 + numbers[1] : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
    if (seconds > 86400)
        throw new Error('Time must be within 24 hours.');
    return seconds;
}
export const CLIP_PRESETS = [
    { label: 'Pass', category: 'Passing' }, { label: 'Key pass', category: 'Passing' },
    { label: 'Through ball', category: 'Passing' }, { label: 'Cross', category: 'Passing' },
    { label: 'Build-up play', category: 'Attacking' }, { label: 'Shot on target', category: 'Shot' },
    { label: 'Shot off target', category: 'Shot' }, { label: 'Goal', category: 'Goal' },
    { label: 'Chance created', category: 'Attacking' }, { label: 'Counterattack', category: 'Transition' },
    { label: 'Attacking transition', category: 'Transition' }, { label: 'Defensive transition', category: 'Transition' },
    { label: 'High press', category: 'Pressing' }, { label: 'Counterpress', category: 'Pressing' },
    { label: 'Pressing trigger', category: 'Pressing' }, { label: 'Interception', category: 'Defending' },
    { label: 'Tackle', category: 'Defending' }, { label: 'Defensive recovery', category: 'Defending' },
    { label: '1v1 duel', category: 'Duels' }, { label: 'Turnover', category: 'Transition' },
    { label: 'Corner', category: 'Set piece' }, { label: 'Free kick', category: 'Set piece' },
    { label: 'Penalty', category: 'Set piece' }, { label: 'Goalkeeper save', category: 'Goalkeeping' },
    { label: 'Goalkeeper distribution', category: 'Goalkeeping' },
    { label: 'Player highlight', category: 'Individual' },
];
/** A quick clip is ten seconds around the selected event, trimmed at match boundaries. */
export function quickClipRange(playhead, duration, padding = 5) {
    if (!Number.isFinite(playhead) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(padding) || padding <= 0) {
        throw new Error('Wait until the video duration is available before tagging a moment.');
    }
    const point = Math.max(0, Math.min(playhead, duration));
    return { start: Math.max(0, point - padding), end: Math.min(duration, point + padding) };
}
