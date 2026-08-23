import type { BaseDeviceDescriptor } from '../../types/BaseDeviceDescriptor';
import type { ParamsDeviceTracker } from '../../types/ParamsDeviceTracker';

type Entry = HTMLElement | DocumentFragment;

export interface Tool {
    createEntryForDeviceList(
        descriptor: BaseDeviceDescriptor,
        blockClass: string,
        params: ParamsDeviceTracker,
    ): Array<Entry | undefined> | Entry | undefined;
}
