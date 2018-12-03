/*********************************************************************
 * Copyright (c) 2018 Ercisson and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import * as bunyan from 'bunyan';

/**
 * Global logger for the debug adapter.
 */
export const logger = bunyan.createLogger({
    name: 'debugadapter',
    streams: [{
        stream: process.stderr,
        level: 'warn',
    }],
});

/**
 * Add a file output stream to the global logger.  The level of that new stream is `debug`.
 *
 * @param logFile path to the output file
 */
export function addLogFile(logFile: string): void {
    logger.addStream({
        path: logFile,
        level: 'debug',
    });
}
