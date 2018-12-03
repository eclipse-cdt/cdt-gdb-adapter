/*********************************************************************
 * Copyright (c) 2018 Ericsson and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import { expect } from 'chai';
import * as cp from 'child_process';
import * as path from 'path';
import { DebugClient } from 'vscode-debugadapter-testsupport';
import { getExecPath } from '..';

// Allow non-arrow functions: https://mochajs.org/#arrow-functions
// tslint:disable:only-arrow-functions

let dc: DebugClient;
const testProgramsDir = path.join(__dirname, '..', '..', 'src', 'integration-tests', 'test-programs');
const emptyProgram = path.join(testProgramsDir, 'empty');

before(function() {
    // Build the test program
    cp.execSync('make', { cwd: testProgramsDir });
});

beforeEach(async function() {
    let args: string = getExecPath();
    if (process.env.INSPECT_DEBUG_ADAPTER) {
        args = '--inspect-brk ' + args;
    }

    dc = new DebugClient('node', args, 'cppdbg', {
        shell: true,
    });
    await dc.start();
    await dc.initializeRequest();
});

afterEach(async function() {
    await dc.stop();
});

describe('launch', function() {
    // Move the timeout out of the way if the adapter is going to be debugged.
    if (process.env.INSPECT_DEBUG_ADAPTER) {
        this.timeout(9999999);
    }

    it('can launch and hit a breakpoint', async function() {
        await dc.launchRequest({
            program: emptyProgram,
        } as any);

        await dc.setBreakpointsRequest({
            source: { path: 'empty.c' },
            breakpoints: [{
                line: 3,
            }],
        });
        await dc.configurationDoneRequest({});
        await dc.assertStoppedLocation('breakpoint', {});
    });

    it('reports an error when specifying a non-existent binary', async function() {
        const errorMessage = await new Promise<Error>((resolve, reject) => {
            dc.launchRequest({
                program: '/does/not/exist',
            } as any)
                .then(reject)
                .catch(resolve);
        });

        expect(errorMessage.message).eq('/does/not/exist: No such file or directory.');
    });
});
