import type { Message } from './Message';
import type { XtermClientMessage } from './XtermMessage';

export interface MessageXtermClient extends Message {
    type: 'shell';
    data: XtermClientMessage;
}
