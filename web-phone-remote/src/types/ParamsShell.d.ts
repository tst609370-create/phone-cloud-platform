import type { ACTION } from '../common/Action';
import type { ParamsBase } from './ParamsBase';

export interface ParamsShell extends ParamsBase {
    action: ACTION.SHELL;
    udid: string;
}
