import { $ as LogFunctions, A as getTracer, B as getBaggageEntry, C as Logger, D as SpanStatusCode, E as Span, Et as WorkerStatus, F as currentTraceId, G as OtelConfig, H as injectTraceparent, I as extractBaggage, J as DEFAULT_INVOCATION_TIMEOUT_MS, K as ReconnectionConfig, L as extractContext, M as shutdownOtel, N as withSpan, O as getLogger, P as currentSpanId, Q as IIIReconnectionConfig, R as extractTraceparent, T as SeverityNumber, Tt as WorkerInfo, U as removeBaggageEntry, V as injectBaggage, W as setBaggageEntry, X as EngineTriggers, Y as EngineFunctions, Z as IIIConnectionState, at as FunctionInfo, f as OtelLogEvent, gt as RegisterFunctionFormat, j as initOtel, k as getMeter, n as safeStringify, q as DEFAULT_BRIDGE_RECONNECTION_CONFIG, s as FunctionsAvailableCallback, w as Meter, z as getAllBaggage } from "./utils-DG5t0Scx.cjs";
import { Meter as Meter$1 } from "@opentelemetry/api";

//#region src/otel-worker-gauges.d.ts
interface WorkerGaugesOptions {
  workerId: string;
  workerName?: string;
}
declare function registerWorkerGauges(meter: Meter$1, options: WorkerGaugesOptions): void;
declare function stopWorkerGauges(): void;
//#endregion
//#region src/worker-metrics.d.ts
/**
 * Worker metrics collection for the III Node SDK.
 *
 * Collects CPU, memory, and event loop metrics for worker health monitoring.
 * Uses the Node.js built-in `monitorEventLoopDelay` API for accurate
 * event loop lag measurements.
 */
/**
 * Worker metrics data structure used internally for OTEL metric collection.
 */
type WorkerMetrics = {
  memory_heap_used?: number;
  memory_heap_total?: number;
  memory_rss?: number;
  memory_external?: number;
  cpu_user_micros?: number;
  cpu_system_micros?: number;
  cpu_percent?: number;
  event_loop_lag_ms?: number;
  uptime_seconds?: number;
  timestamp_ms: number;
  runtime: string;
};
/**
 * Configuration options for the WorkerMetricsCollector.
 */
interface WorkerMetricsCollectorOptions {
  /**
   * Event loop delay histogram resolution in milliseconds.
   * Lower values provide more accurate measurements but use more resources.
   * @default 20
   */
  eventLoopResolutionMs?: number;
}
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
declare class WorkerMetricsCollector {
  private readonly startTime;
  private lastCpuUsage;
  private lastCpuTime;
  private eventLoopHistogram;
  /**
   * Creates a new WorkerMetricsCollector instance.
   *
   * @param options - Configuration options
   */
  constructor(options?: WorkerMetricsCollectorOptions);
  /**
   * Starts the event loop delay histogram monitoring.
   *
   * @param resolutionMs - Histogram resolution in milliseconds
   */
  private startEventLoopMonitoring;
  /**
   * Stops the event loop monitoring and releases resources.
   * Should be called when the collector is no longer needed.
   */
  stopMonitoring(): void;
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
  collect(): WorkerMetrics;
}
//#endregion
export { DEFAULT_BRIDGE_RECONNECTION_CONFIG, DEFAULT_INVOCATION_TIMEOUT_MS, EngineFunctions, EngineTriggers, type FunctionInfo, type FunctionInfo as FunctionMessage, type FunctionsAvailableCallback, type IIIConnectionState, type IIIReconnectionConfig, LogFunctions, type Meter, type OtelConfig, type OtelLogEvent, type Logger as OtelLogger, type ReconnectionConfig, type RegisterFunctionFormat, SeverityNumber, type Span, SpanStatusCode, type WorkerGaugesOptions, type WorkerInfo, type WorkerMetrics, WorkerMetricsCollector, type WorkerMetricsCollectorOptions, type WorkerStatus, currentSpanId, currentTraceId, extractBaggage, extractContext, extractTraceparent, getAllBaggage, getBaggageEntry, getLogger, getMeter, getTracer, initOtel, injectBaggage, injectTraceparent, registerWorkerGauges, removeBaggageEntry, safeStringify, setBaggageEntry, shutdownOtel, stopWorkerGauges, withSpan };
//# sourceMappingURL=telemetry.d.cts.map