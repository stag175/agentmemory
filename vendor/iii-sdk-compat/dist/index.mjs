import { A as EngineTriggers, D as DEFAULT_BRIDGE_RECONNECTION_CONFIG, O as DEFAULT_INVOCATION_TIMEOUT_MS, T as stopWorkerGauges, a as SpanKind$1, b as injectBaggage, c as getMeter, d as shutdownOtel, f as withSpan, g as extractContext, i as SeverityNumber$1, k as EngineFunctions, l as getTracer, m as currentTraceId, n as isChannelRef, p as currentSpanId, s as getLogger, t as http, u as initOtel, w as registerWorkerGauges, x as injectTraceparent } from "./utils-DvwOdG2_.mjs";
import { createRequire } from "node:module";
import { Readable, Writable } from "node:stream";
import { WebSocket } from "ws";
import { context, trace } from "@opentelemetry/api";
import * as os from "node:os";
import { SeverityNumber } from "@opentelemetry/api-logs";

//#region src/channels.ts
/**
* Write end of a streaming channel. Provides both a Node.js `Writable` stream
* and a `sendMessage` method for sending structured text messages.
*
* @example
* ```typescript
* const channel = await iii.createChannel()
*
* // Stream binary data
* channel.writer.stream.write(Buffer.from('hello'))
* channel.writer.stream.end()
*
* // Or send text messages
* channel.writer.sendMessage(JSON.stringify({ type: 'event', data: 'test' }))
* channel.writer.close()
* ```
*/
var ChannelWriter = class ChannelWriter {
	static {
		this.FRAME_SIZE = 64 * 1024;
	}
	constructor(engineWsBase, ref) {
		this.ws = null;
		this.wsReady = false;
		this.pendingMessages = [];
		this.url = buildChannelUrl(engineWsBase, ref.channel_id, ref.access_key, "write");
		this.stream = new Writable({
			write: (chunk, _encoding, callback) => {
				const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				this.sendChunked(buf, callback);
			},
			final: (callback) => {
				if (!this.ws) {
					callback();
					return;
				}
				const doClose = () => {
					if (this.ws) this.ws.close(1e3, "stream_complete");
					callback();
				};
				if (this.wsReady) setTimeout(doClose, 10);
				else this.ws.on("open", () => setTimeout(doClose, 10));
			},
			destroy: (err, callback) => {
				if (this.ws) this.ws.terminate();
				callback(err);
			}
		});
	}
	ensureConnected() {
		if (this.ws) return;
		this.ws = new WebSocket(this.url);
		this.ws.on("open", () => {
			this.wsReady = true;
			for (const { data, callback } of this.pendingMessages) this.ws?.send(data, callback);
			this.pendingMessages.length = 0;
		});
		this.ws.on("error", (err) => {
			this.stream.destroy(err);
		});
		this.ws.on("close", () => {
			if (!this.stream.destroyed) this.stream.destroy();
		});
	}
	/** Send a text message through the channel. */
	sendMessage(msg) {
		this.ensureConnected();
		this.sendRaw(msg, (err) => {
			if (err) this.stream.destroy(err);
		});
	}
	/** Close the channel writer. */
	close() {
		if (!this.ws) return;
		const doClose = () => {
			if (this.ws) this.ws.close(1e3, "channel_close");
		};
		if (this.wsReady) doClose();
		else this.ws.on("open", () => doClose());
	}
	sendChunked(data, callback) {
		let offset = 0;
		const sendNext = (err) => {
			if (err) {
				callback(err);
				return;
			}
			if (offset >= data.length) {
				callback(null);
				return;
			}
			const end = Math.min(offset + ChannelWriter.FRAME_SIZE, data.length);
			const part = data.subarray(offset, end);
			offset = end;
			this.sendRaw(part, sendNext);
		};
		sendNext(null);
	}
	sendRaw(data, callback) {
		this.ensureConnected();
		if (this.wsReady && this.ws) this.ws.send(data, (err) => callback(err ?? null));
		else this.pendingMessages.push({
			data,
			callback
		});
	}
};
/**
* Read end of a streaming channel. Provides both a Node.js `Readable` stream
* for binary data and an `onMessage` callback for structured text messages.
*
* @example
* ```typescript
* const channel = await iii.createChannel()
*
* // Stream binary data
* channel.reader.stream.on('data', (chunk) => console.log(chunk))
*
* // Or receive text messages
* channel.reader.onMessage((msg) => console.log('Got:', msg))
* ```
*/
var ChannelReader = class {
	constructor(engineWsBase, ref) {
		this.ws = null;
		this.connected = false;
		this.messageCallbacks = [];
		this.url = buildChannelUrl(engineWsBase, ref.channel_id, ref.access_key, "read");
		const self = this;
		this.stream = new Readable({
			read() {
				self.ensureConnected();
				if (self.ws) self.ws.resume();
			},
			destroy(err, callback) {
				if (self.ws && self.ws.readyState !== WebSocket.CLOSED) self.ws.terminate();
				self.ws = null;
				callback(err);
			}
		});
	}
	ensureConnected() {
		if (this.connected) return;
		this.connected = true;
		this.ws = new WebSocket(this.url);
		this.ws.on("open", () => {
			this.ws.binaryType = "nodebuffer";
		});
		this.ws.on("message", (data, isBinary) => {
			if (isBinary) {
				if (!this.stream.push(data)) this.ws?.pause();
			} else {
				const msg = data.toString("utf-8");
				for (const cb of this.messageCallbacks) cb(msg);
			}
		});
		this.ws.on("close", () => {
			this.ws = null;
			if (!this.stream.destroyed) this.stream.push(null);
		});
		this.ws.on("error", (err) => {
			this.stream.destroy(err);
		});
	}
	/** Register a callback to receive text messages from the channel. */
	onMessage(callback) {
		this.messageCallbacks.push(callback);
	}
	async readAll() {
		this.ensureConnected();
		const chunks = [];
		for await (const chunk of this.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		return Buffer.concat(chunks);
	}
	close() {
		if (this.ws && this.ws.readyState !== WebSocket.CLOSED) this.ws.close(1e3, "channel_close");
	}
};
function buildChannelUrl(engineWsBase, channelId, accessKey, direction) {
	return `${engineWsBase.replace(/\/$/, "")}/ws/channels/${channelId}?key=${encodeURIComponent(accessKey)}&dir=${direction}`;
}

//#endregion
//#region src/iii-types.ts
let MessageType = /* @__PURE__ */ function(MessageType) {
	MessageType["RegisterFunction"] = "registerfunction";
	MessageType["UnregisterFunction"] = "unregisterfunction";
	MessageType["RegisterService"] = "registerservice";
	MessageType["InvokeFunction"] = "invokefunction";
	MessageType["InvocationResult"] = "invocationresult";
	MessageType["RegisterTriggerType"] = "registertriggertype";
	MessageType["RegisterTrigger"] = "registertrigger";
	MessageType["UnregisterTrigger"] = "unregistertrigger";
	MessageType["UnregisterTriggerType"] = "unregistertriggertype";
	MessageType["TriggerRegistrationResult"] = "triggerregistrationresult";
	MessageType["WorkerRegistered"] = "workerregistered";
	return MessageType;
}({});

//#endregion
//#region src/iii.ts
const { version: SDK_VERSION } = createRequire(import.meta.url)("../package.json");
function getOsInfo() {
	return `${os.platform()} ${os.release()} (${os.arch()})`;
}
function getDefaultWorkerName() {
	return `${os.hostname()}:${process.pid}`;
}
var Sdk = class {
	constructor(address, options) {
		this.address = address;
		this.options = options;
		this.functions = /* @__PURE__ */ new Map();
		this.services = /* @__PURE__ */ new Map();
		this.invocations = /* @__PURE__ */ new Map();
		this.triggers = /* @__PURE__ */ new Map();
		this.triggerTypes = /* @__PURE__ */ new Map();
		this.functionsAvailableCallbacks = /* @__PURE__ */ new Set();
		this.messagesToSend = [];
		this.reconnectAttempt = 0;
		this.connectionState = "disconnected";
		this.isShuttingDown = false;
		this.registerTriggerType = (triggerType, handler) => {
			this.sendMessage(MessageType.RegisterTriggerType, triggerType, true);
			this.triggerTypes.set(triggerType.id, {
				message: {
					...triggerType,
					message_type: MessageType.RegisterTriggerType
				},
				handler
			});
			return {
				id: triggerType.id,
				registerTrigger: (functionId, config, metadata) => {
					return this.registerTrigger({
						type: triggerType.id,
						function_id: functionId,
						config,
						metadata
					});
				},
				registerFunction: (functionId, handler, config, metadata) => {
					const ref = this.registerFunction(functionId, handler);
					this.registerTrigger({
						type: triggerType.id,
						function_id: functionId,
						config,
						metadata
					});
					return ref;
				},
				unregister: () => {
					this.unregisterTriggerType(triggerType);
				}
			};
		};
		this.unregisterTriggerType = (triggerType) => {
			this.sendMessage(MessageType.UnregisterTriggerType, triggerType, true);
			this.triggerTypes.delete(triggerType.id);
		};
		this.registerTrigger = (trigger) => {
			const id = crypto.randomUUID();
			const fullTrigger = {
				...trigger,
				id,
				message_type: MessageType.RegisterTrigger
			};
			this.sendMessage(MessageType.RegisterTrigger, fullTrigger, true);
			this.triggers.set(id, fullTrigger);
			return { unregister: () => {
				this.sendMessage(MessageType.UnregisterTrigger, {
					id,
					message_type: MessageType.UnregisterTrigger,
					type: fullTrigger.type
				});
				this.triggers.delete(id);
			} };
		};
		this.registerFunction = (functionId, handlerOrInvocation, options) => {
			if (!functionId || functionId.trim() === "") throw new Error("id is required");
			if (this.functions.has(functionId)) throw new Error(`function id already registered: ${functionId}`);
			const isHandler = typeof handlerOrInvocation === "function";
			const fullMessage = isHandler ? {
				...options,
				id: functionId,
				message_type: MessageType.RegisterFunction
			} : {
				...options,
				id: functionId,
				message_type: MessageType.RegisterFunction,
				invocation: {
					url: handlerOrInvocation.url,
					method: handlerOrInvocation.method ?? "POST",
					timeout_ms: handlerOrInvocation.timeout_ms,
					headers: handlerOrInvocation.headers,
					auth: handlerOrInvocation.auth
				}
			};
			this.sendMessage(MessageType.RegisterFunction, fullMessage, true);
			if (isHandler) {
				const handler = handlerOrInvocation;
				this.functions.set(functionId, {
					message: fullMessage,
					handler: async (input, traceparent, baggage) => {
						if (getTracer()) {
							const parentContext = extractContext(traceparent, baggage);
							return context.with(parentContext, () => withSpan(`call ${functionId}`, { kind: SpanKind$1.SERVER }, async () => await handler(input)));
						}
						const traceId = crypto.randomUUID().replace(/-/g, "");
						const spanId = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
						const syntheticSpan = trace.wrapSpanContext({
							traceId,
							spanId,
							traceFlags: 1
						});
						return context.with(trace.setSpan(context.active(), syntheticSpan), async () => await handler(input));
					}
				});
			} else this.functions.set(functionId, { message: fullMessage });
			return {
				id: functionId,
				unregister: () => {
					this.sendMessage(MessageType.UnregisterFunction, { id: functionId }, true);
					this.functions.delete(functionId);
				}
			};
		};
		this.registerService = (message) => {
			const msg = {
				...message,
				name: message.name ?? message.id
			};
			this.sendMessage(MessageType.RegisterService, msg, true);
			this.services.set(message.id, {
				...msg,
				message_type: MessageType.RegisterService
			});
		};
		this.createChannel = async (bufferSize) => {
			const result = await this.trigger({
				function_id: "engine::channels::create",
				payload: { buffer_size: bufferSize }
			});
			return {
				writer: new ChannelWriter(this.address, result.writer),
				reader: new ChannelReader(this.address, result.reader),
				writerRef: result.writer,
				readerRef: result.reader
			};
		};
		this.trigger = async (request) => {
			const { function_id, payload, action, timeoutMs } = request;
			const effectiveTimeout = timeoutMs ?? this.invocationTimeoutMs;
			if (action?.type === "void") {
				const traceparent = injectTraceparent();
				const baggage = injectBaggage();
				this.sendMessage(MessageType.InvokeFunction, {
					function_id,
					data: payload,
					traceparent,
					baggage,
					action
				});
				return;
			}
			const invocation_id = crypto.randomUUID();
			const traceparent = injectTraceparent();
			const baggage = injectBaggage();
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					if (this.invocations.get(invocation_id)) {
						this.invocations.delete(invocation_id);
						reject(/* @__PURE__ */ new Error(`Invocation timeout after ${effectiveTimeout}ms: ${function_id}`));
					}
				}, effectiveTimeout);
				this.invocations.set(invocation_id, {
					resolve: (result) => {
						clearTimeout(timeout);
						resolve(result);
					},
					reject: (error) => {
						clearTimeout(timeout);
						reject(error);
					},
					timeout
				});
				this.sendMessage(MessageType.InvokeFunction, {
					invocation_id,
					function_id,
					data: payload,
					traceparent,
					baggage,
					action
				});
			});
		};
		this.listFunctions = async () => {
			return (await this.trigger({
				function_id: EngineFunctions.LIST_FUNCTIONS,
				payload: {}
			})).functions;
		};
		this.listWorkers = async () => {
			return (await this.trigger({
				function_id: EngineFunctions.LIST_WORKERS,
				payload: {}
			})).workers;
		};
		this.listTriggers = async (includeInternal = false) => {
			return (await this.trigger({
				function_id: EngineFunctions.LIST_TRIGGERS,
				payload: { include_internal: includeInternal }
			})).triggers;
		};
		this.listTriggerTypes = async (includeInternal = false) => {
			return (await this.trigger({
				function_id: EngineFunctions.LIST_TRIGGER_TYPES,
				payload: { include_internal: includeInternal }
			})).trigger_types;
		};
		this.createStream = (streamName, stream) => {
			this.registerFunction(`stream::get(${streamName})`, stream.get.bind(stream));
			this.registerFunction(`stream::set(${streamName})`, stream.set.bind(stream));
			this.registerFunction(`stream::delete(${streamName})`, stream.delete.bind(stream));
			this.registerFunction(`stream::list(${streamName})`, stream.list.bind(stream));
			this.registerFunction(`stream::list_groups(${streamName})`, stream.listGroups.bind(stream));
		};
		this.onFunctionsAvailable = (callback) => {
			this.functionsAvailableCallbacks.add(callback);
			if (!this.functionsAvailableTrigger) {
				if (!this.functionsAvailableFunctionPath) this.functionsAvailableFunctionPath = `engine.on_functions_available.${crypto.randomUUID()}`;
				const function_id = this.functionsAvailableFunctionPath;
				if (!this.functions.has(function_id)) this.registerFunction(function_id, async ({ functions }) => {
					this.functionsAvailableCallbacks.forEach((handler) => {
						handler(functions);
					});
					return null;
				});
				this.functionsAvailableTrigger = this.registerTrigger({
					type: EngineTriggers.FUNCTIONS_AVAILABLE,
					function_id,
					config: {}
				});
			}
			return () => {
				this.functionsAvailableCallbacks.delete(callback);
				if (this.functionsAvailableCallbacks.size === 0 && this.functionsAvailableTrigger) {
					this.functionsAvailableTrigger.unregister();
					this.functionsAvailableTrigger = void 0;
				}
			};
		};
		this.shutdown = async () => {
			this.isShuttingDown = true;
			this.stopMetricsReporting();
			await shutdownOtel();
			this.clearReconnectTimeout();
			for (const [_id, invocation] of this.invocations) {
				if (invocation.timeout) clearTimeout(invocation.timeout);
				invocation.reject(/* @__PURE__ */ new Error("iii is shutting down"));
			}
			this.invocations.clear();
			if (this.ws) {
				this.ws.removeAllListeners();
				this.ws.close();
				this.ws = void 0;
			}
			this.setConnectionState("disconnected");
		};
		this.workerName = options?.workerName ?? getDefaultWorkerName();
		this.metricsReportingEnabled = options?.enableMetricsReporting ?? true;
		this.invocationTimeoutMs = options?.invocationTimeoutMs ?? 3e4;
		this.reconnectionConfig = {
			...DEFAULT_BRIDGE_RECONNECTION_CONFIG,
			...options?.reconnectionConfig
		};
		initOtel({
			...options?.otel,
			engineWsUrl: this.address
		});
		this.connect();
	}
	registerWorkerMetadata() {
		const telemetryOpts = this.options?.telemetry;
		const language = telemetryOpts?.language ?? Intl.DateTimeFormat().resolvedOptions().locale ?? process.env.LANG?.split(".")[0];
		this.trigger({
			function_id: EngineFunctions.REGISTER_WORKER,
			payload: {
				runtime: "node",
				version: SDK_VERSION,
				name: this.workerName,
				os: getOsInfo(),
				pid: process.pid,
				isolation: process.env.III_ISOLATION || null,
				telemetry: {
					language,
					project_name: telemetryOpts?.project_name,
					framework: telemetryOpts?.framework?.trim() || "iii-node",
					amplitude_api_key: telemetryOpts?.amplitude_api_key
				}
			},
			action: { type: "void" }
		});
	}
	setConnectionState(state) {
		if (this.connectionState !== state) this.connectionState = state;
	}
	connect() {
		if (this.isShuttingDown) return;
		this.setConnectionState("connecting");
		this.ws = new WebSocket(this.address, { headers: this.options?.headers });
		this.ws.on("open", this.onSocketOpen.bind(this));
		this.ws.on("close", this.onSocketClose.bind(this));
		this.ws.on("error", this.onSocketError.bind(this));
	}
	clearReconnectTimeout() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = void 0;
		}
	}
	scheduleReconnect() {
		if (this.isShuttingDown) return;
		const { maxRetries, initialDelayMs, backoffMultiplier, maxDelayMs, jitterFactor } = this.reconnectionConfig;
		if (maxRetries !== -1 && this.reconnectAttempt >= maxRetries) {
			this.setConnectionState("failed");
			this.logError(`Max reconnection retries (${maxRetries}) reached, giving up`);
			return;
		}
		if (this.reconnectTimeout) return;
		const exponentialDelay = initialDelayMs * backoffMultiplier ** this.reconnectAttempt;
		const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
		const jitter = cappedDelay * jitterFactor * (2 * Math.random() - 1);
		const delay = Math.floor(cappedDelay + jitter);
		this.setConnectionState("reconnecting");
		console.debug(`[iii] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})...`);
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = void 0;
			this.reconnectAttempt++;
			this.connect();
		}, delay);
	}
	onSocketError(error) {
		this.logError("WebSocket error", error);
	}
	startMetricsReporting() {
		if (!this.metricsReportingEnabled || !this.workerId) return;
		const meter = getMeter();
		if (!meter) {
			console.warn("[iii] Worker metrics disabled: OpenTelemetry not initialized. Call initOtel() with metricsEnabled: true before creating the iii.");
			return;
		}
		registerWorkerGauges(meter, {
			workerId: this.workerId,
			workerName: this.workerName
		});
	}
	stopMetricsReporting() {
		stopWorkerGauges();
	}
	onSocketClose() {
		this.ws?.removeAllListeners();
		this.ws?.terminate();
		this.ws = void 0;
		this.setConnectionState("disconnected");
		this.stopMetricsReporting();
		this.scheduleReconnect();
	}
	onSocketOpen() {
		this.clearReconnectTimeout();
		this.reconnectAttempt = 0;
		this.setConnectionState("connected");
		this.ws?.on("message", this.onMessage.bind(this));
		this.triggerTypes.forEach(({ message }) => {
			this.sendMessage(MessageType.RegisterTriggerType, message, true);
		});
		this.services.forEach((service) => {
			this.sendMessage(MessageType.RegisterService, service, true);
		});
		this.functions.forEach(({ message }) => {
			this.sendMessage(MessageType.RegisterFunction, message, true);
		});
		this.triggers.forEach((trigger) => {
			this.sendMessage(MessageType.RegisterTrigger, trigger, true);
		});
		const pending = this.messagesToSend;
		this.messagesToSend = [];
		for (const message of pending) {
			if (message.type === MessageType.InvokeFunction && typeof message.invocation_id === "string" && !this.invocations.has(message.invocation_id)) continue;
			this.sendMessageRaw(JSON.stringify(message));
		}
		this.registerWorkerMetadata();
	}
	isOpen() {
		return this.ws?.readyState === WebSocket.OPEN;
	}
	sendMessageRaw(data) {
		if (this.ws && this.isOpen()) try {
			this.ws.send(data, (err) => {
				if (err) this.logError("Failed to send message", err);
			});
		} catch (error) {
			this.logError("Exception while sending message", error);
		}
	}
	toWireFormat(messageType, message) {
		const { message_type: _, ...rest } = message;
		if (messageType === MessageType.RegisterTrigger && "type" in message) {
			const { type: triggerType, ...triggerRest } = message;
			return {
				type: messageType,
				...triggerRest,
				trigger_type: triggerType
			};
		}
		if (messageType === MessageType.UnregisterTrigger && "type" in message) {
			const { type: triggerType, ...triggerRest } = message;
			return {
				type: messageType,
				...triggerRest,
				trigger_type: triggerType
			};
		}
		if (messageType === MessageType.TriggerRegistrationResult && "type" in message) {
			const { type: triggerType, ...resultRest } = message;
			return {
				type: messageType,
				...resultRest,
				trigger_type: triggerType
			};
		}
		return {
			type: messageType,
			...rest
		};
	}
	sendMessage(messageType, message, skipIfClosed = false) {
		const wireMessage = this.toWireFormat(messageType, message);
		if (this.isOpen()) this.sendMessageRaw(JSON.stringify(wireMessage));
		else if (!skipIfClosed) this.messagesToSend.push(wireMessage);
	}
	logError(message, error) {
		const otelLogger = getLogger();
		const errorMessage = error instanceof Error ? error.message : String(error ?? "");
		if (otelLogger) otelLogger.emit({
			severityNumber: SeverityNumber$1.ERROR,
			body: `[iii] ${message}${errorMessage ? `: ${errorMessage}` : ""}`
		});
		else console.error(`[iii] ${message}`, error ?? "");
	}
	onInvocationResult(invocation_id, result, error) {
		const invocation = this.invocations.get(invocation_id);
		if (invocation) {
			if (invocation.timeout) clearTimeout(invocation.timeout);
			error ? invocation.reject(error) : invocation.resolve(result);
		}
		this.invocations.delete(invocation_id);
	}
	resolveChannelValue(value) {
		if (isChannelRef(value)) return value.direction === "read" ? new ChannelReader(this.address, value) : new ChannelWriter(this.address, value);
		if (Array.isArray(value)) return value.map((item) => this.resolveChannelValue(item));
		if (value !== null && typeof value === "object") {
			const out = {};
			for (const [k, v] of Object.entries(value)) out[k] = this.resolveChannelValue(v);
			return out;
		}
		return value;
	}
	async onInvokeFunction(invocation_id, function_id, input, traceparent, baggage) {
		const fn = this.functions.get(function_id);
		const getResponseTraceparent = () => injectTraceparent() ?? traceparent;
		const getResponseBaggage = () => injectBaggage() ?? baggage;
		const resolvedInput = this.resolveChannelValue(input);
		if (fn?.handler) {
			if (!invocation_id) {
				try {
					await fn.handler(resolvedInput, traceparent, baggage);
				} catch (error) {
					this.logError(`Error invoking function ${function_id}`, error);
				}
				return;
			}
			try {
				const result = await fn.handler(resolvedInput, traceparent, baggage);
				this.sendMessage(MessageType.InvocationResult, {
					invocation_id,
					function_id,
					result,
					traceparent: getResponseTraceparent(),
					baggage: getResponseBaggage()
				});
			} catch (error) {
				const isError = error instanceof Error;
				this.sendMessage(MessageType.InvocationResult, {
					invocation_id,
					function_id,
					error: {
						code: "invocation_failed",
						message: isError ? error.message : String(error),
						stacktrace: isError ? error.stack : void 0
					},
					traceparent: getResponseTraceparent(),
					baggage: getResponseBaggage()
				});
			}
		} else {
			const errorCode = fn ? "function_not_invokable" : "function_not_found";
			const errorMessage = fn ? "Function is HTTP-invoked and cannot be invoked locally" : "Function not found";
			if (invocation_id) this.sendMessage(MessageType.InvocationResult, {
				invocation_id,
				function_id,
				error: {
					code: errorCode,
					message: errorMessage
				},
				traceparent,
				baggage
			});
		}
	}
	async onRegisterTrigger(message) {
		const { trigger_type, id, function_id, config, metadata } = message;
		const triggerTypeData = this.triggerTypes.get(trigger_type);
		if (triggerTypeData) try {
			await triggerTypeData.handler.registerTrigger({
				id,
				function_id,
				config,
				metadata
			});
			this.sendMessage(MessageType.TriggerRegistrationResult, {
				id,
				message_type: MessageType.TriggerRegistrationResult,
				type: trigger_type,
				function_id
			});
		} catch (error) {
			this.sendMessage(MessageType.TriggerRegistrationResult, {
				id,
				message_type: MessageType.TriggerRegistrationResult,
				type: trigger_type,
				function_id,
				error: {
					code: "trigger_registration_failed",
					message: error.message
				}
			});
		}
		else this.sendMessage(MessageType.TriggerRegistrationResult, {
			id,
			message_type: MessageType.TriggerRegistrationResult,
			type: trigger_type,
			function_id,
			error: {
				code: "trigger_type_not_found",
				message: "Trigger type not found"
			}
		});
	}
	onMessage(socketMessage) {
		let msgType;
		let message;
		try {
			const parsed = JSON.parse(socketMessage.toString());
			msgType = parsed.type;
			const { type: _, ...rest } = parsed;
			message = rest;
		} catch (error) {
			this.logError("Failed to parse incoming message", error);
			return;
		}
		if (msgType === MessageType.InvocationResult) {
			const { invocation_id, result, error } = message;
			this.onInvocationResult(invocation_id, result, error);
		} else if (msgType === MessageType.InvokeFunction) {
			const { invocation_id, function_id, data, traceparent, baggage } = message;
			this.onInvokeFunction(invocation_id, function_id, data, traceparent, baggage);
		} else if (msgType === MessageType.RegisterTrigger) this.onRegisterTrigger(message);
		else if (msgType === MessageType.WorkerRegistered) {
			const { worker_id } = message;
			this.workerId = worker_id;
			console.debug("[iii] Worker registered with ID:", worker_id);
			this.startMetricsReporting();
		}
	}
};
/**
* Factory object that constructs routing actions for {@link ISdk.trigger}.
*
* @example
* ```typescript
* import { TriggerAction } from 'iii-sdk'
*
* // Enqueue to a named queue
* iii.trigger({
*   function_id: 'process',
*   payload: { data: 'hello' },
*   action: TriggerAction.Enqueue({ queue: 'jobs' }),
* })
*
* // Fire-and-forget
* iii.trigger({
*   function_id: 'notify',
*   payload: {},
*   action: TriggerAction.Void(),
* })
* ```
*/
const TriggerAction = {
	Enqueue: (opts) => ({
		type: "enqueue",
		...opts
	}),
	Void: () => ({ type: "void" })
};
/**
* Creates and returns a connected SDK instance. The WebSocket connection is
* established automatically -- there is no separate `connect()` call.
*
* @param address - WebSocket URL of the III engine (e.g. `ws://localhost:49134`).
* @param options - Optional {@link InitOptions} for worker name, timeouts, reconnection, and OTel.
* @returns A connected {@link ISdk} instance.
*
* @example
* ```typescript
* import { registerWorker } from 'iii-sdk'
*
* const iii = registerWorker(process.env.III_URL ?? 'ws://localhost:49134', {
*   workerName: 'my-worker',
* })
* ```
*/
const registerWorker = (address, options) => new Sdk(address, options);

//#endregion
//#region src/logger.ts
/**
* Structured logger that emits logs as OpenTelemetry LogRecords.
*
* Every log call automatically captures the active trace and span context,
* correlating your logs with distributed traces without any manual wiring.
* When OTel is not initialized, Logger gracefully falls back to `console.*`.
*
* Pass structured data as the second argument to any log method. Using an
* object of key-value pairs (instead of string interpolation) lets you
* filter, aggregate, and build dashboards in your observability backend.
*
* @example
* ```typescript
* import { Logger } from 'iii-sdk'
*
* const logger = new Logger()
*
* // Basic logging — trace context is injected automatically
* logger.info('Worker connected')
*
* // Structured context for dashboards and alerting
* logger.info('Order processed', { orderId: 'ord_123', amount: 49.99, currency: 'USD' })
* logger.warn('Retry attempt', { attempt: 3, maxRetries: 5, endpoint: '/api/charge' })
* logger.error('Payment failed', { orderId: 'ord_123', gateway: 'stripe', errorCode: 'card_declined' })
* ```
*/
var Logger = class {
	get otelLogger() {
		if (!this._otelLogger) this._otelLogger = getLogger();
		return this._otelLogger;
	}
	constructor(traceId, serviceName, spanId) {
		this.traceId = traceId;
		this.serviceName = serviceName;
		this.spanId = spanId;
		this._otelLogger = null;
	}
	emit(message, severity, data) {
		const attributes = {};
		const traceId = this.traceId ?? currentTraceId();
		const spanId = this.spanId ?? currentSpanId();
		if (traceId) attributes.trace_id = traceId;
		if (spanId) attributes.span_id = spanId;
		if (this.serviceName) attributes["service.name"] = this.serviceName;
		if (data !== void 0) attributes["log.data"] = data;
		if (this.otelLogger) this.otelLogger.emit({
			severityNumber: severity,
			body: message,
			attributes: Object.keys(attributes).length > 0 ? attributes : void 0
		});
		else switch (severity) {
			case SeverityNumber.DEBUG:
				console.debug(message, data);
				break;
			case SeverityNumber.INFO:
				console.info(message, data);
				break;
			case SeverityNumber.WARN:
				console.warn(message, data);
				break;
			case SeverityNumber.ERROR:
				console.error(message, data);
				break;
			default: console.log(message, data);
		}
	}
	/**
	* Log an info-level message.
	*
	* @param message - Human-readable log message.
	* @param data - Structured context attached as OTel log attributes.
	*   Use key-value objects to enable filtering and aggregation in your
	*   observability backend (e.g. Grafana, Datadog, New Relic).
	*
	* @example
	* ```typescript
	* logger.info('Order processed', { orderId: 'ord_123', status: 'completed' })
	* ```
	*/
	info(message, data) {
		this.emit(message, SeverityNumber.INFO, data);
	}
	/**
	* Log a warning-level message.
	*
	* @param message - Human-readable log message.
	* @param data - Structured context attached as OTel log attributes.
	*   Use key-value objects to enable filtering and aggregation in your
	*   observability backend (e.g. Grafana, Datadog, New Relic).
	*
	* @example
	* ```typescript
	* logger.warn('Retry attempt', { attempt: 3, maxRetries: 5, endpoint: '/api/charge' })
	* ```
	*/
	warn(message, data) {
		this.emit(message, SeverityNumber.WARN, data);
	}
	/**
	* Log an error-level message.
	*
	* @param message - Human-readable log message.
	* @param data - Structured context attached as OTel log attributes.
	*   Use key-value objects to enable filtering and aggregation in your
	*   observability backend (e.g. Grafana, Datadog, New Relic).
	*
	* @example
	* ```typescript
	* logger.error('Payment failed', { orderId: 'ord_123', gateway: 'stripe', errorCode: 'card_declined' })
	* ```
	*/
	error(message, data) {
		this.emit(message, SeverityNumber.ERROR, data);
	}
	/**
	* Log a debug-level message.
	*
	* @param message - Human-readable log message.
	* @param data - Structured context attached as OTel log attributes.
	*   Use key-value objects to enable filtering and aggregation in your
	*   observability backend (e.g. Grafana, Datadog, New Relic).
	*
	* @example
	* ```typescript
	* logger.debug('Cache lookup', { key: 'user:42', hit: false })
	* ```
	*/
	debug(message, data) {
		this.emit(message, SeverityNumber.DEBUG, data);
	}
};

//#endregion
export { ChannelReader, ChannelWriter, Logger, TriggerAction, http, registerWorker };
//# sourceMappingURL=index.mjs.map