/**
 * Loopback bind requested by the one-click installer (`WS_SCRCPY_BIND_HOST`).
 * Unset keeps the historical all-interfaces listen. Any other value is ignored
 * so this switch cannot be used to publish the service.
 */
export function resolveBindHost(envValue: string | undefined): string | undefined {
    if (envValue === undefined || envValue.trim() === '') return undefined;
    const host = envValue.trim().toLowerCase();
    if (host === '127.0.0.1' || host === '::1' || host === 'localhost') {
        return host === 'localhost' ? '127.0.0.1' : host;
    }
    return undefined;
}
