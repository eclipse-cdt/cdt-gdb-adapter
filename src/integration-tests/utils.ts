/*********************************************************************
 * Copyright (c) 2018 Ericsson and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import * as cp from 'child_process';
import * as path from 'path';
import { DebugClient } from 'vscode-debugadapter-testsupport/lib/debugClient';
import { getExecPath } from '..';

export const testProgramsDir = path.join(__dirname, '..', '..', 'src', 'integration-tests', 'test-programs');
export const emptyProgram = path.join(testProgramsDir, 'empty');
export const sleepProgram = path.join(testProgramsDir, 'sleep');

export function standardBefore(): void {
    // Build the test program
    cp.execSync('make', { cwd: testProgramsDir });
}

export async function standardBeforeEach(): Promise<DebugClient> {
    let args: string = getExecPath();
    if (process.env.INSPECT_DEBUG_ADAPTER) {
        args = '--inspect-brk ' + args;
    }

    const dc = new DebugClient('node', args, 'cppdbg', { shell: true });

    await dc.start();
    await dc.initializeRequest();

    return dc;
}

/**
 * Wrap `promise` in a new Promise that resolves if `promise` is rejected, and is rejected if `promise` is resolved.
 *
 * This is useful when we expect `promise` to be reject and was to test that it is indeed the case.
 */
export function expectError<T>(promise: Promise<T>): Promise<Error> {
    return new Promise<Error>((resolve, reject) => {
        promise.then(reject).catch(resolve);
    });
}
