import * as net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * Minimal Touch Portal plugin client. Touch Portal runs a TCP server on
 * 127.0.0.1:12136; plugins connect, send a `pair` message with their plugin id,
 * then exchange newline-delimited JSON messages.
 *
 * Docs: https://www.touch-portal.com/api/  (Plugin API / message reference)
 */

export type TpSetting = Record<string, string>;

export type TpActionMessage = {
    type: 'action' | 'up' | 'down';
    pluginId: string;
    actionId: string;
    data: { id: string; value: string }[];
};

export type TpListChange = {
    type: 'listChange';
    pluginId: string;
    actionId: string;
    listId: string;     // the data id whose selection changed
    instanceId: string; // the specific action instance
    value: string;      // newly selected value
};

const HOST = '127.0.0.1';
const PORT = 12136;

export interface TpEvents {
    info: (settings: TpSetting) => void;
    settings: (settings: TpSetting) => void;
    action: (msg: TpActionMessage) => void;
    listChange: (msg: TpListChange) => void;
    close: () => void;
}

export declare interface TpClient {
    on<E extends keyof TpEvents>(event: E, listener: TpEvents[E]): this;
    emit<E extends keyof TpEvents>(event: E, ...args: Parameters<TpEvents[E]>): boolean;
}

export class TpClient extends EventEmitter {
    private socket?: net.Socket;
    private buffer = '';

    constructor(private readonly pluginId: string) {
        super();
    }

    connect(): void {
        const socket = net.createConnection({ host: HOST, port: PORT }, () => {
            this.send({ type: 'pair', id: this.pluginId });
        });
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.onData(String(chunk)));
        socket.on('error', (err) => this.log(`socket error: ${err.message}`));
        socket.on('close', () => {
            this.log('socket closed');
            this.emit('close');
        });
        this.socket = socket;
    }

    private onData(chunk: string): void {
        this.buffer += chunk;
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (line) this.dispatch(line);
        }
    }

    private dispatch(line: string): void {
        let msg: any;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        switch (msg.type) {
            case 'info':
                this.emit('info', settingsToMap(msg.settings));
                break;
            case 'settings':
                this.emit('settings', settingsToMap(msg.values));
                break;
            case 'action':
            case 'up':
            case 'down':
                this.emit('action', msg as TpActionMessage);
                break;
            case 'listChange':
                this.emit('listChange', msg as TpListChange);
                break;
            case 'closePlugin':
                this.emit('close');
                break;
            default:
                break;
        }
    }

    send(obj: Record<string, unknown>): void {
        if (!this.socket) return;
        this.socket.write(JSON.stringify(obj) + '\n');
    }

    /** Update a (declared or dynamic) state value. */
    stateUpdate(id: string, value: string): void {
        this.send({ type: 'stateUpdate', id, value });
    }

    /** Create a dynamic state at runtime (e.g. one per discovered stream/tour). */
    createState(id: string, desc: string, defaultValue = '', parentGroup = 'Axis Cam + CamStreamer'): void {
        this.send({ type: 'createState', id, desc, defaultValue, parentGroup });
    }

    removeState(id: string): void {
        this.send({ type: 'removeState', id });
    }

    /** Replace the choice list for an action's choice data field. */
    choiceUpdate(id: string, value: string[]): void {
        this.send({ type: 'choiceUpdate', id, value });
    }

    /** Replace the choice list for one specific in-flight action instance. */
    choiceUpdateSpecific(id: string, instanceId: string, value: string[]): void {
        this.send({ type: 'choiceUpdateSpecific', id, instanceId, value });
    }

    log(message: string): void {
        // Touch Portal captures the plugin's stdout into its log file.
        process.stdout.write(`[axis-tp] ${message}\n`);
    }
}

/** Touch Portal sends settings as an array of single-key objects. */
function settingsToMap(arr: Array<Record<string, string>> | undefined): TpSetting {
    const out: TpSetting = {};
    if (Array.isArray(arr)) {
        for (const entry of arr) {
            for (const [k, v] of Object.entries(entry)) out[k] = v;
        }
    }
    return out;
}
