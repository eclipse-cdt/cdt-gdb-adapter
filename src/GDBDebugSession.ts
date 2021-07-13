/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import * as os from 'os';
import * as path from 'path';
import {
    Handles, InitializedEvent, Logger, logger, LoggingDebugSession, OutputEvent, Response, Scope, Source,
    StackFrame, TerminatedEvent, Thread,
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { GDBBackend } from './GDBBackend';
import * as mi from './mi';
import { sendDataReadMemoryBytes, sendDataDisassemble } from './mi/data';
import { StoppedEvent } from './stoppedEvent';
import { VarObjType } from './varManager';

export interface RequestArguments extends DebugProtocol.LaunchRequestArguments {
    gdb?: string;
    gdbArguments?: string[];
    program: string;
    cwd?: string; // TODO not implemented
    verbose?: boolean;
    logFile?: string;
    openGdbConsole?: boolean;
    initCommands?: string[];
}

export interface LaunchRequestArguments extends RequestArguments {
    arguments?: string;
}

export interface AttachRequestArguments extends RequestArguments {
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

export interface MemoryRequestArguments {
    address: string;
    length: number;
    offset?: number;
}

/**
 * Response for our custom 'cdt-gdb-adapter/Memory' request.
 */
export interface MemoryContents {
    /* Hex-encoded string of bytes.  */
    data: string;
    address: string;
}

export interface MemoryResponse extends Response {
    body: MemoryContents;
}

export interface CDTDisassembleArguments extends DebugProtocol.DisassembleArguments {
    /**
     * Memory reference to the end location containing the instructions to disassemble. When this
     * optional setting is provided, the minimum number of lines needed to get to the endMemoryReference
     * is used.
     */
    endMemoryReference: string;
}

// Allow a single number for ignore count or the form '> [number]'
const ignoreCountRegex = /\s|\>/g;
const arrayRegex = /.*\[[\d]+\].*/;
const arrayChildRegex = /[\d]+/;

export class GDBDebugSession extends LoggingDebugSession {
    protected gdb: GDBBackend = this.createBackend();
    protected isAttach = false;
    protected isRunning = false;

    protected supportsRunInTerminalRequest = false;
    protected supportsGdbConsole = false;

    /* A reference to the logger to be used by subclasses */
    protected logger: Logger.Logger;

    protected frameHandles = new Handles<FrameReference>();
    protected variableHandles = new Handles<VariableReference>();
    protected functionBreakpoints: string[] = [];
    protected logPointMessages: { [key: string]: string } = {};

    protected threads: Thread[] = [];

    protected waitPaused?: (value?: void | PromiseLike<void>) => void;

    constructor() {
        super();
        this.logger = logger;
    }

    protected createBackend(): GDBBackend {
        return new GDBBackend();
    }

    /**
     * Handle requests not defined in the debug adapter protocol.
     */
    protected customRequest(command: string, response: DebugProtocol.Response, args: any): void {
        if (command === 'cdt-gdb-adapter/Memory') {
            this.memoryRequest(response as MemoryResponse, args);
        } else {
            return super.customRequest(command, response, args);
        }
    }

    protected initializeRequest(response: DebugProtocol.InitializeResponse,
        args: DebugProtocol.InitializeRequestArguments): void {
        this.supportsRunInTerminalRequest = args.supportsRunInTerminalRequest === true;
        this.supportsGdbConsole = os.platform() === 'linux' && this.supportsRunInTerminalRequest;
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsSetVariable = true;
        response.body.supportsConditionalBreakpoints = true;
        response.body.supportsHitConditionalBreakpoints = true;
        response.body.supportsLogPoints = true;
        response.body.supportsFunctionBreakpoints = true;
        // response.body.supportsSetExpression = true;
        response.body.supportsDisassembleRequest = true;
        response.body.supportsReadMemoryRequest = true;
        this.sendResponse(response);
    }

    protected async attachRequest(response: DebugProtocol.AttachResponse, args: AttachRequestArguments): Promise<void> {
        try {
            logger.setup(args.verbose ? Logger.LogLevel.Verbose : Logger.LogLevel.Warn, args.logFile || false);

            this.gdb.on('consoleStreamOutput', (output, category) => {
                this.sendEvent(new OutputEvent(output, category));
            });

            this.gdb.on('execAsync', (resultClass, resultData) => this.handleGDBAsync(resultClass, resultData));
            this.gdb.on('notifyAsync', (resultClass, resultData) => this.handleGDBNotify(resultClass, resultData));

            await this.spawn(args);
            await this.gdb.sendFileExecAndSymbols(args.program);
            await this.gdb.sendEnablePrettyPrint();

            await mi.sendTargetAttachRequest(this.gdb, { pid: args.processId });
            this.sendEvent(new OutputEvent(`attached to process ${args.processId}`));
            await this.gdb.sendCommands(args.initCommands);

            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments): Promise<void> {
        try {
            logger.setup(args.verbose ? Logger.LogLevel.Verbose : Logger.LogLevel.Warn, args.logFile || false);

            this.gdb.on('consoleStreamOutput', (output, category) => {
                this.sendEvent(new OutputEvent(output, category));
            });

            this.gdb.on('execAsync', (resultClass, resultData) => this.handleGDBAsync(resultClass, resultData));
            this.gdb.on('notifyAsync', (resultClass, resultData) => this.handleGDBNotify(resultClass, resultData));

            await this.spawn(args);
            await this.gdb.sendFileExecAndSymbols(args.program);
            await this.gdb.sendEnablePrettyPrint();

            if (args.initCommands) {
                for (const command of args.initCommands) {
                    await this.gdb.sendCommand(command);
                }
            }

            if (args.arguments) {
                await mi.sendExecArguments(this.gdb, { arguments: args.arguments });
            }
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async spawn(args: LaunchRequestArguments | AttachRequestArguments) {
        if (args.openGdbConsole) {
            if (!this.supportsGdbConsole) {
                logger.warn('cdt-gdb-adapter: openGdbConsole is not supported on this platform');
            } else if (!await this.gdb.supportsNewUi(args.gdb)) {
                logger.warn(`cdt-gdb-adapter: new-ui command not detected (${args.gdb || 'gdb'})`);
            } else {
                logger.verbose('cdt-gdb-adapter: spawning gdb console in client terminal');
                return this.spawnInClientTerminal(args);
            }
        }
        return this.gdb.spawn(args);
    }

    protected async spawnInClientTerminal(
        args: DebugProtocol.LaunchRequestArguments | DebugProtocol.AttachRequestArguments) {
        return this.gdb.spawnInClientTerminal(
            args as LaunchRequestArguments | AttachRequestArguments,
            async (command) => {
                const response = await new Promise<DebugProtocol.Response>((resolve) =>
                    this.sendRequest('runInTerminal', {
                        kind: 'integrated',
                        cwd: process.cwd(),
                        env: process.env,
                        args: command,
                    } as DebugProtocol.RunInTerminalRequestArguments, 5000, resolve),
                );
                if (!response.success) {
                    const message = `could not start the terminal on the client: ${response.message}`;
                    logger.error(message);
                    throw new Error(message);
                }
            },
        );
    }

    protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse,
        args: DebugProtocol.SetBreakpointsArguments): Promise<void> {

        const neededPause = this.isRunning;
        if (neededPause) {
            // Need to pause first
            const waitPromise = new Promise<void>((resolve) => {
                this.waitPaused = resolve;
            });
            this.gdb.pause();
            await waitPromise;
        }

        try {
            // Need to get the list of current breakpoints in the file and then make sure
            // that we end up with the requested set of breakpoints for that file
            // deleting ones not requested and inserting new ones.

            const result = await mi.sendBreakList(this.gdb);
            const file = args.source.path as string;
            const gdbOriginalLocationPrefix = `-source ${file} -line `;
            const gdbbps = result.BreakpointTable.body.filter((gdbbp) => {
                // Ignore "children" breakpoint of <MULTIPLE> entries
                if (gdbbp.number.includes('.')) {
                    return false;
                }

                // Ignore other files
                if (!gdbbp['original-location']) {
                    return false;
                }
                if (!gdbbp['original-location'].startsWith(gdbOriginalLocationPrefix)) {
                    return false;
                }

                // Ignore function breakpoints
                return this.functionBreakpoints.indexOf(gdbbp.number) === -1;
            });

            const { resolved, deletes } = this.resolveBreakpoints(args.breakpoints || [], gdbbps,
                (vsbp, gdbbp) => {

                    // Always invalidate hit conditions as they have a one-way mapping to gdb ignore and temporary
                    if (vsbp.hitCondition) {
                        return false;
                    }

                    // Ensure we can compare undefined and empty strings
                    const vsbpCond = vsbp.condition || undefined;
                    const gdbbpCond = gdbbp.cond || undefined;

                    // Check with original-location so that relocated breakpoints are properly matched
                    const gdbOriginalLocation = `${gdbOriginalLocationPrefix}${vsbp.line}`;
                    return !!(gdbbp['original-location'] === gdbOriginalLocation
                        && vsbpCond === gdbbpCond);
                });

            // Delete before insert to avoid breakpoint clashes in gdb
            if (deletes.length > 0) {
                await mi.sendBreakDelete(this.gdb, { breakpoints: deletes });
                deletes.forEach((breakpoint) => delete this.logPointMessages[breakpoint]);
            }

            // Reset logPoints
            this.logPointMessages = {};

            // Set up logpoint messages and return a formatted breakpoint for the response body
            const createState = (vsbp: DebugProtocol.SourceBreakpoint, gdbbp: mi.MIBreakpointInfo)
                : DebugProtocol.Breakpoint => {

                if (vsbp.logMessage) {
                    this.logPointMessages[gdbbp.number] = vsbp.logMessage;
                }

                let line = 0;
                if (gdbbp.line) {
                    line = parseInt(gdbbp.line, 10);
                } else if (vsbp.line) {
                    line = vsbp.line;
                }

                return {
                    id: parseInt(gdbbp.number, 10),
                    line,
                    verified: true,
                };
            };

            const actual: DebugProtocol.Breakpoint[] = [];

            for (const bp of resolved) {
                if (bp.gdbbp) {
                    actual.push(createState(bp.vsbp, bp.gdbbp));
                    continue;
                }

                let temporary = false;
                let ignoreCount: number | undefined;
                const vsbp = bp.vsbp;
                if (vsbp.hitCondition !== undefined) {
                    ignoreCount = parseInt(vsbp.hitCondition.replace(ignoreCountRegex, ''), 10);
                    if (isNaN(ignoreCount)) {
                        this.sendEvent(new OutputEvent(`Unable to decode expression: ${vsbp.hitCondition}`));
                        continue;
                    }

                    // Allow hit condition continuously above the count
                    temporary = !vsbp.hitCondition.startsWith('>');
                    if (temporary) {
                        // The expression is not 'greater than', decrease ignoreCount to match
                        ignoreCount--;
                    }
                }

                try {
                    const gdbbp = await mi.sendBreakInsert(this.gdb, {
                        source: file,
                        line: vsbp.line,
                        condition: vsbp.condition,
                        temporary,
                        ignoreCount,
                    });
                    actual.push(createState(vsbp, gdbbp.bkpt));
                } catch (err) {
                    actual.push({
                        verified: false,
                        message: err.message,
                    } as DebugProtocol.Breakpoint);
                }
            }

            response.body = {
                breakpoints: actual,
            };

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }

        if (neededPause) {
            mi.sendExecContinue(this.gdb);
        }
    }

    protected async setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse,
        args: DebugProtocol.SetFunctionBreakpointsArguments) {

        const neededPause = this.isRunning;
        if (neededPause) {
            // Need to pause first
            const waitPromise = new Promise<void>((resolve) => {
                this.waitPaused = resolve;
            });
            this.gdb.pause();
            await waitPromise;
        }

        try {
            const result = await mi.sendBreakList(this.gdb);
            const gdbbps = result.BreakpointTable.body.filter((gdbbp) => {
                // Only function breakpoints
                return this.functionBreakpoints.indexOf(gdbbp.number) > -1;
            });

            const { resolved, deletes } = this.resolveBreakpoints(args.breakpoints, gdbbps,
                (vsbp, gdbbp) => {

                    // Always invalidate hit conditions as they have a one-way mapping to gdb ignore and temporary
                    if (vsbp.hitCondition) {
                        return false;
                    }

                    // Ensure we can compare undefined and empty strings
                    const vsbpCond = vsbp.condition || undefined;
                    const gdbbpCond = gdbbp.cond || undefined;

                    return !!(gdbbp['original-location'] === `-function ${vsbp.name}`
                        && vsbpCond === gdbbpCond);
                });

            // Delete before insert to avoid breakpoint clashes in gdb
            if (deletes.length > 0) {
                await mi.sendBreakDelete(this.gdb, { breakpoints: deletes });
                this.functionBreakpoints = this.functionBreakpoints.filter((fnbp) => deletes.indexOf(fnbp) === -1);
            }

            const createActual = (breakpoint: mi.MIBreakpointInfo): DebugProtocol.Breakpoint => ({
                id: parseInt(breakpoint.number, 10),
                verified: true,
            });

            const actual: DebugProtocol.Breakpoint[] = [];
            // const actual = existing.map((bp) => createActual(bp.gdbbp));

            for (const bp of resolved) {
                if (bp.gdbbp) {
                    actual.push(createActual(bp.gdbbp));
                    continue;
                }

                try {
                    const gdbbp = await mi.sendBreakFunctionInsert(this.gdb, bp.vsbp.name);
                    this.functionBreakpoints.push(gdbbp.bkpt.number);
                    actual.push(createActual(gdbbp.bkpt));
                } catch (err) {
                    actual.push({
                        verified: false,
                        message: err.message,
                    } as DebugProtocol.Breakpoint);
                }
            }

            response.body = {
                breakpoints: actual,
            };

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }

        if (neededPause) {
            mi.sendExecContinue(this.gdb);
        }
    }

    /**
     * Resolved which VS breakpoints needs to be installed, which
     * GDB breakpoints need to be deleted and which VS breakpoints
     * are already installed with which matching GDB breakpoint.
     * @param vsbps VS DAP breakpoints
     * @param gdbbps GDB breakpoints
     * @param matchFn matcher to compare VS and GDB breakpoints
     * @returns resolved -> array maintaining order of vsbps that identifies whether
     * VS breakpoint has a cooresponding GDB breakpoint (gdbbp field set) or needs to be
     * inserted (gdbbp field empty)
     * deletes -> GDB bps ids that should be deleted because they don't match vsbps
     */
    protected resolveBreakpoints<T>(vsbps: T[], gdbbps: mi.MIBreakpointInfo[],
        matchFn: (vsbp: T, gdbbp: mi.MIBreakpointInfo) => boolean)
        : {
            resolved: Array<{ vsbp: T, gdbbp?: mi.MIBreakpointInfo }>;
            deletes: string[];
        } {

        const resolved: Array<{ vsbp: T, gdbbp?: mi.MIBreakpointInfo }>
            = vsbps.map((vsbp) => {
                return {
                    vsbp,
                    gdbbp: gdbbps.find((gdbbp) => matchFn(vsbp, gdbbp)),
                };
            });

        const deletes = gdbbps.filter((gdbbp) => {
            return !vsbps.find((vsbp) => matchFn(vsbp, gdbbp));
        }).map((gdbbp) => gdbbp.number);

        return { resolved, deletes };
    }

    protected async configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse,
        args: DebugProtocol.ConfigurationDoneArguments): Promise<void> {
        try {
            if (this.isAttach) {
                await mi.sendExecContinue(this.gdb);
            } else {
                await mi.sendExecRun(this.gdb);
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 100, err.message);
        }
    }

    protected convertThread(thread: mi.MIThreadInfo) {
        let name = thread.name || thread.id;

        if (thread.details) {
            name += ` (${thread.details})`;
        }

        return new Thread(parseInt(thread.id, 10), name);
    }

    protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {
        try {
            if (!this.isRunning) {
                const result = await mi.sendThreadInfoRequest(this.gdb, {});
                this.threads = result.threads.map((thread) => this.convertThread(thread));
            }

            response.body = {
                threads: this.threads,
            };

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse,
        args: DebugProtocol.StackTraceArguments): Promise<void> {
        try {
            const threadId = args.threadId;
            const depthResult = await mi.sendStackInfoDepth(this.gdb, { maxDepth: 100, threadId });
            const depth = parseInt(depthResult.depth, 10);
            const levels = args.levels ? (args.levels > depth ? depth : args.levels) : depth;
            const lowFrame = args.startFrame || 0;
            const highFrame = lowFrame + levels - 1;
            const listResult = await mi.sendStackListFramesRequest(this.gdb, { lowFrame, highFrame, threadId });

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
                const name = frame.func || frame.fullname || '';
                const sf = new StackFrame(frameHandle, name, source, line) as DebugProtocol.StackFrame;
                sf.instructionPointerReference = frame.addr;
                return sf;
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
            await mi.sendExecNext(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stepInRequest(response: DebugProtocol.StepInResponse,
        args: DebugProtocol.StepInArguments): Promise<void> {
        try {
            await mi.sendExecStep(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async stepOutRequest(response: DebugProtocol.StepOutResponse,
        args: DebugProtocol.StepOutArguments): Promise<void> {
        try {
            await mi.sendExecFinish(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async continueRequest(response: DebugProtocol.ContinueResponse,
        args: DebugProtocol.ContinueArguments): Promise<void> {
        try {
            await mi.sendExecContinue(this.gdb, args.threadId);
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async pauseRequest(response: DebugProtocol.PauseResponse,
        args: DebugProtocol.PauseArguments): Promise<void> {
        if (!this.gdb.pause()) {
            response.success = false;
        }
        this.sendResponse(response);
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
                response.body.variables = await this.handleVariableRequestFrame(ref);

            } else if (ref.type === 'object') {
                response.body.variables = await this.handleVariableRequestObject(ref);
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
            const parentVarname = ref.type === 'object' ? ref.varobjName : '';
            const varname = parentVarname + (parentVarname === '' ? '' : '.') + args.name.replace(/^\[(\d+)\]/, '$1');
            const stackDepth = await mi.sendStackInfoDepth(this.gdb, { maxDepth: 100 });
            const depth = parseInt(stackDepth.depth, 10);
            let varobj = this.gdb.varManager.getVar(frame.frameId, frame.threadId, depth, varname);
            let assign;
            if (varobj) {
                assign = await mi.sendVarAssign(this.gdb, { varname: varobj.varname, expression: args.value });
            } else {
                try {
                    assign = await mi.sendVarAssign(this.gdb, { varname, expression: args.value });
                } catch (err) {
                    if (parentVarname === '') {
                        throw err; // no recovery possible
                    }
                    const children = await mi.sendVarListChildren(this.gdb, {
                        name: parentVarname,
                        printValues: mi.MIVarPrintValues.all,
                    });
                    for (const child of children.children) {
                        if (this.isChildOfClass(child)) {
                            const grandchildVarname = child.name + '.' + args.name.replace(/^\[(\d+)\]/, '$1');
                            varobj = this.gdb.varManager.getVar(frame.frameId,
                                frame.threadId, depth, grandchildVarname);
                            try {
                                assign = await mi.sendVarAssign(this.gdb, {
                                    varname: grandchildVarname,
                                    expression: args.value,
                                });
                                break;
                            } catch (err) {
                                continue; // try another child
                            }
                        }
                    }
                    if (!assign) {
                        throw err; // no recovery possible
                    }
                }
            }
            response.body = {
                value: assign.value,
                type: varobj ? varobj.type : undefined,
                variablesReference: (varobj && parseInt(varobj.numchild, 10) > 0)
                    ? this.variableHandles.create({
                        type: 'object',
                        frameHandle: ref.frameHandle,
                        varobjName: varobj.varname,
                    })
                    : 0,
            };
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
            if (args.frameId === undefined) {
                throw new Error('Evaluation of expression without frameId is not supported.');
            }

            const frame = this.frameHandles.get(args.frameId);
            if (!frame) {
                this.sendResponse(response);
                return;
            }
            const stackDepth = await mi.sendStackInfoDepth(this.gdb, { maxDepth: 100 });
            const depth = parseInt(stackDepth.depth, 10);
            let varobj = this.gdb.varManager.getVar(frame.frameId, frame.threadId, depth, args.expression);
            if (!varobj) {
                const varCreateResponse = await mi.sendVarCreate(this.gdb,
                    { expression: args.expression, frame: 'current' });
                varobj = this.gdb.varManager.addVar(frame.frameId, frame.threadId, depth, args.expression, false,
                    false, varCreateResponse);
            } else {
                const vup = await mi.sendVarUpdate(this.gdb, {
                    name: varobj.varname,
                });
                const update = vup.changelist[0];
                if (update) {
                    if (update.in_scope === 'true') {
                        if (update.name === varobj.varname) {
                            varobj.value = update.value;
                        }
                    } else {
                        this.gdb.varManager.removeVar(frame.frameId, frame.threadId, depth,
                            varobj.varname);
                        await mi.sendVarDelete(this.gdb, { varname: varobj.varname });
                        const varCreateResponse = await mi.sendVarCreate(this.gdb,
                            { expression: args.expression, frame: 'current' });
                        varobj = this.gdb.varManager.addVar(frame.frameId, frame.threadId, depth, args.expression,
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
                            varobjName: varobj.varname,
                        })
                        : 0,
                };
            }

            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    /**
     * Implement the cdt-gdb-adapter/Memory request.
     */
    protected async memoryRequest(response: MemoryResponse, args: any) {
        try {
            if (typeof (args.address) !== 'string') {
                throw new Error(`Invalid type for 'address', expected string, got ${typeof (args.address)}`);
            }

            if (typeof (args.length) !== 'number') {
                throw new Error(`Invalid type for 'length', expected number, got ${typeof (args.length)}`);
            }

            if (typeof (args.offset) !== 'number' && typeof (args.offset) !== 'undefined') {
                throw new Error(`Invalid type for 'offset', expected number or undefined, got ${typeof (args.offset)}`);
            }

            const typedArgs = args as MemoryRequestArguments;

            const result = await sendDataReadMemoryBytes(
                this.gdb, typedArgs.address, typedArgs.length, typedArgs.offset);
            response.body = {
                data: result.memory[0].contents,
                address: result.memory[0].begin,
            };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async disassembleRequest(response: DebugProtocol.DisassembleResponse,
        args: CDTDisassembleArguments) {
        try {
            const meanSizeOfInstruction = 4;
            let startOffset = 0;
            let lastStartOffset = -1;
            const instructions: DebugProtocol.DisassembledInstruction[] = [];
            let oneIterationOnly = false;
            outer_loop:
            while (instructions.length < args.instructionCount && !oneIterationOnly) {
                if (startOffset === lastStartOffset) {
                    // We have stopped getting new instructions, give up
                    break outer_loop;
                }
                lastStartOffset = startOffset;

                const fetchSize = (args.instructionCount - instructions.length) * meanSizeOfInstruction;

                // args.memoryReference is an arbitrary expression, so let GDB do the
                // math on resolving value rather than doing the addition in the adapter
                try {
                    const stepStartAddress = `(${args.memoryReference})+${startOffset}`;
                    let stepEndAddress = `(${args.memoryReference})+${startOffset}+${fetchSize}`;
                    if (args.endMemoryReference && instructions.length === 0) {
                        // On the first call, if we have an end memory address use it instead of
                        // the approx size
                        stepEndAddress = args.endMemoryReference;
                        oneIterationOnly = true;
                    }
                    const result = await sendDataDisassemble(this.gdb, stepStartAddress, stepEndAddress);
                    for (const asmInsn of result.asm_insns) {
                        const line: number | undefined = asmInsn.line ? parseInt(asmInsn.line, 10) : undefined;
                        const source = {
                            name: asmInsn.file,
                            path: asmInsn.fullname,
                        } as DebugProtocol.Source;
                        for (const asmLine of asmInsn.line_asm_insn) {
                            let funcAndOffset: string | undefined;
                            if (asmLine['func-name'] && asmLine.offset) {
                                funcAndOffset = `${asmLine['func-name']}+${asmLine.offset}`;
                            } else if (asmLine['func-name']) {
                                funcAndOffset = asmLine['func-name'];
                            } else {
                                funcAndOffset = undefined;
                            }
                            const disInsn = {
                                address: asmLine.address,
                                instructionBytes: asmLine.opcodes,
                                instruction: asmLine.inst,
                                symbol: funcAndOffset,
                                location: source,
                                line,
                            } as DebugProtocol.DisassembledInstruction;
                            instructions.push(disInsn);
                            if (instructions.length === args.instructionCount) {
                                break outer_loop;
                            }

                            const bytes = asmLine.opcodes.replace(/\s/g, '');
                            startOffset += bytes.length;
                        }
                    }
                } catch (err) {
                    // Failed to read instruction -- what best to do here?
                    // in other words, whose responsibility (adapter or client)
                    // to reissue reads in smaller chunks to find good memory
                    while (instructions.length < args.instructionCount) {
                        const badDisInsn = {
                            // TODO this should start at byte after last retrieved address
                            address: `0x${startOffset.toString(16)}`,
                            instruction: err.message,
                        } as DebugProtocol.DisassembledInstruction;
                        instructions.push(badDisInsn);
                        startOffset += 2;
                    }
                    break outer_loop;
                }
            }

            if (!args.endMemoryReference) {
                while (instructions.length < args.instructionCount) {
                    const badDisInsn = {
                        // TODO this should start at byte after last retrieved address
                        address: `0x${startOffset.toString(16)}`,
                        instruction: 'failed to retrieve instruction',
                    } as DebugProtocol.DisassembledInstruction;
                    instructions.push(badDisInsn);
                    startOffset += 2;
                }
            }

            response.body = { instructions };
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(response, 1, err.message);
        }
    }

    protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse,
        args: DebugProtocol.ReadMemoryArguments): Promise<void> {
        try {
            const result = await sendDataReadMemoryBytes(
                this.gdb, args.memoryReference, args.count, args.offset);
            response.body = {
                data: result.memory[0].contents,
                address: result.memory[0].begin,
            };
            this.sendResponse(response);
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

    protected sendStoppedEvent(reason: string, threadId: number, allThreadsStopped?: boolean) {
        // Reset frame handles and variables for new context
        this.frameHandles.reset();
        this.variableHandles.reset();
        // Send the event
        this.sendEvent(new StoppedEvent(reason, threadId, allThreadsStopped));
    }

    protected handleGDBStopped(result: any) {
        const getThreadId = (resultData: any) => parseInt(resultData['thread-id'], 10);
        const getAllThreadsStopped = (resultData: any) => {
            return !!resultData['stopped-threads'] && resultData['stopped-threads'] === 'all';
        };

        switch (result.reason) {
            case 'exited':
            case 'exited-normally':
                this.sendEvent(new TerminatedEvent());
                break;
            case 'breakpoint-hit':
                if (this.logPointMessages[result.bkptno]) {
                    this.sendEvent(new OutputEvent(this.logPointMessages[result.bkptno]));
                    mi.sendExecContinue(this.gdb);
                } else {
                    const reason = (this.functionBreakpoints.indexOf(result.bkptno) > -1)
                        ? 'function breakpoint' : 'breakpoint';
                    this.sendStoppedEvent(reason, getThreadId(result), getAllThreadsStopped(result));
                }
                break;
            case 'end-stepping-range':
            case 'function-finished':
                this.sendStoppedEvent('step', getThreadId(result), getAllThreadsStopped(result));
                break;
            case 'signal-received':
                const name = result['signal-name'] || 'signal';
                this.sendStoppedEvent(name, getThreadId(result), getAllThreadsStopped(result));
                if (this.waitPaused) {
                    this.waitPaused();
                }
                break;
            default:
                this.sendStoppedEvent('generic', getThreadId(result), getAllThreadsStopped(result));
        }
    }

    protected handleGDBAsync(resultClass: string, resultData: any) {
        switch (resultClass) {
            case 'running':
                this.isRunning = true;
                break;
            case 'stopped':
                if (this.isRunning) {
                    this.isRunning = false;
                    this.handleGDBStopped(resultData);
                }
                break;
            default:
                logger.warn(`GDB unhandled async: ${resultClass}: ${JSON.stringify(resultData)}`);
        }
    }

    protected handleGDBNotify(notifyClass: string, notifyData: any) {
        switch (notifyClass) {
            case 'thread-created':
                this.threads.push(this.convertThread(notifyData));
                break;
            case 'thread-selected':
            case 'thread-exited':
            case 'thread-group-added':
            case 'thread-group-started':
            case 'thread-group-exited':
            case 'library-loaded':
            case 'breakpoint-modified':
            case 'breakpoint-deleted':
                // Known unhandled notifies
                break;
            default:
                logger.warn(`GDB unhandled notify: ${notifyClass}: ${JSON.stringify(notifyData)}`);
        }
    }

    protected async handleVariableRequestFrame(ref: FrameVariableReference): Promise<DebugProtocol.Variable[]> {
        // initialize variables array and dereference the frame handle
        const variables: DebugProtocol.Variable[] = [];
        const frame = this.frameHandles.get(ref.frameHandle);
        if (!frame) {
            return Promise.resolve(variables);
        }

        // vars used to determine if we should call sendStackListVariables()
        let callStack = false;
        let numVars = 0;

        // stack depth necessary for differentiating between similarly named variables at different stack depths
        const stackDepth = await mi.sendStackInfoDepth(this.gdb, { maxDepth: 100 });
        const depth = parseInt(stackDepth.depth, 10);

        // array of varnames to delete. Cannot delete while iterating through the vars array below.
        const toDelete = new Array<string>();

        // get the list of vars we need to update for this frameId/threadId/depth tuple
        const vars = this.gdb.varManager.getVars(frame.frameId, frame.threadId, depth);
        if (vars) {
            for (const varobj of vars) {
                // ignore expressions and child entries
                if (varobj.isVar && !varobj.isChild) {
                    // request update from GDB
                    const vup = await mi.sendVarUpdate(this.gdb, {
                        name: varobj.varname,
                    });
                    // if changelist is length 0, update is undefined
                    const update = vup.changelist[0];
                    let pushVar = true;
                    if (update) {
                        if (update.in_scope === 'true') {
                            numVars++;
                            if (update.name === varobj.varname) {
                                // don't update the parent value to a child's value
                                varobj.value = update.value;
                            }
                        } else {
                            // var is out of scope, delete it and call sendStackListVariables() later
                            callStack = true;
                            pushVar = false;
                            toDelete.push(update.name);
                        }
                    } else if (varobj.value) {
                        // value hasn't updated but it's still in scope
                        numVars++;
                    }
                    // only push entries to the result that aren't being deleted
                    if (pushVar) {
                        let value = varobj.value;
                        // if we have an array parent entry, we need to display the address.
                        if (arrayRegex.test(varobj.type)) {
                            value = await this.getAddr(varobj);
                        }
                        variables.push({
                            name: varobj.expression,
                            value,
                            type: varobj.type,
                            variablesReference: parseInt(varobj.numchild, 10) > 0
                                ? this.variableHandles.create({
                                    type: 'object',
                                    frameHandle: ref.frameHandle,
                                    varobjName: varobj.varname,
                                })
                                : 0,
                        });
                    }
                }
            }
            // clean up out of scope entries
            for (const varname of toDelete) {
                await this.gdb.varManager.removeVar(frame.frameId, frame.threadId, depth, varname);
            }
        }
        // if we had out of scope entries or no entries in the frameId/threadId/depth tuple, query GDB for new ones
        if (callStack === true || numVars === 0) {
            const result = await mi.sendStackListVariables(this.gdb, {
                thread: frame.threadId,
                frame: frame.frameId,
                printValues: 'simple-values',
            });
            for (const variable of result.variables) {
                let varobj = this.gdb.varManager.getVar(frame.frameId, frame.threadId, depth, variable.name);
                if (!varobj) {
                    // create var in GDB and store it in the varMgr
                    const varCreateResponse = await mi.sendVarCreate(this.gdb, {
                        frame: 'current', expression: variable.name,
                    });
                    varobj = this.gdb.varManager.addVar(frame.frameId,
                        frame.threadId, depth, variable.name, true, false,
                        varCreateResponse);
                } else {
                    // var existed as an expression before. Now it's a variable too.
                    varobj = await this.gdb.varManager.updateVar(
                        frame.frameId, frame.threadId, depth, varobj);
                    varobj.isVar = true;
                }
                let value = varobj.value;
                // if we have an array parent entry, we need to display the address.
                if (arrayRegex.test(varobj.type)) {
                    value = await this.getAddr(varobj);
                }
                variables.push({
                    name: varobj.expression,
                    value,
                    type: varobj.type,
                    variablesReference: parseInt(varobj.numchild, 10) > 0
                        ? this.variableHandles.create({
                            type: 'object',
                            frameHandle: ref.frameHandle,
                            varobjName: varobj.varname,
                        })
                        : 0,
                });
            }
        }
        return Promise.resolve(variables);
    }

    protected async handleVariableRequestObject(ref: ObjectVariableReference): Promise<DebugProtocol.Variable[]> {
        // initialize variables array and dereference the frame handle
        const variables: DebugProtocol.Variable[] = [];
        const frame = this.frameHandles.get(ref.frameHandle);
        if (!frame) {
            return Promise.resolve(variables);

        }

        // fetch stack depth to obtain frameId/threadId/depth tuple
        const stackDepth = await mi.sendStackInfoDepth(this.gdb, { maxDepth: 100 });
        const depth = parseInt(stackDepth.depth, 10);
        // we need to keep track of children and the parent varname in GDB
        let children;
        let parentVarname = ref.varobjName;

        // if a varobj exists, use the varname stored there
        const varobj = this.gdb.varManager.getVarByName(frame.frameId, frame.threadId, depth, ref.varobjName);
        if (varobj) {
            children = await mi.sendVarListChildren(this.gdb, {
                name: varobj.varname,
                printValues: mi.MIVarPrintValues.all,
            });
            parentVarname = varobj.varname;
        } else {
            // otherwise use the parent name passed in the variable reference
            children = await mi.sendVarListChildren(this.gdb, {
                name: ref.varobjName,
                printValues: mi.MIVarPrintValues.all,
            });
        }

        // iterate through the children
        for (const child of children.children) {
            // check if we're dealing with a C++ object. If we are, we need to fetch the grandchildren instead.
            const isClass = this.isChildOfClass(child);
            if (isClass) {
                const name = `${parentVarname}.${child.exp}`;
                const objChildren = await mi.sendVarListChildren(this.gdb, {
                    name,
                    printValues: mi.MIVarPrintValues.all,
                });
                for (const objChild of objChildren.children) {
                    const childName = `${name}.${objChild.exp}`;
                    variables.push({
                        name: objChild.exp,
                        value: objChild.value ? objChild.value : objChild.type,
                        type: objChild.type,
                        variablesReference: parseInt(objChild.numchild, 10) > 0
                            ? this.variableHandles.create({
                                type: 'object',
                                frameHandle: ref.frameHandle,
                                varobjName: childName,
                            })
                            : 0,
                    });

                }
            } else {
                // check if we're dealing with an array
                let name = `${ref.varobjName}.${child.exp}`;
                let varobjName = name;
                let value = child.value ? child.value : child.type;
                const isArrayParent = arrayRegex.test(child.type);
                const isArrayChild = (varobj !== undefined
                    ? arrayRegex.test(varobj.type) && arrayChildRegex.test(child.exp)
                    : false);
                if (isArrayChild) {
                    // update the display name for array elements to have square brackets
                    name = `[${child.exp}]`;
                }
                if (isArrayParent || isArrayChild) {
                    // can't use a relative varname (eg. var1.a.b.c) to create/update a new var so fetch and track these
                    // vars by evaluating their path expression from GDB
                    const exprResponse = await mi.sendVarInfoPathExpression(this.gdb,
                        child.name);
                    // create or update the var in GDB
                    let arrobj = this.gdb.varManager.getVar(frame.frameId,
                        frame.threadId, depth, exprResponse.path_expr);
                    if (!arrobj) {
                        const varCreateResponse = await mi.sendVarCreate(this.gdb, {
                            frame: 'current', expression: exprResponse.path_expr,
                        });
                        arrobj = this.gdb.varManager.addVar(frame.frameId,
                            frame.threadId, depth, exprResponse.path_expr,
                            true, false, varCreateResponse);
                    } else {
                        arrobj = await this.gdb.varManager.updateVar(frame.frameId, frame.threadId, depth,
                            arrobj);
                    }
                    // if we have an array parent entry, we need to display the address.
                    if (isArrayParent) {
                        value = await this.getAddr(arrobj);
                    }
                    arrobj.isChild = true;
                    varobjName = arrobj.varname;
                }
                const variableName = isArrayChild ? name : child.exp;
                variables.push({
                    name: variableName,
                    value,
                    type: child.type,
                    variablesReference: parseInt(child.numchild, 10) > 0
                        ? this.variableHandles.create({
                            type: 'object',
                            frameHandle: ref.frameHandle,
                            varobjName,
                        })
                        : 0,
                });
            }
        }
        return Promise.resolve(variables);
    }

    protected async getAddr(varobj: VarObjType) {
        const addr = await mi.sendDataEvaluateExpression(this.gdb, `&(${varobj.expression})`);
        return addr.value ? addr.value : varobj.value;
    }

    protected isChildOfClass(child: mi.MIVarChild): boolean {
        return child.type === undefined && child.value === '' &&
            (child.exp === 'public' || child.exp === 'protected' || child.exp === 'private');
    }
}
