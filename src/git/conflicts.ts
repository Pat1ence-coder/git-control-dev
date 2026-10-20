import type { Hunk, Strategy } from '../shared/protocol';
import { containsConflictMarkers } from './conflictMarkers';
export function parseConflict(text: string): Hunk[] {
    const lines = text.split(/\r?\n/);
    const result: Hunk[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^<{7}(?: |$)/.test(lines[i]))
            continue;
        const start = i;
        let divider = -1;
        let base = -1;
        let end = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (/^<{7}(?: |$)/.test(lines[j]))
                break;
            if (/^\|{7}(?: |$)/.test(lines[j]) && divider < 0)
                base = j;
            if (/^={7}\s*$/.test(lines[j]) && divider < 0)
                divider = j;
            if (/^>{7}(?: |$)/.test(lines[j]) && divider >= 0) {
                end = j;
                break;
            }
        }
        if (end < 0)
            continue;
        result.push({ start, end, current: lines.slice(start + 1, base >= 0 ? base : divider).join('\n'), incoming: lines.slice(divider + 1, end).join('\n'), currentLabel: lines[start].slice(7).trim() || '当前', incomingLabel: lines[end].slice(7).trim() || '传入' });
        i = end;
    }
    return result;
}
export const hasConflictMarkers = containsConflictMarkers;
function divergent(left: string[], right: string[]): string[] { const seen = new Set(left.map(s => s.trim())); return [...left, ...right.filter(s => s.trim() && !seen.has(s.trim()))]; }
export function heuristicMerge(current: string, incoming: string): string {
    const a = current.split('\n'), b = incoming.split('\n'), out: string[] = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            out.push(a[i++]);
            j++;
            continue;
        }
        let sync: [
            number,
            number
        ] | undefined;
        for (let cost = 1; cost <= 14 && !sync; cost++)
            for (let x = 0; x < 8; x++) {
                const y = cost - x;
                if (y >= 0 && y < 8 && i + x < a.length && j + y < b.length && a[i + x].trim() && a[i + x] === b[j + y]) {
                    sync = [x, y];
                    break;
                }
            }
        if (!sync)
            break;
        out.push(...divergent(a.slice(i, i + sync[0]), b.slice(j, j + sync[1])));
        i += sync[0];
        j += sync[1];
    }
    out.push(...divergent(a.slice(i), b.slice(j)));
    return out.join('\n');
}
export function applyResolution(text: string, strategy: Strategy): {
    text: string;
    applied: boolean;
} {
    const hunks = parseConflict(text);
    if (!hunks.length)
        return { text, applied: false };
    const lines = text.split(/\r?\n/);
    for (const h of [...hunks].reverse()) {
        const both = [h.current, h.incoming].filter(Boolean).join('\n');
        const result = strategy === 'current' ? h.current : strategy === 'incoming' ? h.incoming : strategy === 'both' ? both : heuristicMerge(h.current, h.incoming) || both;
        lines.splice(h.start, h.end - h.start + 1, ...(result ? result.split('\n') : []));
    }
    return { text: lines.join(text.includes('\r\n') ? '\r\n' : '\n'), applied: true };
}
