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
import * as path from 'path';
import { DebugClient } from 'vscode-debugadapter-testsupport';
import { standardBefore, standardBeforeEach } from './utils';

let dc: DebugClient;
const testProgramsDir = path.join(__dirname, '..', '..', 'src', 'integration-tests', 'test-programs');
const emptyProgram = path.join(testProgramsDir, 'empty');

before(function() {
    standardBefore();
});

beforeEach(async function() {
    dc = await standardBeforeEach();
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
            verbose: true,
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
                verbose: true,
                program: '/does/not/exist',
            } as any)
                .then(reject)
                .catch(resolve);
        });

        expect(errorMessage.message).eq('/does/not/exist: No such file or directory.');
    });
});
