/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ISharedProcessWorkerConfiguration } from 'vs/platform/sharedProcess/common/sharedProcessWorkerService';

export enum SharedProcessWorkerMessages {

	// Message Port Exchange
	RequestPort = 'vscode:shared-process-worker->shared-process=requestPort',
	ReceivePort = 'vscode:shared-process->shared-process-worker=receivePort',

	// Lifecycle
	WorkerReady = 'vscode:shared-process-worker->shared-process=ready',
	WorkerTerminate = 'vscode:shared-process->shared-process-worker=terminate',

	// Diagnostics
	WorkerTrace = 'vscode:shared-process-worker->shared-process=trace',
	WorkerWarn = 'vscode:shared-process-worker->shared-process=warn',
	WorkerError = 'vscode:shared-process-worker->shared-process=error'
}

export interface ISharedProcessWorkerEnvironment {

	/**
	 * Full absolute path to our `bootstrap-fork.js` file.
	 */
	bootstrapPath: string;
}

export interface ISharedProcessToWorkerMessage {
	id: string;
	configuration: ISharedProcessWorkerConfiguration;
	environment?: ISharedProcessWorkerEnvironment;
}

export interface IWorkerToSharedProcessMessage {
	id: string;
	message?: string;
}
