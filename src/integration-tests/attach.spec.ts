/*********************************************************************
 * Copyright (c) 2018 Ericsson and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import { DebugClient } from 'vscode-debugadapter-testsupport/lib/debugClient';
import { emptyProgram, expectError, sleepProgram, standardBefore, standardBeforeEach } from './utils';
import { expect } from 'chai';
import * as cp from 'child_process';

let dc: DebugClient;

before(function () {
    standardBefore();
});

beforeEach(async function() {
    dc = await standardBeforeEach();
});

after(function() {
    dc.stop();
});

describe('attach', function() {
    // Move the timeout out of the way if the adapter is going to be debugged.
    if (process.env.INSPECT_DEBUG_ADAPTER) {
        this.timeout(9999999);
    }

    it('can attach', async function() {
        const proc = cp.spawn(sleepProgram);
        expect(proc.pid).not.eq(undefined);

        await dc.attachRequest({
            verbose: true,
            program: sleepProgram,
            processId: proc.pid,
        } as any);
    });

    it('reports an error when attaching to a non-existent pid', async function() {
        // This should be an invalid pid on most systems...
        const pid = 666666;
        const errorAttach = await expectError(dc.attachRequest({
            verbose: true,
            program: emptyProgram,
            processId: pid,
        } as any));

        expect(errorAttach.message).eq('ptrace: No such process.');
    });
});
