// Motion layer on top of morph(): entrance classes, text scramble, number flip,
// chip width morphing and exit animations. Timings follow NEXT_PHASE_DESIGN.md §9.2/§15.3.
import { morph } from './morph';

const EASE = 'cubic-bezier(.2,.8,.2,1)';
const SCRAMBLE_MS = 420;
const ENTER_MS: Record<string, number> = { card: 1500, narration: 1400, row: 1300 };
const GLYPHS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function reducedMotion(root: Element): boolean {
    return root.closest('.m-reduce') !== null
        || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

const scrambles = new WeakMap<Element, { token: number; target: string; running: boolean }>();
/** Random glyphs resolving left to right into the final text (video 4.0s, 5.5s, 27.0s). */
export function scramble(el: Element, random = Math.random): void {
    const target = el.textContent ?? '';
    if (!target.trim()) return;
    const prev = scrambles.get(el);
    // A morph during a running scramble rewrites the final text; keep going instead of restarting.
    if (prev?.running && prev.target === target) return;
    const token = (prev?.token ?? 0) + 1;
    const state = { token, target, running: true };
    scrambles.set(el, state);
    const start = performance.now();
    const tick = (now: number) => {
        if (scrambles.get(el)?.token !== token) return;
        const p = Math.min(1, (now - start) / SCRAMBLE_MS);
        const fixed = Math.floor(p * target.length);
        let text = target.slice(0, fixed);
        for (let i = fixed; i < target.length; i++)
            text += /\s/.test(target[i]) ? target[i] : GLYPHS[Math.floor(random() * GLYPHS.length)];
        el.textContent = text;
        if (p < 1) requestAnimationFrame(tick);
        else { el.textContent = target; state.running = false; }
    };
    requestAnimationFrame(tick);
}

function enterKind(el: Element): string {
    if (el.classList.contains('gg-card')) return 'card';
    if (el.classList.contains('gg-narration')) return 'narration';
    if (el.classList.contains('gg-row')) return 'row';
    return 'other';
}

/** Apply one frame of HTML to `root` with motion. */
export function applyFrame(root: Element, html: string): void {
    const reduce = reducedMotion(root);
    const widths = new Map<string, number>();
    for (const el of Array.from(root.querySelectorAll('[data-wmorph]')))
        widths.set(el.getAttribute('data-key') ?? '', el.getBoundingClientRect().width);

    const { inserted, changed, exiting } = morph(root, html);
    if (reduce) {
        for (const el of exiting) el.remove();
        return;
    }
    for (const el of inserted) {
        const kind = enterKind(el);
        el.classList.add('m-enter');
        setTimeout(() => el.classList.remove('m-enter'), ENTER_MS[kind] ?? 700);
        // Rows that appear inside an existing card decode their text; a new card
        // grows bottom-up instead (video 2.5s).
        if (kind !== 'card' && !el.closest('.gg-thread.is-idle'))
            for (const target of [el, ...Array.from(el.querySelectorAll('[data-scramble]'))])
                if (target.hasAttribute('data-scramble')) scramble(target);
    }
    for (const el of changed) {
        const scrambled = el.closest('[data-scramble]');
        if (scrambled) { scramble(scrambled); continue; }
        const num = el.closest('[data-num]');
        if (num) num.animate([{ transform: 'translateY(45%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 200, easing: EASE });
    }
    for (const el of Array.from(root.querySelectorAll('[data-wmorph]'))) {
        const before = widths.get(el.getAttribute('data-key') ?? '');
        const after = el.getBoundingClientRect().width;
        if (before && Math.abs(before - after) > 0.5 && !el.hasAttribute('data-exiting'))
            el.animate([{ width: `${before}px` }, { width: `${after}px` }], { duration: 240, easing: EASE });
    }
    for (const el of exiting) {
        const width = el.getBoundingClientRect().width;
        el.animate([{ width: `${width}px`, opacity: 1 }, { width: '0px', opacity: 0, paddingLeft: '0px', paddingRight: '0px', marginRight: '-6px' }],
            { duration: 260, easing: EASE, fill: 'forwards' }).finished.then(() => el.remove(), () => el.remove());
    }
}
