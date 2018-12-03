/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import { Readable } from 'stream';
import { GDBBackend } from './GDBBackend';
import { logger } from './logging';

export class MIParser {
    private line = '';
    private pos = 0;
    private commandQueue: any = {};
    private waitReady?: (value?: void | PromiseLike<void>) => void;

    constructor(private gdb: GDBBackend) {
    }

    public parse(stream: Readable): Promise<void> {
        return new Promise((resolve) => {
            this.waitReady = resolve;
            const lineRegex = /(.*)(\r?\n)/;
            let buff = '';
            stream.on('data', (chunk) => {
                buff += chunk.toString();
                let regexArray = lineRegex.exec(buff);
                while (regexArray) {
                    this.line = regexArray[1];
                    this.pos = 0;
                    this.handleLine();
                    buff = buff.substring(regexArray[1].length + regexArray[2].length);
                    regexArray = lineRegex.exec(buff);
                }
            });
        });
    }

    public queueCommand(token: number, command: (result: any) => void) {
        this.commandQueue[token] = command;
    }

    private next() {
        if (this.pos < this.line.length) {
            return this.line[this.pos++];
        } else {
            return null;
        }
    }

    private back() {
        this.pos--;
    }

    private restOfLine() {
        return this.line.substr(this.pos);
    }

    private handleToken(firstChar: string) {
        let token = firstChar;
        let c = this.next();
        while (c && c >= '0' && c <= '9') {
            token += c;
            c = this.next();
        }
        this.back();
        return token;
    }

    private handleCString() {
        let c = this.next();
        if (!c || c !== '"') {
            return null;
        }

        let cstring = '';
        for (c = this.next(); c; c = this.next()) {
            switch (c) {
                case '"':
                    return cstring;
                case '\\':
                    c = this.next();
                    if (c) {
                        switch (c) {
                            case 'n':
                                cstring += '\n';
                                break;
                            case 't':
                                cstring += '\t';
                                break;
                            case 'r':
                                break;
                            default:
                                cstring += c;
                        }
                    } else {
                        this.back();
                    }
                    break;
                default:
                    cstring += c;
            }
        }

        return cstring;
    }

    private handleString() {
        let str = '';
        for (let c = this.next(); c; c = this.next()) {
            if (c === '=' || c === ',') {
                this.back();
                return str;
            } else {
                str += c;
            }
        }
        return str;
    }

    private handleObject() {
        let c = this.next();
        const result: any = {};
        if (c === '{') {
            c = this.next();
            while (c !== '}') {
                if (c !== ',') {
                    this.back();
                }
                const name = this.handleString();
                if (this.next() === '=') {
                    result[name] = this.handleValue();
                }
                c = this.next();
            }
        }

        if (c === '}') {
            return result;
        } else {
            return null;
        }
    }

    private handleArray() {
        let c = this.next();
        const result: any[] = [];
        if (c === '[') {
            c = this.next();
            while (c !== ']') {
                if (c !== ',') {
                    this.back();
                }
                result.push(this.handleValue());
                c = this.next();
            }
        }

        if (c === ']') {
            return result;
        } else {
            return null;
        }
    }

    private handleValue(): any {
        const c = this.next();
        this.back();
        switch (c) {
            case '"':
                return this.handleCString();
            case '{':
                return this.handleObject();
            case '[':
                return this.handleArray();
            default:
                // A weird array element with a name, ignore the name and return the value
                this.handleString();
                if (this.next() === '=') {
                    return this.handleValue();
                }
        }
        return null;
    }

    private handleAsyncOutput() {
        const result: any = {
            _class: this.handleString(),
        };

        let c = this.next();
        while (c === ',') {
            const name = this.handleString();
            if (this.next() === '=') {
                result[name] = this.handleValue();
            }
            c = this.next();
        }

        return result;
    }

    private handleConsoleStream() {
        const msg = this.handleCString();
        if (msg) {
            this.gdb.emit('consoleStreamOutput', msg, 'stdout');
        }
    }

    private handleLogStream() {
        const msg = this.handleCString();
        if (msg) {
            logger.info(msg);
        }
    }

    private handleLine() {
        let c = this.next();
        if (!c) {
            return;
        }

        let token = '';

        if (c >= '0' && c <= '9') {
            token = this.handleToken(c);
            c = this.next();
        }

        switch (c) {
            case '^':
                logger.debug('GDB result', this.restOfLine());
                const command = this.commandQueue[token];
                if (command) {
                    const asyncResult = this.handleAsyncOutput();
                    command(asyncResult);
                    delete this.commandQueue[token];
                } else {
                    logger.error('GDB response with no command', token);
                }
                break;
            case '~':
            case '@':
                this.handleConsoleStream();
                break;
            case '&':
                this.handleLogStream();
                break;
            case '=':
                // TODO: notify
                logger.debug('GDB notify', this.restOfLine());
                break;
            case '*':
                logger.debug('GDB async', this.restOfLine());
                const result = this.handleAsyncOutput();
                this.gdb.emit('async', result);
                break;
            case '(':
                if (this.waitReady) {
                    this.waitReady();
                    this.waitReady = undefined;
                }
                break;
            default:
                // treat as console output. happens on Windows.
                this.back();
                this.gdb.emit('consoleStreamOutput', this.restOfLine() + '\n', 'stdout');
        }
    }
}
