/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import * as path from 'path';
import {
    DebugSession, Handles, InitializedEvent, OutputEvent, Scope, Source,
    StackFrame, StoppedEvent, TerminatedEvent, Thread,
} from 'vscode-debugadapter/lib/main';
import { DebugProtocol } from 'vscode-debugprotocol/lib/debugProtocol';
import { GDBBackend } from './GDBBackend';
import { addLogFile, logger } from './logging';
import { sendBreakDelete, sendBreakInsert, sendBreakList } from './mi/breakpoint';
import * as exec from './mi/exec';
import { sendStackInfoDepth, sendStackListFramesRequest, sendStackListVariables } from './mi/stack';
import { sendTargetAttachRequest } from './mi/target';
import { sendThreadInfoRequest } from './mi/thread';
import { sendVarAssign, sendVarCreate, sendVarDelete, sendVarListChildren, sendVarUpdate } from './mi/var';
import * as varMgr from './varManager';

export interface LoggingRequestArguments {
    logFile?: string;
}

export interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments, LoggingRequestArguments {
    gdb?: string;
    program: string;
    arguments?: string;
    target: string;
}

export interface AttachRequestArguments extends DebugProtocol.LaunchRequestArguments, LoggingRequestArguments {
    gdb?: string;
    program: string;
    processId: string;
}

export interface FrameReference {
    threadId: number;
    frameId: number;
}

export interface FrameVariableReference {
    type: 'frame';
    frameHandle: number;
}

export interface ObjectVariableReference {
    type: 'object';
    frameHandle: number;
    varobjName: string;
}

export type VariableReference = FrameVariableReference | ObjectVariableReference;

export class GDBDebugSession extends DebugSession {
    private gdb: GDBBackend = new GDBBackend();
    private isAttach = false;
    private isRunning = false;
    private frameHandles = new Handles<FrameReference>();
    private variableHandles = new Handles<VariableReference>();

    // Override some DebugSession methods to add logging.
    public sendEvent(event: DebugProtocol.Event): void {
        logger.debug('adapter --> client', event);
        super.sendEvent(event);
    }

    public sendRequest(command: string, args: any, timeout: number,
        cb: (response: DebugProtocol.Response) => void): void {
        logger.debug('adapter --> client', command, args);
        super.sendRequest(command, args, timeout, cb);
    }

    public sendResponse(response: DebugProtocol.Response): void {
        logger.debug('adapter --> client', response);
        super.sendResponse(response);
    }

    protected dispatchRequest(request: DebugProtocol.Request): void {
        logger.debug('client --> adapter', request);
        super.dispatchRequest(request);
    }

    private setupLogging(args: LoggingRequestArguments): void {
        if (args.logFile) {
            addLogFile(args.logFile);
        }
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;
        // response.body.supportsSetExpression = true;
        this.sendResponse(response);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): Promise<void> {
        try {
            this.setupLogging(args);

            this.isAttach = true;

            this.gdb.on('consoleStreamOutput', (output, category) => {
                this.sendEvent(new OutputEvent(output, category));
            });

            this.gdb.on('async', (result) => this.handleGDBAsync(result));

            await this.gdb.attach(args);

            await sendTargetAttachRequest(this.gdb, { pid: args.processId });
            this.sendEvent(new OutputEvent(`attached to process ${args.processId}`));

            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void> {
        try {
            this.setupLogging(args);

            this.gdb.on('consoleStreamOutput', (output, category) => {
                this.sendEvent(new OutputEvent(output, category));
            });

            this.gdb.on('async', (result) => this.handleGDBAsync(result));

            await this.gdb.launch(args);
            await this.gdb.sendFileExecAndSymbols(args.program);

            this.gdb.sendEnablePrettyPrint();

            if (args.arguments) {
                await exec.sendExecArguments(this.gdb, { arguments: args.arguments });
            }
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
        try {
            // Need to get the list of current breakpoints in the file and then make sure
            // that we end up with the requested set of breakpoints for that file
            // deleting ones not requested and inserting new ones.
            const file = args.source.path as string;
            const breakpoints = args.breakpoints || [];

            let inserts = breakpoints.slice();
            const deletes = new Array<string>();

            const actual = new Array<DebugProtocol.Breakpoint>();

            const result = await sendBreakList(this.gdb);
            result.BreakpointTable.body.forEach((gdbbp) => {
                if (gdbbp.fullname === file && gdbbp.line) {
                    // TODO probably need more through checks than just line number
                    const line = parseInt(gdbbp.line, 10);
                    if (!breakpoints.find((vsbp) => vsbp.line === line)) {
                        deletes.push(gdbbp.number);
                    }

                    inserts = inserts.filter((vsbp) => {
                        if (vsbp.line !== line) {
                            return true;
                        } else {
                            actual.push({
                                verified: true,
                                line: gdbbp.line ? parseInt(gdbbp.line, 10) : 0,
                                id: parseInt(gdbbp.number, 10),
                            });
                            return false;
                        }
                    });
                }
            });

            for (const vsbp of inserts) {
                const gdbbp = await sendBreakInsert(this.gdb, { location: `${file}:${vsbp.line}` });
                actual.push({
                    id: parseInt(gdbbp.bkpt.number, 10),
                    line: gdbbp.bkpt.line ? parseInt(gdbbp.bkpt.line, 10) : 0,
                    verified: true,
                });
            }

            response.body = {
                breakpoints: actual,
            };

            if (deletes.length > 0) {
                await sendBreakDelete(this.gdb, { breakpoints: deletes });
            }

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
        try {
            if (this.isAttach) {
                await exec.sendExecContinue(this.gdb);
            } else {
                await exec.sendExecRun(this.gdb);
            }
            this.isRunning = true;
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 100, err.message);
        }
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            if (!this.isRunning) {
                // This is a thread request that comes out too early
                // comes out right after configDone and no way to delay it
                this.sendResponse(response);
                return;
            }

            const result = await sendThreadInfoRequest(this.gdb, {});
            const threads = result.threads.map((thread) => {
                return new Thread(parseInt(thread.id, 10), thread.name ? thread.name : thread.id);
            });

            response.body = {
                threads,
            };

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments): Promise<void> {
        try {
            const depthResult = await sendStackInfoDepth(this.gdb, { maxDepth: 100 });
            const depth = parseInt(depthResult.depth, 10);
            const levels = args.levels ? (args.levels > depth ? depth : args.levels) : depth;
            const lowFrame = args.startFrame || 0;
            const highFrame = lowFrame + levels - 1;
            const listResult = await sendStackListFramesRequest(this.gdb, { lowFrame, highFrame });

            const stack = listResult.stack.map((frame) => {
                let source;
                if (frame.fullname) {
                    source = new Source(path.basename(frame.file || frame.fullname), frame.fullname);
                }
                let line;
                if (frame.line) {
                    line = parseInt(frame.line, 10);
                }
                const frameHandle = this.frameHandles.create({
                    threadId: args.threadId,
                    frameId: parseInt(frame.level, 10),
                });
                return new StackFrame(frameHandle, frame.func || frame.fullname || '', source, line);
            });

            response.body = {
                stackFrames: stack,
                totalFrames: depth,
            };

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async nextRequest(response: DebugProtocol.NextResponse,
        args: DebugProtocol.NextArguments): Promise<void> {
        try {
            await exec.sendExecNext(this.gdb);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments): Promise<void> {
        try {
            await exec.sendExecStep(this.gdb);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments): Promise<void> {
        try {
            await exec.sendExecFinish(this.gdb);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments): Promise<void> {
        try {
            await exec.sendExecContinue(this.gdb);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected scopesRequest(response: DebugProtocol.ScopesResponse,
        args: DebugProtocol.ScopesArguments): void {
        const frame: FrameVariableReference = {
            type: 'frame',
            frameHandle: args.frameId,
        };

        response.body = {
            scopes: [
                new Scope('Local', this.variableHandles.create(frame), false),
            ],
        };

        this.sendResponse(response);
    }

    protected async variablesRequest(response: DebugProtocol.VariablesResponse,
        args: DebugProtocol.VariablesArguments): Promise<void> {
        const variables = new Array<DebugProtocol.Variable>();
        response.body = {
            variables,
        };
        try {
            const ref = this.variableHandles.get(args.variablesReference);
            if (!ref) {
                this.sendResponse(response);
                return;
            }
            if (ref.type === 'frame') {
                const frame = this.frameHandles.get(ref.frameHandle);
                if (!frame) {
                    this.sendResponse(response);
                    return;
                }

                let callStack = false;
                let numVars = 0;

                const stackDepth = await sendStackInfoDepth(this.gdb, { maxDepth: 100 });
                const depth = parseInt(stackDepth.depth, 10);
                const toDelete = new Array<string>();

                const vars = varMgr.getVars(frame.frameId, frame.threadId, depth);
                if (vars) {
                    for (const varobj of vars) {
                        if (varobj.isVar && !varobj.isChild) {
                            const vup = await sendVarUpdate(this.gdb, {
                                threadId: frame.threadId,
                                name: varobj.varname,
                            });
                            const update = vup.changelist[0];
                            let pushVar = true;
                            if (update) {
                                if (update.in_scope === 'true') {
                                    numVars++;
                                    varobj.value = update.value;
                                } else {
                                    callStack = true;
                                    pushVar = false;
                                    toDelete.push(update.name);
                                }
                            } else if (varobj.value) {
                                numVars++;
                            }
                            if (pushVar) {
                                variables.push({
                                    name: varobj.expression,
                                    value: varobj.value,
                                    type: varobj.type,
                                    variablesReference: parseInt(varobj.numchild, 10) > 0
                                        ? this.variableHandles.create({
                                            type: 'object',
                                            frameHandle: ref.frameHandle,
                                            varobjName: varobj.expression,
                                        })
                                        : 0,
                                });
                            }
                        }
                    }
                    for (const varname of toDelete) {
                        await varMgr.removeVar(this.gdb, frame.frameId, frame.threadId, depth, varname);
                    }
                }
                if (callStack === true || numVars === 0) {
                    const result = await sendStackListVariables(this.gdb, {
                        thread: frame.threadId,
                        frame: frame.frameId,
                        printValues: 'simple-values',
                    });
                    for (const variable of result.variables) {
                        let varobj = varMgr.getVar(frame.frameId, frame.threadId, depth, variable.name);
                        if (!varobj) {
                            const varCreateResponse = await sendVarCreate(this.gdb, {
                                frame: 'current', expression: variable.name,
                            });
                            varobj = varMgr.addVar(frame.frameId, frame.threadId, depth, variable.name, true, false,
                                varCreateResponse);
                        } else {
                            varobj = await varMgr.updateVar(this.gdb, frame.frameId, frame.threadId, depth, varobj);
                        }
                        variables.push({
                            name: varobj.expression,
                            value: varobj.value,
                            type: varobj.type,
                            variablesReference: parseInt(varobj.numchild, 10) > 0
                                ? this.variableHandles.create({
                                    type: 'object',
                                    frameHandle: ref.frameHandle,
                                    varobjName: varobj.expression,
                                })
                                : 0,
                        });
                    }
                }

            } else if (ref.type === 'object') {
                const frame = this.frameHandles.get(ref.frameHandle);
                if (!frame) {
                    this.sendResponse(response);
                    return;
                }
                const stackDepth = await sendStackInfoDepth(this.gdb, { maxDepth: 100 });
                const depth = parseInt(stackDepth.depth, 10);
                const varobj = varMgr.getVar(frame.frameId, frame.threadId, depth, ref.varobjName);
                if (varobj) {
                    const regex = /.*\[[\d]+\].*/g;
                    const isArray = regex.test(varobj.type);
                    const children = await sendVarListChildren(this.gdb, {
                        name: varobj.varname,
                        printValues: 'all-values',
                    });
                    for (const child of children.children) {
                        let name = child.exp;
                        if (isArray) {
                            name = `${ref.varobjName}[${child.exp}]`;
                        }
                        let childobj = varMgr.getVar(frame.frameId, frame.threadId, depth, name);
                        if (!childobj) {
                            const childvar = await sendVarCreate(this.gdb, {
                                frame: 'current', expression: name,
                            });
                            if (childvar) {
                                childobj = varMgr.addVar(frame.frameId, frame.threadId, depth, name, true,
                                    true, childvar);
                            }
                        } else {
                            childobj = await varMgr.updateVar(this.gdb, frame.frameId, frame.threadId, depth, childobj);
                            childobj.isChild = true;
                        }
                        if (childobj) {
                            variables.push({
                                name,
                                value: childobj.value ? childobj.value : childobj.type,
                                type: childobj.type,
                                variablesReference: parseInt(childobj.numchild, 10) > 0
                                    ? this.variableHandles.create({
                                        type: 'object',
                                        frameHandle: ref.frameHandle,
                                        varobjName: name,
                                    })
                                    : 0,
                            });
                        }
                    }
                }
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async setVariableRequest(response: DebugProtocol.SetVariableResponse,
        args: DebugProtocol.SetVariableArguments): Promise<void> {
        try {
            const ref = this.variableHandles.get(args.variablesReference);
            if (!ref) {
                this.sendResponse(response);
                return;
            }
            const frame = this.frameHandles.get(ref.frameHandle);
            if (!frame) {
                this.sendResponse(response);
                return;
            }
            const stackDepth = await sendStackInfoDepth(this.gdb, { maxDepth: 100 });
            const depth = parseInt(stackDepth.depth, 10);
            const varobj = varMgr.getVar(frame.frameId, frame.threadId, depth, args.name);
            if (varobj) {
                await sendVarAssign(this.gdb, { varname: varobj.varname, expression: args.value });
                await varMgr.updateVar(this.gdb, frame.frameId, frame.threadId, depth, varobj);
                response.body = {
                    value: varobj.value,
                    type: varobj.type,
                    variablesReference: parseInt(varobj.numchild, 10) > 0
                        ? this.variableHandles.create({
                            type: 'object',
                            frameHandle: ref.frameHandle,
                            varobjName: varobj.expression,
                        })
                        : 0,
                    indexedVariables: parseInt(varobj.numchild, 10),
                };
            } else {
                // we shouldn't hit this case
                response.body = { value: args.value };
            }
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
        this.sendResponse(response);
    }

    // protected async setExpressionRequest(response: DebugProtocol.SetExpressionResponse,
    //                                      args: DebugProtocol.SetExpressionArguments): Promise<void> {
    //     logger.error('got setExpressionRequest');
    //     this.sendResponse(response);
    // }

    protected async evaluateRequest(response: DebugProtocol.EvaluateResponse,
        args: DebugProtocol.EvaluateArguments): Promise<void> {
        response.body = { result: 'Error: could not evaluate expression', variablesReference: 0 }; // default response
        try {
            switch (args.context) {
                case 'repl':
                    response.body = { result: 'placeholder text', variablesReference: 0 };
                    await this.gdb.sendCommand(args.expression);
                    this.sendResponse(response);
                    break;
                case 'watch': {
                    if (args.frameId) {
                        const frame = this.frameHandles.get(args.frameId);
                        if (!frame) {
                            this.sendResponse(response);
                            return;
                        }
                        try {
                            const stackDepth = await sendStackInfoDepth(this.gdb, { maxDepth: 100 });
                            const depth = parseInt(stackDepth.depth, 10);
                            let varobj = varMgr.getVar(frame.frameId, frame.threadId, depth, args.expression);
                            if (!varobj) {
                                const varCreateResponse = await sendVarCreate(this.gdb,
                                    { expression: args.expression, frame: 'current' });
                                varobj = varMgr.addVar(frame.frameId, frame.threadId, depth, args.expression, false,
                                    false, varCreateResponse);
                            } else {
                                const vup = await sendVarUpdate(this.gdb, {
                                    threadId: frame.threadId,
                                    name: varobj.varname,
                                });
                                const update = vup.changelist[0];
                                if (update) {
                                    if (update.in_scope === 'true') {
                                        varobj.value = update.value;
                                    } else {
                                        varMgr.removeVar(this.gdb, frame.frameId, frame.threadId, depth,
                                            varobj.varname);
                                        await sendVarDelete(this.gdb, { varname: varobj.varname });
                                        varobj = undefined;
                                        const varCreateResponse = await sendVarCreate(this.gdb,
                                            { expression: args.expression, frame: 'current' });
                                        varobj = varMgr.addVar(frame.frameId, frame.threadId, depth, args.expression,
                                            false, false, varCreateResponse);
                                    }
                                }
                            }
                            if (varobj) {
                                response.body = {
                                    result: varobj.value,
                                    type: varobj.type,
                                    variablesReference: parseInt(varobj.numchild, 10) > 0
                                        ? this.variableHandles.create({
                                            type: 'object',
                                            frameHandle: args.frameId,
                                            varobjName: varobj.expression,
                                        })
                                        : 0,
                                };
                            }
                        } catch (err) {
                            // if any of the gdb calls fail, just report we can't complete the evaluation
                        }
                    }
                    this.sendResponse(response);
                    break;
                }
            }
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async disconnectRequest(response: DebugProtocol.DisconnectResponse,
        args: DebugProtocol.DisconnectArguments): Promise<void> {
        try {
            await this.gdb.sendGDBExit();
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    private sendStoppedEvent(reason: string, threadId: number, exceptionText?: string) {
        // Reset frame handles and variables for new context
        this.frameHandles.reset();
        this.variableHandles.reset();
        // Send the event
        this.sendEvent(new StoppedEvent(reason, threadId, exceptionText));
    }

    private handleGDBStopped(result: any) {
        switch (result.reason) {
            case 'exited-normally':
                this.sendEvent(new TerminatedEvent());
                break;
            case 'breakpoint-hit':
                this.sendStoppedEvent('breakpoint', parseInt(result['thread-id'], 10));
                break;
            case 'end-stepping-range':
                this.sendStoppedEvent('step', parseInt(result['thread-id'], 10));
                break;
            default:
                logger.warn('GDB unhandled stop', result);
        }
    }

    private handleGDBAsync(result: any) {
        switch (result._class) {
            case 'running':
                // not sure we care, we do get the thread-id that's running tho
                break;
            case 'stopped':
                this.handleGDBStopped(result);
                break;
            default:
                logger.warn('GDB unhandled async', result);
        }
    }
}
