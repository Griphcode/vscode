/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, fork } from 'child_process';
import { VSBuffer } from 'vs/base/common/buffer';
import { isRemoteConsoleLog, log } from 'vs/base/common/console';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { Event, Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { deepClone } from 'vs/base/common/objects';
import { removeDangerousEnvVariables } from 'vs/base/node/processes';
import { hash, ISharedProcessWorkerConfiguration } from 'vs/platform/sharedProcess/common/sharedProcessWorkerService';
import { SharedProcessWorkerMessages, ISharedProcessToWorkerMessage, ISharedProcessWorkerEnvironment } from 'vs/platform/sharedProcess/electron-browser/sharedProcessWorker';

/**
 * The `create` function needs to be there by convention because
 * we are loaded via the `vs/base/worker/workerMain` utility.
 */
export function create(): { onmessage: (message: ISharedProcessToWorkerMessage, transfer: Transferable[]) => void } {
	const sharedProcessWorkerMain = new SharedProcessWorkerMain();

	return {
		onmessage: (message, transfer) => sharedProcessWorkerMain.notifyMessage(message, transfer)
	};
}

class SharedProcessWorkerMain {

	private readonly mapConfigurationToProcess = new Map<number, SharedProcessWorkerProcess>();

	constructor() {
		this.init();
	}

	private init(): void {

		// Ask to receive the message channel port & config
		postMessage({ id: SharedProcessWorkerMessages.RequestPort });
	}

	notifyMessage(message: ISharedProcessToWorkerMessage, transfer: Transferable[]): void {
		switch (message.id) {
			case SharedProcessWorkerMessages.ReceivePort:
				if (transfer[0] instanceof MessagePort && message.environment) {
					this.onReceivePort(transfer[0], message.configuration, message.environment);
				}
				break;

			case SharedProcessWorkerMessages.WorkerTerminate:
				this.onTerminate(message.configuration);
				break;

			default:
				Logger.warn(`Unexpected message '${message}'`);
		}
	}

	private onReceivePort(port: MessagePort, configuration: ISharedProcessWorkerConfiguration, environment: ISharedProcessWorkerEnvironment): void {
		Logger.trace('Received the message port and configuration');

		try {

			// Ensure to terminate any existing process for config
			this.terminate(configuration);

			// Spawn a new worker process with given configuration
			const process = new SharedProcessWorkerProcess(port, configuration, environment);
			process.spawn();

			// Remember in map for lifecycle
			this.mapConfigurationToProcess.set(hash(configuration), process);

			// Indicate we are ready
			Logger.trace('Worker is ready');
			postMessage({ id: SharedProcessWorkerMessages.WorkerReady });
		} catch (error) {
			Logger.error(`Unexpected error forking worker process: ${toErrorMessage(error)}`);
		}
	}

	private onTerminate(configuration: ISharedProcessWorkerConfiguration): void {
		this.terminate(configuration);
	}

	private terminate(configuration: ISharedProcessWorkerConfiguration): void {
		const configurationHash = hash(configuration);
		const process = this.mapConfigurationToProcess.get(configurationHash);
		if (process) {
			Logger.trace('Terminating worker process');

			process.dispose();

			this.mapConfigurationToProcess.delete(configurationHash);

			close();
		}
	}
}

class SharedProcessWorkerProcess extends Disposable {

	private child: ChildProcess | undefined = undefined;

	private isDisposed = false;

	constructor(
		private readonly port: MessagePort,
		private readonly configuration: ISharedProcessWorkerConfiguration,
		private readonly environment: ISharedProcessWorkerEnvironment
	) {
		super();
	}

	spawn(): void {
		Logger.trace('Forking worker process');

		// Fork module via bootstrap-fork for AMD support
		this.child = fork(
			this.environment.bootstrapPath,
			[`--type=${this.configuration.process.type}`],
			{ env: this.getEnv() }
		);

		// Re-emit errors to outside
		this.child.on('error', error => Logger.warn(`Error from child process: ${toErrorMessage(error)}`));

		// Handle unexpected termination
		this.child.on('exit', (code, signal) => {
			if (this.isDisposed) {
				return;
			}

			if (code !== 0 && signal !== 'SIGTERM') {
				Logger.error(`Child process crashed with exit code ${code} and signal ${signal}`);
			}
		});

		const onMessageEmitter = new Emitter<VSBuffer>();
		const onRawMessage = Event.fromNodeEventEmitter(this.child, 'message', msg => msg);
		onRawMessage(msg => {
			if (this.isDisposed) {
				return;
			}

			// Handle remote console logs specially
			if (isRemoteConsoleLog(msg)) {
				log(msg, `SharedProcess worker`);
			}

			// Anything else goes to the outside
			else {
				onMessageEmitter.fire(VSBuffer.wrap(Buffer.from(msg, 'base64')));
			}
		});

		const send = (buffer: VSBuffer) => {
			if (this.isDisposed) {
				return;
			}

			if (this.child?.connected) {
				this.child.send((<Buffer>buffer.buffer).toString('base64'));
			} else {
				Logger.warn('Unable to deliver message to disconnected child');
			}
		};

		// Re-emit messages from the process via the port
		const onMessage = onMessageEmitter.event;
		onMessage(message => this.port.postMessage(message.buffer));

		// Relay message from the port into the process
		this.port.onmessage = (e => send(VSBuffer.wrap(e.data)));
	}

	private getEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = {
			...deepClone(process.env),
			VSCODE_AMD_ENTRYPOINT: this.configuration.process.moduleId,
			VSCODE_PIPE_LOGGING: 'true',
			VSCODE_VERBOSE_LOGGING: 'true',
			VSCODE_PARENT_PID: String(process.pid)
		};

		// Sanitize environment
		removeDangerousEnvVariables(env);

		return env;
	}

	override dispose(): void {
		super.dispose();

		this.isDisposed = true;

		this.child?.kill();
	}
}

/**
 * Helper for logging messages from the worker.
 */
namespace Logger {

	export function error(message: string): void {
		postMessage({ id: SharedProcessWorkerMessages.WorkerError, message });
	}

	export function warn(message: string): void {
		postMessage({ id: SharedProcessWorkerMessages.WorkerWarn, message });
	}

	export function trace(message: string): void {
		postMessage({ id: SharedProcessWorkerMessages.WorkerTrace, message });
	}
}
