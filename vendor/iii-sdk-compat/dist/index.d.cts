import { Ct as TriggerRequest, G as OtelConfig, Q as IIIReconnectionConfig, S as TriggerHandler, St as TriggerInfo, _ as RegisterTriggerTypeInput, _t as RegisterFunctionMessage, a as Channel, b as TriggerTypeRef, bt as StreamChannelRef, c as HttpRequest, ct as MessageType, d as InternalHttpRequest, dt as OnFunctionRegistrationResult, et as ChannelReader, ft as OnTriggerRegistrationInput, g as RegisterTriggerInput, h as RegisterServiceInput, ht as OnTriggerTypeRegistrationResult, i as ApiResponse, it as EnqueueResult, l as HttpResponse, lt as MiddlewareFunctionInput, m as RegisterFunctionOptions, mt as OnTriggerTypeRegistrationInput, nt as AuthInput, o as FunctionRef, ot as HttpAuthConfig, p as RegisterFunctionInput, pt as OnTriggerRegistrationResult, r as ApiRequest, rt as AuthResult, st as HttpInvocationConfig, t as http, tt as ChannelWriter, u as ISdk, ut as OnFunctionRegistrationInput, v as RemoteFunctionHandler, vt as RegisterTriggerMessage, wt as TriggerTypeInfo, x as TriggerConfig, xt as TriggerAction$1, y as Trigger, yt as RegisterTriggerTypeMessage } from "./utils-DG5t0Scx.cjs";

//#region src/iii.d.ts
/** @internal */
type TelemetryOptions = {
  language?: string;
  project_name?: string;
  framework?: string;
  amplitude_api_key?: string;
};
/**
 * Configuration options passed to {@link registerWorker}.
 *
 * @example
 * ```typescript
 * const iii = registerWorker('ws://localhost:49134', {
 *   workerName: 'my-worker',
 *   invocationTimeoutMs: 10000,
 *   reconnectionConfig: { maxRetries: 5 },
 * })
 * ```
 */
type InitOptions = {
  /** Display name for this worker. Defaults to `hostname:pid`. */workerName?: string; /** Enable worker metrics via OpenTelemetry. Defaults to `true`. */
  enableMetricsReporting?: boolean; /** Default timeout for `trigger()` in milliseconds. Defaults to `30000`. */
  invocationTimeoutMs?: number;
  /**
   * WebSocket reconnection behavior.
   *
   * @see {@link IIIReconnectionConfig} for available fields and defaults.
   */
  reconnectionConfig?: Partial<IIIReconnectionConfig>;
  /**
   * OpenTelemetry configuration. OTel is initialized automatically by default.
   * Set `{ enabled: false }` or env `OTEL_ENABLED=false/0/no/off` to disable.
   * The `engineWsUrl` is set automatically from the III address.
   */
  otel?: Omit<OtelConfig, 'engineWsUrl'>; /** Custom HTTP headers sent during the WebSocket handshake. */
  headers?: Record<string, string>; /** @internal */
  telemetry?: TelemetryOptions;
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
declare const TriggerAction: {
  /**
   * Routes the invocation through a named queue. The engine enqueues the job,
   * acknowledges the caller with `{ messageReceiptId }`, and processes it
   * asynchronously.
   *
   * @param opts - Queue routing options.
   * @param opts.queue - Name of the target queue.
   */
  readonly Enqueue: (opts: {
    queue: string;
  }) => TriggerAction$1;
  /**
   * Fire-and-forget routing. The engine forwards the invocation without
   * waiting for a response or queuing the job.
   */
  readonly Void: () => TriggerAction$1;
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
declare const registerWorker: (address: string, options?: InitOptions) => ISdk;
//#endregion
//#region src/logger.d.ts
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
declare class Logger {
  private readonly traceId?;
  private readonly serviceName?;
  private readonly spanId?;
  private _otelLogger;
  private get otelLogger();
  constructor(traceId?: string | undefined, serviceName?: string | undefined, spanId?: string | undefined);
  private emit;
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
  info(message: string, data?: unknown): void;
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
  warn(message: string, data?: unknown): void;
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
  error(message: string, data?: unknown): void;
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
  debug(message: string, data?: unknown): void;
}
//#endregion
export { type ApiRequest, type ApiResponse, type AuthInput, type AuthResult, type Channel, ChannelReader, ChannelWriter, type EnqueueResult, type FunctionRef, type HttpAuthConfig, type HttpInvocationConfig, type HttpRequest, type HttpResponse, type ISdk, type InitOptions, type InternalHttpRequest, Logger, type MessageType, type MiddlewareFunctionInput, type OnFunctionRegistrationInput, type OnFunctionRegistrationResult, type OnTriggerRegistrationInput, type OnTriggerRegistrationResult, type OnTriggerTypeRegistrationInput, type OnTriggerTypeRegistrationResult, type RegisterFunctionInput, type RegisterFunctionMessage, type RegisterFunctionOptions, type RegisterServiceInput, type RegisterTriggerInput, type RegisterTriggerMessage, type RegisterTriggerTypeInput, type RegisterTriggerTypeMessage, type RemoteFunctionHandler, type StreamChannelRef, type Trigger, TriggerAction, type TriggerAction$1 as TriggerActionType, type TriggerConfig, type TriggerHandler, type TriggerInfo, type TriggerRequest, type TriggerTypeInfo, type TriggerTypeRef, http, registerWorker };
//# sourceMappingURL=index.d.cts.map