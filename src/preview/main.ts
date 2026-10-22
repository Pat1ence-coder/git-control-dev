// Dev-only preview of the thread UI. Never bundled into the extension.
//   /                         play the ref video flow (click "Create PR" or ▶)
//   /?state=<fixture>         one reference fixture, no motion (for screenshots)
//   /?t=<ms>                  timeline frame at t, no motion
//   &popover=1                keep the conflict popover open
import { renderThread } from '../webview/thread/render';
import { applyFrame } from '../webview/thread/motion';
import { buildTimeline } from './timeline';
import { refFixtures, REF_NOW } from '../test/fixtures/refFig';
import type { ThreadFrame } from '../shared/thread';

const stage = document.getElementById('stage')!;
const bar = document.getElementById('bar')!;
const steps = buildTimeline();
const params = new URLSearchParams(location.search);

function show(frame: ThreadFrame): void { applyFrame(stage, renderThread(frame)); }

function staticMode(): boolean {
    const state = params.get('state'), t = params.get('t');
    if (state === null && t === null) return false;
    stage.classList.add('m-reduce');
    document.body.classList.add('is-static');
    let frame: ThreadFrame | undefined;
    if (state !== null) {
        const fx = refFixtures.find(f => f.name === state) ?? refFixtures[0];
        frame = { graph: fx.snapshot.graph, thread: fx.thread, composer: fx.thread.composer, prediction: fx.prediction, now: REF_NOW };
    } else {
        const ms = Number(t);
        frame = [...steps].reverse().find(s => s.at <= ms)?.frame ?? steps[0].frame;
    }
    if (params.get('popover') && frame.thread) frame = { ...frame, thread: { ...frame.thread, popoverOpen: true } };
    show(frame);
    return true;
}

// ── player ──
let index = 0, playing = false, speed = 1, timer: ReturnType<typeof setTimeout> | undefined;
function go(i: number): void {
    index = Math.max(0, Math.min(steps.length - 1, i));
    show(steps[index].frame);
    renderBar();
}
function schedule(): void {
    clearTimeout(timer);
    if (!playing) return;
    const next = steps[index + 1];
    if (!next) { timer = setTimeout(() => { go(0); schedule(); }, 1600 / speed); return; }
    timer = setTimeout(() => { go(index + 1); schedule(); }, (next.at - steps[index].at) / speed);
}
function play(on: boolean): void { playing = on; schedule(); renderBar(); }

function renderBar(): void {
    const options = steps.map((s, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${(s.at / 1000).toFixed(1)}s · ${s.label}</option>`).join('');
    bar.innerHTML = `<button data-do="toggle">${playing ? '❚❚' : '▶'}</button><button data-do="restart">↺</button>`
        + `<button data-do="prev">‹</button><button data-do="next">›</button><select data-do="jump">${options}</select>`
        + `<select data-do="speed">${[0.25, 0.5, 1, 2].map(v => `<option ${v === speed ? 'selected' : ''} value="${v}">${v}×</option>`).join('')}</select>`
        + `<label><input type="checkbox" data-do="reduce" ${stage.classList.contains('m-reduce') ? 'checked' : ''}> 减少动效</label>`;
}
bar.addEventListener('click', e => {
    const action = (e.target as HTMLElement).closest('button')?.dataset.do;
    if (action === 'toggle') { if (!playing && index === steps.length - 1) go(0); play(!playing); }
    else if (action === 'restart') { go(0); play(true); }
    else if (action === 'prev') { play(false); go(index - 1); }
    else if (action === 'next') { play(false); go(index + 1); }
});
bar.addEventListener('change', e => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.do === 'jump') { play(false); go(Number(el.value)); }
    else if (el.dataset.do === 'speed') { speed = Number(el.value); schedule(); }
    else if (el.dataset.do === 'reduce') stage.classList.toggle('m-reduce', el.checked);
});
stage.addEventListener('click', e => {
    if ((e.target as HTMLElement).closest('[data-action="suggest"]') && index === 0) { go(1); play(true); }
});

if (!staticMode()) { go(0); }
