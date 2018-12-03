/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import { spawn } from 'child_process';
import * as events from 'events';
import { Writable } from 'stream';
import { AttachRequestArguments, LaunchRequestArguments } from './GDBDebugSession';
import { logger } from './logging';
import { MIParser } from './MIParser';

export interface MIResponse {
    _class: string;
}

export interface MIUploadRequest {
    local: string;
    remote?: string;
}

export interface MIUploadResponse extends MIResponse {
}

export interface MIExecNextRequest {
    reverse?: boolean;
}

export interface MIExecNextResponse extends MIResponse {
}

export declare interface GDBBackend {
    on(event: 'consoleStreamOutput', listener: (output: string, category: string) => void): this;
    on(event: 'async', listener: (result: any) => void): this;

    emit(event: 'consoleStreamOutput', output: string, category: string): boolean;
    emit(event: 'async', result: any): boolean;
}

export class GDBBackend extends events.EventEmitter {
    private parser = new MIParser(this);
    private out?: Writable;
    private token = 0;

    public launch(args: LaunchRequestArguments) {
        const gdb = args.gdb ? args.gdb : 'gdb';
        const proc = spawn(gdb, ['--interpreter=mi2']);
        this.out = proc.stdin;
        return this.parser.parse(proc.stdout);
    }

    public attach(args: AttachRequestArguments) {
        const gdb = args.gdb ? args.gdb : 'gdb';
        const proc = spawn(gdb, ['--interpreter=mi2']);
        this.out = proc.stdin;
        return this.parser.parse(proc.stdout);
    }

    public sendCommand<T>(command: string): Promise<T> {
        const token = this.nextToken();
        logger.debug('GDB command', token, command);
        return new Promise<T>((resolve, reject) => {
            if (this.out) {
                this.parser.queueCommand(token, (result) => {
                    switch (result._class) {
                        case 'done':
                        case 'running':
                            resolve(result);
                            break;
                        case 'connected':
                            resolve(result);
                            break;
                        case 'error':
                            reject(new Error(result.msg));
                            break;
                        default:
                            reject(new Error('Unknown response ' + JSON.stringify(result)));
                    }
                });
                this.out.write(`${token}${command}\n`);
            } else {
                reject(new Error('gdb is not running.'));
            }
        });
    }

    public sendUpload(request: MIUploadRequest): Promise<MIUploadResponse> {
        let command = `upload ${request.local}`;
        if (request.remote) {
            command += ` ${request.remote}`;
        }
        return this.sendCommand(command);
    }

    public sendEnablePrettyPrint() {
        return this.sendCommand('-enable-pretty-printing');
    }

    public sendFileExecAndSymbols(program: string) {
        return this.sendCommand(`-file-exec-and-symbols ${program}`);
    }

    public sendGDBExit() {
        return this.sendCommand('-gdb-exit');
    }

    private nextToken() {
        return this.token++;
    }
}
