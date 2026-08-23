// src/app/pathUtils.ts

export function basename(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? p : p.substring(i + 1);
}

export function dirname(p: string): string {
    const i = p.lastIndexOf('/');
    if (i <= 0) return '/';
    return p.substring(0, i);
}

export function join(...parts: string[]): string {
    return parts.join('/').replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

export function resolve(base: string, name: string): string {
    if (name.startsWith('/')) return name;
    if (name === '.') return base;
    if (name === '..') return dirname(base);
    return join(base, name);
}
