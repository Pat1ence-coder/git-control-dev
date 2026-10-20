export const esc = (value: unknown): string => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const clipChars = (text: string, length: number): string => Array.from(text).length > length ? Array.from(text).slice(0, length).join('') + '…' : text;
