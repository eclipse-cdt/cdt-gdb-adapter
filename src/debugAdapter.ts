/*********************************************************************
 * Copyright (c) 2018 QNX Software Systems and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/
import * as process from 'process';
import { GDBDebugSession } from './GDBDebugSession';
import { logger } from './logging';

process.on('uncaughtException', (err: any) => {
    logger.error('Uncaught exception', err);
});

GDBDebugSession.run(GDBDebugSession);
