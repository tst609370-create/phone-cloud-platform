import type { ACTION } from '../common/Action';
import type { ParamsBase } from './ParamsBase';

export interface ParamsFileListing extends ParamsBase {
    action: ACTION.FILE_LISTING;
    udid: string;
    path: string;
}
