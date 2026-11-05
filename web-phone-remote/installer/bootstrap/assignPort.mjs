/** Assign a unique FRP remote port in [min, max]. Same device keeps its port. */
export function assignPort(records, deviceId, min = 10000, max = 10100) {
    if (!deviceId || typeof deviceId !== 'string') {
        throw new Error('deviceId required');
    }
    const existing = records.find((row) => row.deviceId === deviceId);
    if (existing) return existing.port;
    const used = new Set(records.map((row) => row.port));
    for (let port = min; port <= max; port++) {
        if (!used.has(port)) return port;
    }
    return null;
}
