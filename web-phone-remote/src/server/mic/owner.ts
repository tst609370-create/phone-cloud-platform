/**
 * One live inject slot per phone. Connecting a toolbar socket does not take
 * the slot; only a start that will open the device route does. A holder whose
 * socket is no longer open is stale and can be replaced. Releasing an older
 * holder must not drop the replacement.
 */
interface MicHolder {
    token: number;
    isOpen(): boolean;
}

const holders = new Map<string, MicHolder>();
let nextToken = 0;

export function resetMicOwnersForTests(): void {
    holders.clear();
}

export function claimMicOwner(serial: string, isOpen: () => boolean): (() => void) | undefined {
    const current = holders.get(serial);
    if (current && current.isOpen()) return undefined;
    const token = ++nextToken;
    holders.set(serial, { token, isOpen });
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const holder = holders.get(serial);
        if (holder && holder.token === token) holders.delete(serial);
    };
}
