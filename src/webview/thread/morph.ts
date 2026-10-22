// Keyed DOM morph: updates a live tree to match new HTML in place, so CSS
// transitions (row transforms, path `d`, colours) run instead of a repaint.
// Elements match by data-key among siblings, otherwise by position and tag.
// Classes prefixed with "m-" belong to running motion and survive attribute sync.

export interface MorphResult {
    /** Elements newly attached under an existing parent (subtree roots only). */
    inserted: Element[];
    /** Elements whose own text content changed. */
    changed: Element[];
    /** Elements removed; those with data-exit are handed back still attached. */
    exiting: Element[];
}

const keyOf = (n: Node) => n.nodeType === 1 ? (n as Element).getAttribute('data-key') : null;
const exiting = (n: Node) => n.nodeType === 1 && (n as Element).hasAttribute('data-exiting');

function syncAttributes(from: Element, to: Element): void {
    for (const { name } of Array.from(from.attributes)) {
        if (name === 'data-exiting') continue;
        if (!to.hasAttribute(name) && name !== 'class') from.removeAttribute(name);
    }
    for (const { name, value } of Array.from(to.attributes)) {
        if (name === 'class') continue;
        if (from.getAttribute(name) !== value) from.setAttribute(name, value);
    }
    const motion = Array.from(from.classList).filter(c => c.startsWith('m-'));
    const next = [...(to.getAttribute('class') ?? '').split(/\s+/).filter(Boolean), ...motion].join(' ');
    if ((from.getAttribute('class') ?? '') !== next) {
        if (next) from.setAttribute('class', next); else from.removeAttribute('class');
    }
}

function morphChildren(parent: Element, next: Element, out: MorphResult): void {
    const old = Array.from(parent.childNodes).filter(n => !exiting(n));
    const keyed = new Map<string, Node>();
    for (const n of old) { const key = keyOf(n); if (key) keyed.set(key, n); }
    const unkeyed = old.filter(n => !keyOf(n));
    const used = new Set<Node>();
    let cursor: Node | null = parent.firstChild;
    for (const child of Array.from(next.childNodes)) {
        const key = keyOf(child);
        let match: Node | undefined;
        if (key) {
            const candidate = keyed.get(key);
            if (candidate && candidate.nodeName === child.nodeName) match = candidate;
        } else {
            match = unkeyed.find(n => !used.has(n) && n.nodeName === child.nodeName);
        }
        while (cursor && exiting(cursor)) cursor = cursor.nextSibling;
        if (match) {
            used.add(match);
            if (match !== cursor) parent.insertBefore(match, cursor);
            if (match.nodeType === 3) {
                if (match.nodeValue !== child.nodeValue) { match.nodeValue = child.nodeValue; out.changed.push(parent); }
            } else if (match.nodeType === 1) morphElement(match as Element, child as Element, out);
            cursor = match.nextSibling;
        } else {
            parent.insertBefore(child, cursor);
            if (child.nodeType === 1) out.inserted.push(child as Element);
            else if (child.nodeType === 3 && child.nodeValue?.trim()) out.changed.push(parent);
            cursor = child.nextSibling;
        }
    }
    for (const n of old) {
        if (used.has(n)) continue;
        if (n.nodeType === 1 && (n as Element).hasAttribute('data-exit')) {
            (n as Element).setAttribute('data-exiting', '');
            out.exiting.push(n as Element);
        } else parent.removeChild(n);
    }
}

function morphElement(from: Element, to: Element, out: MorphResult): void {
    syncAttributes(from, to);
    morphChildren(from, to, out);
}

/** Morph the children of `root` to match `html`. */
export function morph(root: Element, html: string): MorphResult {
    const template = root.ownerDocument.createElement('template');
    template.innerHTML = html;
    const next = root.ownerDocument.createElement(root.tagName);
    next.append(template.content);
    const out: MorphResult = { inserted: [], changed: [], exiting: [] };
    morphChildren(root, next, out);
    out.changed = [...new Set(out.changed)];
    return out;
}
