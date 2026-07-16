const require_index = require('./index.cjs');
let ws = require("ws");
let _opentelemetry_api = require("@opentelemetry/api");
let node_perf_hooks = require("node:perf_hooks");
let _opentelemetry_resources = require("@opentelemetry/resources");
let _opentelemetry_semantic_conventions = require("@opentelemetry/semantic-conventions");
let node_crypto = require("node:crypto");
let _opentelemetry_sdk_trace_base = require("@opentelemetry/sdk-trace-base");
let _opentelemetry_sdk_metrics = require("@opentelemetry/sdk-metrics");
let _opentelemetry_core = require("@opentelemetry/core");
let _opentelemetry_sdk_trace_node = require("@opentelemetry/sdk-trace-node");
let _opentelemetry_instrumentation = require("@opentelemetry/instrumentation");
let _opentelemetry_sdk_logs = require("@opentelemetry/sdk-logs");
let _opentelemetry_api_logs = require("@opentelemetry/api-logs");
let _opentelemetry_otlp_transformer = require("@opentelemetry/otlp-transformer");

//#region src/iii-constants.ts
/**
* Constants for the III module.
*/
/** Engine function paths for internal operations */
const EngineFunctions = {
	LIST_FUNCTIONS: "engine::functions::list",
	LIST_WORKERS: "engine::workers::list",
	LIST_TRIGGERS: "engine::triggers::list",
	LIST_TRIGGER_TYPES: "engine::trigger-types::list",
	REGISTER_WORKER: "engine::workers::register"
};
/** Engine trigger types */
const EngineTriggers = {
	FUNCTIONS_AVAILABLE: "engine::functions-available",
	LOG: "log"
};
/** Log function paths */
const LogFunctions = {
	INFO: "engine::log::info",
	WARN: "engine::log::warn",
	ERROR: "engine::log::error",
	DEBUG: "engine::log::debug"
};
/** Default reconnection configuration */
const DEFAULT_BRIDGE_RECONNECTION_CONFIG = {
	initialDelayMs: 1e3,
	maxDelayMs: 3e4,
	backoffMultiplier: 2,
	jitterFactor: .3,
	maxRetries: -1
};
/** Default invocation timeout in milliseconds */
const DEFAULT_INVOCATION_TIMEOUT_MS = 3e4;

//#endregion
//#region src/worker-metrics.ts
/**
* Worker metrics collection for the III Node SDK.
*
* Collects CPU, memory, and event loop metrics for worker health monitoring.
* Uses the Node.js built-in `monitorEventLoopDelay` API for accurate
* event loop lag measurements.
*/
/**
* Collects worker resource metrics including CPU, memory, and event loop lag.
*
* Uses the Node.js `monitorEventLoopDelay` API for high-precision event loop
* delay measurements instead of manual `setImmediate` timing.
*
* @example
* ```typescript
* const collector = new WorkerMetricsCollector()
*
* // Collect metrics periodically
* setInterval(() => {
*   const metrics = collector.collect()
*   console.log('CPU:', metrics.cpu_percent, '%')
*   console.log('Event Loop Lag:', metrics.event_loop_lag_ms, 'ms')
* }, 5000)
*
* // Clean up when done
* collector.stopMonitoring()
* ```
*/
var WorkerMetricsCollector = class {
	/**
	* Creates a new WorkerMetricsCollector instance.
	*
	* @param options - Configuration options
	*/
	constructor(options = {}) {
		this.eventLoopHistogram = null;
		this.startTime = Date.now();
		this.lastCpuUsage = process.cpuUsage();
		this.lastCpuTime = node_perf_hooks.performance.now();
		this.startEventLoopMonitoring(options.eventLoopResolutionMs ?? 20);
	}
	/**
	* Starts the event loop delay histogram monitoring.
	*
	* @param resolutionMs - Histogram resolution in milliseconds
	*/
	startEventLoopMonitoring(resolutionMs) {
		this.eventLoopHistogram = (0, node_perf_hooks.monitorEventLoopDelay)({ resolution: Number.isFinite(resolutionMs) && resolutionMs > 0 ? Math.max(1, Math.floor(resolutionMs)) : 20 });
		this.eventLoopHistogram.enable();
	}
	/**
	* Stops the event loop monitoring and releases resources.
	* Should be called when the collector is no longer needed.
	*/
	stopMonitoring() {
		if (this.eventLoopHistogram) {
			this.eventLoopHistogram.disable();
			this.eventLoopHistogram = null;
		}
	}
	/**
	* Collects current worker metrics.
	*
	* This method calculates CPU usage since the last collection,
	* reads memory usage, and gets event loop delay statistics.
	* The event loop histogram is reset after each collection for
	* accurate per-interval measurements.
	*
	* @returns Current worker metrics snapshot
	*/
	collect() {
		const memoryUsage = process.memoryUsage();
		const cpuUsage = process.cpuUsage();
		const now = node_perf_hooks.performance.now();
		const cpuDelta = {
			user: cpuUsage.user - this.lastCpuUsage.user,
			system: cpuUsage.system - this.lastCpuUsage.system
		};
		const timeDelta = (now - this.lastCpuTime) * 1e3;
		const cpuPercent = timeDelta > 0 ? (cpuDelta.user + cpuDelta.system) / timeDelta * 100 : 0;
		this.lastCpuUsage = cpuUsage;
		this.lastCpuTime = now;
		let eventLoopLagMs = 0;
		if (this.eventLoopHistogram) {
			eventLoopLagMs = this.eventLoopHistogram.mean / 1e6;
			this.eventLoopHistogram.reset();
		}
		return {
			memory_heap_used: memoryUsage.heapUsed,
			memory_heap_total: memoryUsage.heapTotal,
			memory_rss: memoryUsage.rss,
			memory_external: memoryUsage.external,
			cpu_user_micros: cpuUsage.user,
			cpu_system_micros: cpuUsage.system,
			cpu_percent: Math.min(cpuPercent, 100),
			event_loop_lag_ms: eventLoopLagMs,
			uptime_seconds: Math.floor((Date.now() - this.startTime) / 1e3),
			timestamp_ms: Date.now(),
			runtime: "node"
		};
	}
};

//#endregion
//#region src/otel-worker-gauges.ts
let registeredGauges = false;
let metricsCollector = null;
let registeredMeter = null;
let registeredBatchCallback = null;
let registeredObservables = [];
function registerWorkerGauges(meter, options) {
	if (registeredGauges) return;
	const { workerId, workerName } = options;
	const baseAttributes = {
		"worker.id": workerId,
		...workerName && { "worker.name": workerName }
	};
	metricsCollector = new WorkerMetricsCollector();
	const memoryHeapUsed = meter.createObservableGauge("iii.worker.memory.heap_used", {
		description: "Worker heap memory used in bytes",
		unit: "bytes"
	});
	const memoryHeapTotal = meter.createObservableGauge("iii.worker.memory.heap_total", {
		description: "Worker total heap memory in bytes",
		unit: "bytes"
	});
	const memoryRss = meter.createObservableGauge("iii.worker.memory.rss", {
		description: "Worker resident set size in bytes",
		unit: "bytes"
	});
	const memoryExternal = meter.createObservableGauge("iii.worker.memory.external", {
		description: "Worker external memory in bytes",
		unit: "bytes"
	});
	const cpuPercent = meter.createObservableGauge("iii.worker.cpu.percent", {
		description: "Worker CPU usage percentage",
		unit: "%"
	});
	const cpuUserMicros = meter.createObservableGauge("iii.worker.cpu.user_micros", {
		description: "Worker CPU user time in microseconds",
		unit: "us"
	});
	const cpuSystemMicros = meter.createObservableGauge("iii.worker.cpu.system_micros", {
		description: "Worker CPU system time in microseconds",
		unit: "us"
	});
	const eventLoopLag = meter.createObservableGauge("iii.worker.event_loop.lag_ms", {
		description: "Worker event loop lag in milliseconds",
		unit: "ms"
	});
	const uptimeSeconds = meter.createObservableGauge("iii.worker.uptime_seconds", {
		description: "Worker uptime in seconds",
		unit: "s"
	});
	const batchCallback = (observableResult) => {
		if (!metricsCollector) return;
		const metrics = metricsCollector.collect();
		if (metrics.memory_heap_used !== void 0) observableResult.observe(memoryHeapUsed, metrics.memory_heap_used, baseAttributes);
		if (metrics.memory_heap_total !== void 0) observableResult.observe(memoryHeapTotal, metrics.memory_heap_total, baseAttributes);
		if (metrics.memory_rss !== void 0) observableResult.observe(memoryRss, metrics.memory_rss, baseAttributes);
		if (metrics.memory_external !== void 0) observableResult.observe(memoryExternal, metrics.memory_external, baseAttributes);
		if (metrics.cpu_percent !== void 0) observableResult.observe(cpuPercent, metrics.cpu_percent, baseAttributes);
		if (metrics.cpu_user_micros !== void 0) observableResult.observe(cpuUserMicros, metrics.cpu_user_micros, baseAttributes);
		if (metrics.cpu_system_micros !== void 0) observableResult.observe(cpuSystemMicros, metrics.cpu_system_micros, baseAttributes);
		if (metrics.event_loop_lag_ms !== void 0) observableResult.observe(eventLoopLag, metrics.event_loop_lag_ms, baseAttributes);
		if (metrics.uptime_seconds !== void 0) observableResult.observe(uptimeSeconds, metrics.uptime_seconds, baseAttributes);
	};
	meter.addBatchObservableCallback(batchCallback, [
		memoryHeapUsed,
		memoryHeapTotal,
		memoryRss,
		memoryExternal,
		cpuPercent,
		cpuUserMicros,
		cpuSystemMicros,
		eventLoopLag,
		uptimeSeconds
	]);
	registeredMeter = meter;
	registeredBatchCallback = batchCallback;
	registeredObservables = [
		memoryHeapUsed,
		memoryHeapTotal,
		memoryRss,
		memoryExternal,
		cpuPercent,
		cpuUserMicros,
		cpuSystemMicros,
		eventLoopLag,
		uptimeSeconds
	];
	registeredGauges = true;
}
function stopWorkerGauges() {
	if (registeredMeter && registeredBatchCallback) registeredMeter.removeBatchObservableCallback(registeredBatchCallback, registeredObservables);
	if (metricsCollector) {
		metricsCollector.stopMonitoring();
		metricsCollector = null;
	}
	registeredMeter = null;
	registeredBatchCallback = null;
	registeredObservables = [];
	registeredGauges = false;
}

//#endregion
//#region src/telemetry-system/types.ts
const ATTR_SERVICE_VERSION = "service.version";
const ATTR_SERVICE_NAMESPACE = "service.namespace";
const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
/** Magic prefixes for binary frames over WebSocket */
const PREFIX_TRACES = "OTLP";
const PREFIX_METRICS = "MTRC";
const PREFIX_LOGS = "LOGS";
/** Default reconnection configuration */
const DEFAULT_RECONNECTION_CONFIG = {
	initialDelayMs: 1e3,
	maxDelayMs: 3e4,
	backoffMultiplier: 2,
	jitterFactor: .3,
	maxRetries: -1
};
/** Default configuration values for OpenTelemetry initialization. */
const DEFAULT_OTEL_CONFIG = {
	enabled: true,
	serviceName: "iii-node",
	serviceVersion: "unknown",
	engineWsUrl: "ws://localhost:49134",
	metricsEnabled: true,
	metricsExportIntervalMs: 6e4,
	logsFlushIntervalMs: 100,
	logsBatchSize: 1,
	fetchInstrumentationEnabled: true
};
/** Parse a boolean environment variable, recognizing 'false', '0', 'no', 'off' as false. */
function parseBoolEnv(value, defaultValue) {
	if (value === void 0) return defaultValue;
	const lower = value.toLowerCase();
	return lower !== "false" && lower !== "0" && lower !== "no" && lower !== "off";
}

//#endregion
//#region src/telemetry-system/connection.ts
/**
* Shared WebSocket connection for OpenTelemetry exporters.
*/
/**
* Shared WebSocket connection for all OTEL exporters (traces, metrics, logs).
* Uses a single connection with message prefixes to identify signal type.
*/
var SharedEngineConnection = class SharedEngineConnection {
	static {
		this.MAX_PENDING_MESSAGES = 1e3;
	}
	constructor(wsUrl, config = {}) {
		this.ws = null;
		this.connecting = false;
		this.shuttingDown = false;
		this.pendingMessages = [];
		this.reconnectAttempt = 0;
		this.reconnectTimeout = null;
		this.state = "disconnected";
		this.onConnectedCallbacks = [];
		this.wsUrl = wsUrl;
		this.config = {
			...DEFAULT_RECONNECTION_CONFIG,
			...config
		};
		this.connect();
	}
	connect() {
		if (this.connecting || this.ws && this.ws.readyState === ws.WebSocket.OPEN) return;
		this.connecting = true;
		this.state = "connecting";
		try {
			this.ws = new ws.WebSocket(this.wsUrl);
			this.ws.on("open", () => {
				this.connecting = false;
				this.state = "connected";
				console.log(`[OTel] Connected to engine at ${this.wsUrl}`);
				if (this.reconnectAttempt > 0) console.log("[OTel] Successfully reconnected");
				this.reconnectAttempt = 0;
				if (this.reconnectTimeout) {
					clearTimeout(this.reconnectTimeout);
					this.reconnectTimeout = null;
				}
				const pending = this.pendingMessages.splice(0, this.pendingMessages.length);
				for (const { frame, callback } of pending) this.ws?.send(frame, (err) => callback?.(err));
				for (const cb of this.onConnectedCallbacks) cb();
			});
			this.ws.on("close", () => {
				this.connecting = false;
				this.ws = null;
				if (this.shuttingDown) {
					this.state = "disconnected";
					console.log("[OTel] Connection closed during shutdown");
					return;
				}
				this.state = "disconnected";
				console.log("[OTel] Disconnected from engine, will reconnect...");
				this.scheduleReconnect();
			});
			this.ws.on("error", (err) => {
				this.connecting = false;
				if (this.shuttingDown) return;
				console.error("[OTel] WebSocket error:", err.message);
			});
		} catch (err) {
			this.connecting = false;
			console.error("[OTel] Connection failed:", err);
			this.scheduleReconnect();
		}
	}
	scheduleReconnect() {
		if (this.config.maxRetries !== -1 && this.reconnectAttempt >= this.config.maxRetries) {
			this.state = "failed";
			console.error(`[OTel] Max retries (${this.config.maxRetries}) reached, giving up`);
			const pending = this.pendingMessages.splice(0, this.pendingMessages.length);
			const failedError = /* @__PURE__ */ new Error("Connection failed after max retries");
			for (const { callback } of pending) callback?.(failedError);
			return;
		}
		if (this.reconnectTimeout) return;
		const exponentialDelay = this.config.initialDelayMs * this.config.backoffMultiplier ** this.reconnectAttempt;
		const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
		const jitter = cappedDelay * this.config.jitterFactor * (2 * Math.random() - 1);
		const delay = Math.max(0, Math.floor(cappedDelay + jitter));
		this.state = "reconnecting";
		console.log(`[OTel] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt + 1})...`);
		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			this.reconnectAttempt++;
			this.connect();
		}, delay);
	}
	/**
	* Send a message with a signal prefix.
	*/
	send(prefix, data, callback) {
		const prefixBytes = Buffer.from(prefix, "utf-8");
		const frame = Buffer.concat([prefixBytes, Buffer.from(data)]);
		if (this.ws && this.ws.readyState === ws.WebSocket.OPEN) this.ws.send(frame, callback);
		else {
			if (this.pendingMessages.length >= SharedEngineConnection.MAX_PENDING_MESSAGES) {
				console.warn("[OTel] Pending message queue full, dropping oldest message");
				this.pendingMessages.shift()?.callback?.(/* @__PURE__ */ new Error("Message dropped due to queue overflow"));
			}
			this.pendingMessages.push({
				frame,
				callback
			});
			this.connect();
		}
	}
	/**
	* Register a callback to be called when connected.
	*/
	onConnected(callback) {
		this.onConnectedCallbacks.push(callback);
		if (this.state === "connected") callback();
	}
	/**
	* Get the current connection state.
	*/
	getState() {
		return this.state;
	}
	/**
	* Shutdown the connection.
	*/
	async shutdown() {
		this.shuttingDown = true;
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		const pending = this.pendingMessages.splice(0, this.pendingMessages.length);
		const shutdownError = /* @__PURE__ */ new Error("Connection shutdown before message could be sent");
		for (const { callback } of pending) callback?.(shutdownError);
		this.onConnectedCallbacks = [];
		this.state = "disconnected";
	}
};

//#endregion
//#region src/telemetry-system/span-exporter.ts
/**
* Span exporter for the III Engine.
*/
/**
* Span exporter using the shared WebSocket connection.
*/
var EngineSpanExporter = class EngineSpanExporter {
	static {
		this.MAX_PENDING_EXPORTS = 100;
	}
	constructor(connection) {
		this.pendingExports = [];
		this.connection = connection;
		this.connection.onConnected(() => this.flushPending());
	}
	flushPending() {
		const pending = this.pendingExports.splice(0, this.pendingExports.length);
		for (const { spans, resultCallback } of pending) this.sendExport(spans, resultCallback);
	}
	sendExport(spans, resultCallback) {
		try {
			const serialized = _opentelemetry_otlp_transformer.JsonTraceSerializer.serializeRequest(spans);
			if (!serialized) {
				resultCallback?.({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
				return;
			}
			this.connection.send(PREFIX_TRACES, serialized, (err) => {
				if (err) {
					console.error("[OTel] Failed to send spans:", err.message);
					resultCallback?.({
						code: _opentelemetry_core.ExportResultCode.FAILED,
						error: err
					});
				} else resultCallback?.({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
			});
		} catch (err) {
			console.error("[OTel] Error exporting spans:", err);
			resultCallback?.({
				code: _opentelemetry_core.ExportResultCode.FAILED,
				error: err
			});
		}
	}
	doExport(spans, resultCallback) {
		if (this.connection.getState() !== "connected") {
			if (this.pendingExports.length >= EngineSpanExporter.MAX_PENDING_EXPORTS) {
				this.pendingExports.shift()?.resultCallback?.({
					code: _opentelemetry_core.ExportResultCode.FAILED,
					error: /* @__PURE__ */ new Error("Queue overflow")
				});
				console.warn("[OTel] Spans export queue full, dropped oldest entry");
			}
			this.pendingExports.push({
				spans,
				resultCallback
			});
			return;
		}
		this.sendExport(spans, resultCallback);
	}
	export(spans, resultCallback) {
		this.doExport(spans, resultCallback);
	}
	async shutdown() {
		const pending = this.pendingExports.splice(0, this.pendingExports.length);
		const shutdownError = /* @__PURE__ */ new Error("Exporter shutdown before export completed");
		for (const { resultCallback } of pending) resultCallback?.({
			code: _opentelemetry_core.ExportResultCode.FAILED,
			error: shutdownError
		});
	}
	async forceFlush() {}
};

//#endregion
//#region src/telemetry-system/metrics-exporter.ts
/**
* Metrics exporter for the III Engine.
*/
/**
* Metrics exporter using the shared WebSocket connection.
*/
var EngineMetricsExporter = class EngineMetricsExporter {
	static {
		this.MAX_PENDING_EXPORTS = 100;
	}
	constructor(connection) {
		this.pendingExports = [];
		this.connection = connection;
		this.connection.onConnected(() => this.flushPending());
	}
	flushPending() {
		const pending = this.pendingExports.splice(0, this.pendingExports.length);
		for (const { metrics, resultCallback } of pending) this.sendExport(metrics, resultCallback);
	}
	sendExport(metricsData, resultCallback) {
		try {
			const serialized = _opentelemetry_otlp_transformer.JsonMetricsSerializer.serializeRequest(metricsData);
			if (!serialized) {
				resultCallback?.({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
				return;
			}
			this.connection.send(PREFIX_METRICS, serialized, (err) => {
				if (err) {
					console.error("[OTel] Failed to send metrics:", err.message);
					resultCallback?.({
						code: _opentelemetry_core.ExportResultCode.FAILED,
						error: err
					});
				} else resultCallback?.({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
			});
		} catch (err) {
			console.error("[OTel] Error exporting metrics:", err);
			resultCallback?.({
				code: _opentelemetry_core.ExportResultCode.FAILED,
				error: err
			});
		}
	}
	doExport(metricsData, resultCallback) {
		if (this.connection.getState() !== "connected") {
			if (this.pendingExports.length >= EngineMetricsExporter.MAX_PENDING_EXPORTS) {
				this.pendingExports.shift()?.resultCallback?.({
					code: _opentelemetry_core.ExportResultCode.FAILED,
					error: /* @__PURE__ */ new Error("Queue overflow")
				});
				console.warn("[OTel] Metrics export queue full, dropped oldest entry");
			}
			this.pendingExports.push({
				metrics: metricsData,
				resultCallback
			});
			return;
		}
		this.sendExport(metricsData, resultCallback);
	}
	export(metrics, resultCallback) {
		this.doExport(metrics, resultCallback);
	}
	async shutdown() {
		const pending = this.pendingExports.splice(0, this.pendingExports.length);
		const shutdownError = /* @__PURE__ */ new Error("Exporter shutdown before export completed");
		for (const { resultCallback } of pending) resultCallback?.({
			code: _opentelemetry_core.ExportResultCode.FAILED,
			error: shutdownError
		});
	}
	async forceFlush() {}
};

//#endregion
//#region src/telemetry-system/log-exporter.ts
/**
* Log exporter for the III Engine.
*/
/**
* Log exporter using the shared WebSocket connection.
*/
var EngineLogExporter = class {
	constructor(connection) {
		this.pendingExports = [];
		this.connection = connection;
		this.connection.onConnected(() => this.flushPending());
	}
	flushPending() {
		const pending = this.pendingExports.splice(0, this.pendingExports.length);
		for (const { logs, callback } of pending) this.doExport(logs, callback);
	}
	doExport(logs, resultCallback) {
		if (this.connection.getState() !== "connected") {
			this.pendingExports.push({
				logs,
				callback: resultCallback
			});
			return;
		}
		try {
			const serialized = _opentelemetry_otlp_transformer.JsonLogsSerializer.serializeRequest(logs);
			if (!serialized) {
				resultCallback({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
				return;
			}
			this.connection.send(PREFIX_LOGS, serialized, (err) => {
				if (err) {
					console.error("[OTel] Failed to send logs:", err.message);
					resultCallback({
						code: _opentelemetry_core.ExportResultCode.FAILED,
						error: err
					});
				} else resultCallback({ code: _opentelemetry_core.ExportResultCode.SUCCESS });
			});
		} catch (err) {
			console.error("[OTel] Error exporting logs:", err);
			resultCallback({
				code: _opentelemetry_core.ExportResultCode.FAILED,
				error: err
			});
		}
	}
	export(logs, resultCallback) {
		this.doExport(logs, resultCallback);
	}
	async shutdown() {
		for (const { callback } of this.pendingExports) callback({
			code: _opentelemetry_core.ExportResultCode.FAILED,
			error: /* @__PURE__ */ new Error("Exporter shutdown")
		});
		this.pendingExports = [];
	}
};

//#endregion
//#region src/telemetry-system/context.ts
/**
* Trace context and baggage propagation utilities.
*/
/**
* Extract the current trace ID from the active span context.
*/
function currentTraceId() {
	const span = _opentelemetry_api.trace.getActiveSpan();
	if (span) {
		const spanContext = span.spanContext();
		if (spanContext.traceId && spanContext.traceId !== "00000000000000000000000000000000") return spanContext.traceId;
	}
}
/**
* Extract the current span ID from the active span context.
*/
function currentSpanId() {
	const span = _opentelemetry_api.trace.getActiveSpan();
	if (span) {
		const spanContext = span.spanContext();
		if (spanContext.spanId && spanContext.spanId !== "0000000000000000") return spanContext.spanId;
	}
}
/**
* Inject the current trace context into a W3C traceparent header string.
*/
function injectTraceparent() {
	const carrier = {};
	_opentelemetry_api.propagation.inject(_opentelemetry_api.context.active(), carrier);
	return carrier.traceparent;
}
/**
* Extract a trace context from a W3C traceparent header string.
*/
function extractTraceparent(traceparent) {
	const carrier = { traceparent };
	return _opentelemetry_api.propagation.extract(_opentelemetry_api.context.active(), carrier);
}
/**
* Inject the current baggage into a W3C baggage header string.
*/
function injectBaggage() {
	const carrier = {};
	_opentelemetry_api.propagation.inject(_opentelemetry_api.context.active(), carrier);
	return carrier.baggage;
}
/**
* Extract baggage from a W3C baggage header string.
*/
function extractBaggage(baggage) {
	const carrier = { baggage };
	return _opentelemetry_api.propagation.extract(_opentelemetry_api.context.active(), carrier);
}
/**
* Extract both trace context and baggage from their respective headers.
*/
function extractContext(traceparent, baggage) {
	const carrier = {};
	if (traceparent) carrier.traceparent = traceparent;
	if (baggage) carrier.baggage = baggage;
	return _opentelemetry_api.propagation.extract(_opentelemetry_api.context.active(), carrier);
}
/**
* Get a baggage entry from the current context.
*/
function getBaggageEntry(key) {
	return _opentelemetry_api.propagation.getBaggage(_opentelemetry_api.context.active())?.getEntry(key)?.value;
}
/**
* Set a baggage entry in the current context.
*/
function setBaggageEntry(key, value) {
	let bag = _opentelemetry_api.propagation.getBaggage(_opentelemetry_api.context.active()) ?? _opentelemetry_api.propagation.createBaggage();
	bag = bag.setEntry(key, { value });
	return _opentelemetry_api.propagation.setBaggage(_opentelemetry_api.context.active(), bag);
}
/**
* Remove a baggage entry from the current context.
*/
function removeBaggageEntry(key) {
	const bag = _opentelemetry_api.propagation.getBaggage(_opentelemetry_api.context.active());
	if (!bag) return _opentelemetry_api.context.active();
	const newBag = bag.removeEntry(key);
	return _opentelemetry_api.propagation.setBaggage(_opentelemetry_api.context.active(), newBag);
}
/**
* Get all baggage entries from the current context.
*/
function getAllBaggage() {
	const bag = _opentelemetry_api.propagation.getBaggage(_opentelemetry_api.context.active());
	if (!bag) return {};
	const entries = {};
	for (const [key, entry] of bag.getAllEntries()) entries[key] = entry.value;
	return entries;
}

//#endregion
//#region src/telemetry-system/fetch-instrumentation.ts
/**
* Global fetch auto-instrumentation for the III Node SDK.
*
* Patches globalThis.fetch to create OTel CLIENT spans for every HTTP request.
* Works on all runtimes (Bun, Node.js, Deno) unlike UndiciInstrumentation
* which only works when fetch is backed by Node.js's undici.
*/
const textEncoder = new TextEncoder();
function getBodyByteSize(body) {
	if (body == null) return void 0;
	if (typeof body === "string") return textEncoder.encode(body).byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	if (ArrayBuffer.isView(body)) return body.byteLength;
	if (body instanceof Blob) return body.size;
	if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).byteLength;
}
const SAFE_REQUEST_HEADERS = ["content-type", "accept"];
const SAFE_RESPONSE_HEADERS = ["content-type"];
let originalFetch = null;
/**
* Patch globalThis.fetch to create OTel CLIENT spans for every HTTP request.
*/
function patchGlobalFetch(tracer) {
	if (originalFetch) return;
	originalFetch = globalThis.fetch;
	const capturedFetch = originalFetch;
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		let host;
		let scheme;
		let path;
		let port;
		let query;
		try {
			const parsed = new URL(url);
			host = parsed.hostname;
			scheme = parsed.protocol.replace(":", "");
			path = parsed.pathname;
			port = parsed.port ? parseInt(parsed.port, 10) : void 0;
			query = parsed.search ? parsed.search.slice(1) : void 0;
		} catch {}
		const spanAttributes = {
			"http.request.method": method,
			"url.full": url
		};
		if (host) spanAttributes["server.address"] = host;
		if (scheme) {
			spanAttributes["url.scheme"] = scheme;
			spanAttributes["network.protocol.name"] = "http";
		}
		if (path) spanAttributes["url.path"] = path;
		if (port) spanAttributes["server.port"] = port;
		if (query) spanAttributes["url.query"] = query;
		const spanName = path ? `${method} ${path}` : method;
		return tracer.startActiveSpan(spanName, {
			kind: _opentelemetry_api.SpanKind.CLIENT,
			attributes: spanAttributes
		}, _opentelemetry_api.context.active(), async (span) => {
			try {
				const carrier = {};
				_opentelemetry_api.propagation.inject(_opentelemetry_api.context.active(), carrier);
				const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
				for (const [key, value] of Object.entries(carrier)) headers.set(key, value);
				for (const name of SAFE_REQUEST_HEADERS) {
					const value = headers.get(name);
					if (value !== null) span.setAttribute(`http.request.header.${name}`, value);
				}
				const requestBodySize = getBodyByteSize(init?.body ?? (input instanceof Request ? input.body : void 0));
				if (requestBodySize !== void 0) span.setAttribute("http.request.body.size", requestBodySize);
				const response = await capturedFetch(input, {
					...init,
					headers
				});
				span.setAttribute("http.response.status_code", response.status);
				const contentLength = response.headers.get("content-length");
				if (contentLength !== null) {
					const size = parseInt(contentLength, 10);
					if (!Number.isNaN(size)) span.setAttribute("http.response.body.size", size);
				}
				for (const name of SAFE_RESPONSE_HEADERS) {
					const value = response.headers.get(name);
					if (value !== null) span.setAttribute(`http.response.header.${name}`, value);
				}
				if (response.status >= 400) {
					span.setAttribute("error.type", String(response.status));
					span.setStatus({ code: _opentelemetry_api.SpanStatusCode.ERROR });
				} else span.setStatus({ code: _opentelemetry_api.SpanStatusCode.OK });
				return response;
			} catch (error) {
				span.setAttribute("error.type", error.name ?? "Error");
				span.setStatus({
					code: _opentelemetry_api.SpanStatusCode.ERROR,
					message: error.message
				});
				span.recordException(error);
				throw error;
			} finally {
				span.end();
			}
		});
	};
}
/**
* Restore globalThis.fetch to its original implementation.
*/
function unpatchGlobalFetch() {
	if (originalFetch) {
		globalThis.fetch = originalFetch;
		originalFetch = null;
	}
}

//#endregion
//#region src/telemetry-system/utils.ts
/**
* Parse a numeric environment variable with optional minimum bound.
*/
function parseNumberEnv(value, minimum = 0) {
	if (value === void 0) return void 0;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < minimum) return void 0;
	return parsed;
}
/**
* Parse an integer environment variable with optional minimum bound.
*/
function parseIntegerEnv(value, minimum = 0) {
	const parsed = parseNumberEnv(value, minimum);
	if (parsed === void 0 || !Number.isInteger(parsed)) return void 0;
	return parsed;
}

//#endregion
//#region src/telemetry-system/index.ts
/**
* OpenTelemetry initialization for the III Node SDK.
*
* This module provides trace, metrics, and log export to the III Engine
* via a shared WebSocket connection using OTLP JSON format.
*/
/**
* Normalize an engine WebSocket URL into the dedicated OTEL endpoint.
* The engine exposes `/otel` for telemetry-only WS connections; routing
* there keeps this socket out of the worker registry (otherwise it shows
* up as a ghost null-metadata worker).
*/
function appendOtelPath(base) {
	const url = new URL(base);
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/otel") ? path : `${path}/otel`;
	return url.toString();
}
let sharedConnection = null;
let tracerProvider = null;
let meterProvider = null;
let loggerProvider = null;
let tracer = null;
let meter = null;
let logger = null;
let serviceName = "iii-node-iii";
/**
* Initialize OpenTelemetry with the given configuration.
* This should be called once at application startup.
*/
function initOtel(config = {}) {
	if (!(config.enabled ?? parseBoolEnv(process.env.OTEL_ENABLED, DEFAULT_OTEL_CONFIG.enabled))) {
		console.debug("[OTel] OpenTelemetry is disabled. To enable, remove OTEL_ENABLED=false or set enabled: true in config.");
		return;
	}
	serviceName = config.serviceName ?? process.env.OTEL_SERVICE_NAME ?? DEFAULT_OTEL_CONFIG.serviceName;
	const serviceVersion = config.serviceVersion ?? process.env.SERVICE_VERSION ?? DEFAULT_OTEL_CONFIG.serviceVersion;
	const serviceNamespace = config.serviceNamespace ?? process.env.SERVICE_NAMESPACE;
	const serviceInstanceId = config.serviceInstanceId ?? process.env.SERVICE_INSTANCE_ID ?? (0, node_crypto.randomUUID)();
	const engineWsUrl = config.engineWsUrl ?? process.env.III_URL ?? DEFAULT_OTEL_CONFIG.engineWsUrl;
	const resourceAttributes = {
		[_opentelemetry_semantic_conventions.ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
		[ATTR_SERVICE_INSTANCE_ID]: serviceInstanceId
	};
	if (serviceNamespace) resourceAttributes[ATTR_SERVICE_NAMESPACE] = serviceNamespace;
	const resource = new _opentelemetry_resources.Resource(resourceAttributes);
	sharedConnection = new SharedEngineConnection(appendOtelPath(engineWsUrl), config.reconnectionConfig);
	tracerProvider = new _opentelemetry_sdk_trace_node.NodeTracerProvider({
		resource,
		spanProcessors: [new _opentelemetry_sdk_trace_base.BatchSpanProcessor(new EngineSpanExporter(sharedConnection))]
	});
	_opentelemetry_api.propagation.setGlobalPropagator(new _opentelemetry_core.CompositePropagator({ propagators: [new _opentelemetry_core.W3CTraceContextPropagator(), new _opentelemetry_core.W3CBaggagePropagator()] }));
	tracerProvider.register();
	tracer = _opentelemetry_api.trace.getTracer(serviceName);
	console.debug(`[OTel] Traces initialized: engine=${engineWsUrl}, service=${serviceName}`);
	if (config.metricsEnabled ?? parseBoolEnv(process.env.OTEL_METRICS_ENABLED, DEFAULT_OTEL_CONFIG.metricsEnabled)) {
		const metricsExporter = new EngineMetricsExporter(sharedConnection);
		const exportIntervalMs = config.metricsExportIntervalMs ?? DEFAULT_OTEL_CONFIG.metricsExportIntervalMs;
		meterProvider = new _opentelemetry_sdk_metrics.MeterProvider({
			resource,
			readers: [new _opentelemetry_sdk_metrics.PeriodicExportingMetricReader({
				exporter: metricsExporter,
				exportIntervalMillis: exportIntervalMs
			})]
		});
		_opentelemetry_api.metrics.setGlobalMeterProvider(meterProvider);
		meter = meterProvider.getMeter(serviceName);
		console.debug(`[OTel] Metrics initialized: interval=${exportIntervalMs}ms`);
	}
	const instrumentations = [...config.instrumentations ?? []];
	if (instrumentations.length > 0) {
		(0, _opentelemetry_instrumentation.registerInstrumentations)({
			instrumentations,
			tracerProvider,
			meterProvider: meterProvider ?? void 0
		});
		console.debug(`[OTel] Instrumentations registered: ${instrumentations.length} total`);
	}
	if (config.fetchInstrumentationEnabled ?? DEFAULT_OTEL_CONFIG.fetchInstrumentationEnabled) {
		patchGlobalFetch(tracer);
		console.debug("[OTel] Global fetch instrumentation enabled");
	}
	const logExporter = new EngineLogExporter(sharedConnection);
	const logsScheduledDelayMillis = config.logsFlushIntervalMs ?? parseNumberEnv(process.env.OTEL_LOGS_FLUSH_INTERVAL_MS, 0) ?? DEFAULT_OTEL_CONFIG.logsFlushIntervalMs;
	const logsMaxExportBatchSize = config.logsBatchSize ?? parseIntegerEnv(process.env.OTEL_LOGS_BATCH_SIZE, 1) ?? DEFAULT_OTEL_CONFIG.logsBatchSize;
	loggerProvider = new _opentelemetry_sdk_logs.LoggerProvider({ resource });
	loggerProvider.addLogRecordProcessor(new _opentelemetry_sdk_logs.BatchLogRecordProcessor(logExporter, {
		scheduledDelayMillis: logsScheduledDelayMillis,
		maxExportBatchSize: logsMaxExportBatchSize
	}));
	logger = loggerProvider.getLogger(serviceName);
	console.debug(`[OTel] Logs initialized: delay=${logsScheduledDelayMillis}ms, batch=${logsMaxExportBatchSize}`);
}
/**
* Shutdown OpenTelemetry, flushing any pending data.
*/
async function shutdownOtel() {
	if (tracerProvider) {
		await tracerProvider.forceFlush();
		await tracerProvider.shutdown();
		tracerProvider = null;
	}
	if (meterProvider) {
		await meterProvider.forceFlush();
		await meterProvider.shutdown();
		meterProvider = null;
	}
	if (loggerProvider) {
		await loggerProvider.forceFlush();
		await loggerProvider.shutdown();
		loggerProvider = null;
	}
	if (sharedConnection) {
		await sharedConnection.shutdown();
		sharedConnection = null;
	}
	unpatchGlobalFetch();
	tracer = null;
	meter = null;
	logger = null;
}
/**
* Get the OpenTelemetry tracer instance.
*/
function getTracer() {
	return tracer;
}
/**
* Get the OpenTelemetry meter instance.
*/
function getMeter() {
	return meter;
}
/**
* Get the OpenTelemetry logger instance.
*/
function getLogger() {
	return logger;
}
/**
* Start a new span with the given name and run the callback within it.
*/
async function withSpan(name, options, fn) {
	if (!tracer) {
		const noopSpan = {
			spanContext: () => ({
				traceId: "",
				spanId: "",
				traceFlags: 0
			}),
			setAttribute: () => noopSpan,
			setAttributes: () => noopSpan,
			addEvent: () => noopSpan,
			addLink: () => noopSpan,
			setStatus: () => noopSpan,
			updateName: () => noopSpan,
			end: () => {},
			isRecording: () => false,
			recordException: () => {},
			addLinks: () => noopSpan
		};
		return fn(noopSpan);
	}
	const parentContext = options.traceparent ? extractTraceparent(options.traceparent) : _opentelemetry_api.context.active();
	return tracer.startActiveSpan(name, { kind: options.kind ?? _opentelemetry_api.SpanKind.INTERNAL }, parentContext, async (span) => {
		try {
			const result = await fn(span);
			span.setStatus({ code: _opentelemetry_api.SpanStatusCode.OK });
			return result;
		} catch (error) {
			span.setStatus({
				code: _opentelemetry_api.SpanStatusCode.ERROR,
				message: error.message
			});
			span.recordException(error);
			throw error;
		} finally {
			span.end();
		}
	});
}

//#endregion
//#region src/utils.ts
/**
* Safely stringify a value, handling circular references, BigInt, and other edge cases.
* Returns "[unserializable]" if serialization fails for any reason.
*/
function safeStringify(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	try {
		return JSON.stringify(value, (_key, val) => {
			if (typeof val === "bigint") return val.toString();
			if (val !== null && typeof val === "object") {
				if (seen.has(val)) return "[Circular]";
				seen.add(val);
			}
			return val;
		});
	} catch {
		return "[unserializable]";
	}
}
/**
* Helper that wraps an HTTP-style handler (with separate `req`/`res` arguments)
* into the function handler format expected by the SDK.
*
* @param callback - Async handler receiving an {@link HttpRequest} and {@link HttpResponse}.
* @returns A function handler compatible with {@link ISdk.registerFunction}.
*
* @example
* ```typescript
* import { http } from 'iii-sdk'
*
* iii.registerFunction(
*   'my-api',
*   http(async (req, res) => {
*     res.status(200)
*     res.headers({ 'content-type': 'application/json' })
*     res.stream.end(JSON.stringify({ hello: 'world' }))
*     res.close()
*   }),
* )
* ```
*/
const http = (callback) => {
	return async (req) => {
		const { response, ...request } = req;
		return callback(request, {
			status: (status_code) => response.sendMessage(JSON.stringify({
				type: "set_status",
				status_code
			})),
			headers: (headers) => response.sendMessage(JSON.stringify({
				type: "set_headers",
				headers
			})),
			stream: response.stream,
			close: () => response.close()
		});
	};
};
/**
* Type guard that checks if a value is a {@link StreamChannelRef}.
*
* @param value - Value to check.
* @returns `true` if the value is a valid `StreamChannelRef`.
*/
const isChannelRef = (value) => {
	if (typeof value !== "object" || value === null) return false;
	const maybe = value;
	return typeof maybe.channel_id === "string" && typeof maybe.access_key === "string" && (maybe.direction === "read" || maybe.direction === "write");
};

//#endregion
Object.defineProperty(exports, 'DEFAULT_BRIDGE_RECONNECTION_CONFIG', {
  enumerable: true,
  get: function () {
    return DEFAULT_BRIDGE_RECONNECTION_CONFIG;
  }
});
Object.defineProperty(exports, 'DEFAULT_INVOCATION_TIMEOUT_MS', {
  enumerable: true,
  get: function () {
    return DEFAULT_INVOCATION_TIMEOUT_MS;
  }
});
Object.defineProperty(exports, 'EngineFunctions', {
  enumerable: true,
  get: function () {
    return EngineFunctions;
  }
});
Object.defineProperty(exports, 'EngineTriggers', {
  enumerable: true,
  get: function () {
    return EngineTriggers;
  }
});
Object.defineProperty(exports, 'LogFunctions', {
  enumerable: true,
  get: function () {
    return LogFunctions;
  }
});
Object.defineProperty(exports, 'WorkerMetricsCollector', {
  enumerable: true,
  get: function () {
    return WorkerMetricsCollector;
  }
});
Object.defineProperty(exports, 'currentSpanId', {
  enumerable: true,
  get: function () {
    return currentSpanId;
  }
});
Object.defineProperty(exports, 'currentTraceId', {
  enumerable: true,
  get: function () {
    return currentTraceId;
  }
});
Object.defineProperty(exports, 'extractBaggage', {
  enumerable: true,
  get: function () {
    return extractBaggage;
  }
});
Object.defineProperty(exports, 'extractContext', {
  enumerable: true,
  get: function () {
    return extractContext;
  }
});
Object.defineProperty(exports, 'extractTraceparent', {
  enumerable: true,
  get: function () {
    return extractTraceparent;
  }
});
Object.defineProperty(exports, 'getAllBaggage', {
  enumerable: true,
  get: function () {
    return getAllBaggage;
  }
});
Object.defineProperty(exports, 'getBaggageEntry', {
  enumerable: true,
  get: function () {
    return getBaggageEntry;
  }
});
Object.defineProperty(exports, 'getLogger', {
  enumerable: true,
  get: function () {
    return getLogger;
  }
});
Object.defineProperty(exports, 'getMeter', {
  enumerable: true,
  get: function () {
    return getMeter;
  }
});
Object.defineProperty(exports, 'getTracer', {
  enumerable: true,
  get: function () {
    return getTracer;
  }
});
Object.defineProperty(exports, 'http', {
  enumerable: true,
  get: function () {
    return http;
  }
});
Object.defineProperty(exports, 'initOtel', {
  enumerable: true,
  get: function () {
    return initOtel;
  }
});
Object.defineProperty(exports, 'injectBaggage', {
  enumerable: true,
  get: function () {
    return injectBaggage;
  }
});
Object.defineProperty(exports, 'injectTraceparent', {
  enumerable: true,
  get: function () {
    return injectTraceparent;
  }
});
Object.defineProperty(exports, 'isChannelRef', {
  enumerable: true,
  get: function () {
    return isChannelRef;
  }
});
Object.defineProperty(exports, 'registerWorkerGauges', {
  enumerable: true,
  get: function () {
    return registerWorkerGauges;
  }
});
Object.defineProperty(exports, 'removeBaggageEntry', {
  enumerable: true,
  get: function () {
    return removeBaggageEntry;
  }
});
Object.defineProperty(exports, 'safeStringify', {
  enumerable: true,
  get: function () {
    return safeStringify;
  }
});
Object.defineProperty(exports, 'setBaggageEntry', {
  enumerable: true,
  get: function () {
    return setBaggageEntry;
  }
});
Object.defineProperty(exports, 'shutdownOtel', {
  enumerable: true,
  get: function () {
    return shutdownOtel;
  }
});
Object.defineProperty(exports, 'stopWorkerGauges', {
  enumerable: true,
  get: function () {
    return stopWorkerGauges;
  }
});
Object.defineProperty(exports, 'withSpan', {
  enumerable: true,
  get: function () {
    return withSpan;
  }
});
//# sourceMappingURL=utils-SC0gzoUa.cjs.map