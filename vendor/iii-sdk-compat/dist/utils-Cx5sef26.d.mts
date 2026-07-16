import { n as IStream } from "./stream-BkrU83KD.mjs";
import { Readable, Writable } from "node:stream";
import { Context, Meter as Meter$1, Span, SpanKind as SpanKind$1, SpanStatusCode as SpanStatusCode$1, Tracer } from "@opentelemetry/api";
import { Instrumentation } from "@opentelemetry/instrumentation";
import { Logger, SeverityNumber as SeverityNumber$1 } from "@opentelemetry/api-logs";

//#region src/iii-types.d.ts
declare enum MessageType {
  RegisterFunction = "registerfunction",
  UnregisterFunction = "unregisterfunction",
  RegisterService = "registerservice",
  InvokeFunction = "invokefunction",
  InvocationResult = "invocationresult",
  RegisterTriggerType = "registertriggertype",
  RegisterTrigger = "registertrigger",
  UnregisterTrigger = "unregistertrigger",
  UnregisterTriggerType = "unregistertriggertype",
  TriggerRegistrationResult = "triggerregistrationresult",
  WorkerRegistered = "workerregistered"
}
type RegisterTriggerTypeMessage = {
  message_type: MessageType.RegisterTriggerType;
  id: string;
  description: string;
};
type RegisterTriggerMessage = {
  message_type: MessageType.RegisterTrigger;
  id: string;
  type: string;
  function_id: string;
  config: unknown;
  metadata?: Record<string, unknown>;
};
type RegisterServiceMessage = {
  message_type: MessageType.RegisterService;
  id: string;
  name?: string;
  description?: string;
  parent_service_id?: string;
};
/**
 * Authentication configuration for HTTP-invoked functions.
 *
 * - `hmac` -- HMAC signature verification using a shared secret.
 * - `bearer` -- Bearer token authentication.
 * - `api_key` -- API key sent via a custom header.
 */
type HttpAuthConfig = {
  type: 'hmac';
  secret_key: string;
} | {
  type: 'bearer';
  token_key: string;
} | {
  type: 'api_key';
  header: string;
  value_key: string;
};
/**
 * Configuration for registering an HTTP-invoked function (Lambda, Cloudflare
 * Workers, etc.) instead of a local handler.
 */
type HttpInvocationConfig = {
  /** URL to invoke. */url: string; /** HTTP method. Defaults to `POST`. */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; /** Timeout in milliseconds. */
  timeout_ms?: number; /** Custom headers to send with the request. */
  headers?: Record<string, string>; /** Authentication configuration. */
  auth?: HttpAuthConfig;
};
type RegisterFunctionFormat = {
  /**
   * The name of the parameter
   */
  name?: string;
  /**
   * The description of the parameter
   */
  description?: string;
  /**
   * The type of the parameter
   */
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null' | 'map' | 'integer';
  /**
   * The body of the parameter (for objects)
   */
  properties?: Record<string, unknown>;
  /**
   * The items of the parameter (for arrays)
   */
  items?: unknown;
  /**
   * Whether the parameter is required
   */
  required?: string[];
  [key: string]: unknown;
};
type RegisterFunctionMessage = {
  message_type: MessageType.RegisterFunction;
  /**
   * The path of the function (use :: for namespacing, e.g. external::my_lambda)
   */
  id: string;
  /**
   * The description of the function
   */
  description?: string;
  /**
   * The request format of the function
   */
  request_format?: RegisterFunctionFormat;
  /**
   * The response format of the function
   */
  response_format?: RegisterFunctionFormat;
  metadata?: Record<string, unknown>;
  /**
   * HTTP invocation config for external HTTP functions (Lambda, Cloudflare Workers, etc.)
   */
  invocation?: HttpInvocationConfig;
};
/**
 * Routing action for {@link TriggerRequest}. Determines how the engine
 * handles the invocation.
 *
 * - `enqueue` -- Routes through a named queue for async processing.
 * - `void` -- Fire-and-forget, no response.
 */
type TriggerAction = {
  type: 'enqueue';
  queue: string;
} | {
  type: 'void';
};
/**
 * Input passed to the RBAC auth function during WebSocket upgrade.
 * Contains the HTTP headers, query parameters, and client IP from the
 * connecting worker's upgrade request.
 */
type AuthInput = {
  /** HTTP headers from the WebSocket upgrade request. */headers: Record<string, string>; /** Query parameters from the upgrade URL. Each key maps to an array of values to support repeated keys. */
  query_params: Record<string, string[]>; /** IP address of the connecting client. */
  ip_address: string;
};
/**
 * Return value from the RBAC auth function. Controls which functions the
 * authenticated worker can invoke and what context is forwarded to the
 * middleware.
 */
type AuthResult = {
  /** Additional function IDs to allow beyond the `expose_functions` config. */allowed_functions: string[]; /** Function IDs to deny even if they match `expose_functions`. Takes precedence over allowed. */
  forbidden_functions: string[]; /** Trigger type IDs the worker may register triggers for. When omitted, all types are allowed. */
  allowed_trigger_types?: string[]; /** Whether the worker may register new trigger types. */
  allow_trigger_type_registration: boolean; /** Whether the worker may register new functions. Defaults to `true` if omitted. */
  allow_function_registration?: boolean; /** Arbitrary context forwarded to the middleware function on every invocation. */
  context: Record<string, unknown>; /** Optional prefix applied to all function IDs registered by this worker. */
  function_registration_prefix?: string;
};
/**
 * Input passed to the RBAC middleware function on every function invocation
 * through the RBAC port. The middleware can inspect, modify, or reject the
 * call before it reaches the target function.
 */
type MiddlewareFunctionInput = {
  /** ID of the function being invoked. */function_id: string; /** Payload sent by the caller. */
  payload: Record<string, unknown>; /** Routing action, if any. */
  action?: TriggerAction; /** Auth context returned by the auth function for this session. */
  context: Record<string, unknown>;
};
/**
 * Input passed to the `on_trigger_type_registration_function_id` hook
 * when a worker attempts to register a new trigger type through the RBAC port.
 * Return an {@link OnTriggerTypeRegistrationResult} with the (possibly mapped)
 * fields, or throw to deny the registration.
 */
type OnTriggerTypeRegistrationInput = {
  /** ID of the trigger type being registered. */trigger_type_id: string; /** Human-readable description of the trigger type. */
  description: string; /** Auth context from `AuthResult.context` for this session. */
  context: Record<string, unknown>;
};
/**
 * Result returned from the `on_trigger_type_registration_function_id` hook.
 * All fields are optional -- omitted fields keep the original value from the
 * registration request.
 */
type OnTriggerTypeRegistrationResult = {
  /** Mapped trigger type ID. */trigger_type_id?: string; /** Mapped description. */
  description?: string;
};
/**
 * Input passed to the `on_trigger_registration_function_id` hook
 * when a worker attempts to register a trigger through the RBAC port.
 * Return an {@link OnTriggerRegistrationResult} with the (possibly mapped)
 * fields, or throw to deny the registration.
 */
type OnTriggerRegistrationInput = {
  /** ID of the trigger being registered. */trigger_id: string; /** Trigger type identifier. */
  trigger_type: string; /** ID of the function this trigger is bound to. */
  function_id: string; /** Trigger-specific configuration. */
  config: unknown; /** Arbitrary metadata attached to the trigger. */
  metadata?: Record<string, unknown>; /** Auth context from `AuthResult.context` for this session. */
  context: Record<string, unknown>;
};
/**
 * Result returned from the `on_trigger_registration_function_id` hook.
 * All fields are optional -- omitted fields keep the original value from the
 * registration request.
 */
type OnTriggerRegistrationResult = {
  /** Mapped trigger ID. */trigger_id?: string; /** Mapped trigger type. */
  trigger_type?: string; /** Mapped function ID. */
  function_id?: string; /** Mapped trigger configuration. */
  config?: unknown;
};
/**
 * Input passed to the `on_function_registration_function_id` hook
 * when a worker attempts to register a function through the RBAC port.
 * Return an {@link OnFunctionRegistrationResult} with the (possibly mapped)
 * fields, or throw to deny the registration.
 */
type OnFunctionRegistrationInput = {
  /** ID of the function being registered. */function_id: string; /** Human-readable description of the function. */
  description?: string; /** Arbitrary metadata attached to the function. */
  metadata?: Record<string, unknown>; /** Auth context from `AuthResult.context` for this session. */
  context: Record<string, unknown>;
};
/**
 * Result returned from the `on_function_registration_function_id` hook.
 * All fields are optional -- omitted fields keep the original value from the
 * registration request.
 */
type OnFunctionRegistrationResult = {
  /** Mapped function ID. */function_id?: string; /** Mapped description. */
  description?: string; /** Mapped metadata. */
  metadata?: Record<string, unknown>;
};
/**
 * Result returned when a function is invoked with `TriggerAction.Enqueue`.
 */
type EnqueueResult = {
  /** Unique receipt ID for the enqueued message. */messageReceiptId: string;
};
/**
 * Request object passed to {@link ISdk.trigger}.
 *
 * @typeParam TInput - Type of the payload.
 */
type TriggerRequest<TInput = unknown> = {
  /** ID of the function to invoke. */function_id: string; /** Payload to pass to the function. */
  payload: TInput; /** Routing action. Omit for synchronous request/response. */
  action?: TriggerAction; /** Override the default invocation timeout in milliseconds. */
  timeoutMs?: number;
};
/**
 * Metadata about a registered function, returned by `ISdk.listFunctions`.
 */
type FunctionInfo = {
  /** Unique function identifier. */function_id: string; /** Human-readable description. */
  description?: string; /** Schema describing expected request format. */
  request_format?: RegisterFunctionFormat; /** Schema describing expected response format. */
  response_format?: RegisterFunctionFormat; /** Arbitrary metadata attached to the function. */
  metadata?: Record<string, unknown>;
};
/**
 * Information about a registered trigger.
 */
type TriggerInfo = {
  /** Unique trigger identifier. */id: string; /** Type of the trigger (e.g. `http`, `cron`, `queue`). */
  trigger_type: string; /** ID of the function this trigger is bound to. */
  function_id: string; /** Trigger-specific configuration. */
  config?: unknown; /** Arbitrary metadata attached to the trigger. */
  metadata?: Record<string, unknown>;
};
/**
 * Information about a registered trigger type, returned by `ISdk.listTriggerTypes`.
 */
type TriggerTypeInfo = {
  /** Trigger type identifier (e.g. `http`, `cron`, `queue`). */id: string; /** Human-readable description of the trigger type. */
  description: string; /** JSON Schema for the trigger configuration. */
  trigger_request_format?: unknown; /** JSON Schema for the call request payload. */
  call_request_format?: unknown;
};
/** Worker connection status. */
type WorkerStatus = 'connected' | 'available' | 'busy' | 'disconnected';
/**
 * Metadata about a connected worker, returned by `ISdk.listWorkers`.
 */
type WorkerInfo = {
  /** Unique worker identifier assigned by the engine. */id: string; /** Display name of the worker. */
  name?: string; /** Runtime environment (e.g. `node`, `python`, `rust`). */
  runtime?: string; /** SDK version. */
  version?: string; /** Operating system info. */
  os?: string; /** IP address of the worker. */
  ip_address?: string; /** Current connection status. */
  status: WorkerStatus; /** Timestamp (ms since epoch) when the worker connected. */
  connected_at_ms: number; /** Number of functions registered by this worker. */
  function_count: number; /** List of function IDs registered by this worker. */
  functions: string[]; /** Number of currently active invocations. */
  active_invocations: number; /** Self-reported isolation context (e.g. `libkrun`, `docker`, `k8s`). */
  isolation?: string | null;
};
/**
 * Serializable reference to one end of a streaming channel. Can be included
 * in invocation payloads to pass channel endpoints between workers.
 */
type StreamChannelRef = {
  /** Unique channel identifier. */channel_id: string; /** Access key for authentication. */
  access_key: string; /** Whether this ref is for reading or writing. */
  direction: 'read' | 'write';
};
//#endregion
//#region src/channels.d.ts
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
declare class ChannelWriter {
  private static readonly FRAME_SIZE;
  private ws;
  private wsReady;
  private readonly pendingMessages;
  /** Node.js Writable stream for binary data. */
  readonly stream: Writable;
  private readonly url;
  constructor(engineWsBase: string, ref: StreamChannelRef);
  private ensureConnected;
  /** Send a text message through the channel. */
  sendMessage(msg: string): void;
  /** Close the channel writer. */
  close(): void;
  private sendChunked;
  private sendRaw;
}
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
declare class ChannelReader {
  private ws;
  private connected;
  private readonly messageCallbacks;
  /** Node.js Readable stream for binary data. */
  readonly stream: Readable;
  private readonly url;
  constructor(engineWsBase: string, ref: StreamChannelRef);
  private ensureConnected;
  /** Register a callback to receive text messages from the channel. */
  onMessage(callback: (msg: string) => void): void;
  readAll(): Promise<Buffer>;
  close(): void;
}
//#endregion
//#region src/iii-constants.d.ts
/**
 * Constants for the III module.
 */
/** Engine function paths for internal operations */
declare const EngineFunctions: {
  readonly LIST_FUNCTIONS: "engine::functions::list";
  readonly LIST_WORKERS: "engine::workers::list";
  readonly LIST_TRIGGERS: "engine::triggers::list";
  readonly LIST_TRIGGER_TYPES: "engine::trigger-types::list";
  readonly REGISTER_WORKER: "engine::workers::register";
};
/** Engine trigger types */
declare const EngineTriggers: {
  readonly FUNCTIONS_AVAILABLE: "engine::functions-available";
  readonly LOG: "log";
};
/** Log function paths */
declare const LogFunctions: {
  readonly INFO: "engine::log::info";
  readonly WARN: "engine::log::warn";
  readonly ERROR: "engine::log::error";
  readonly DEBUG: "engine::log::debug";
};
/** Connection state for the III WebSocket */
type IIIConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
/** Configuration for WebSocket reconnection behavior */
interface IIIReconnectionConfig {
  /** Starting delay in milliseconds (default: 1000ms) */
  initialDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 30000ms) */
  maxDelayMs: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Random jitter factor 0-1 (default: 0.3) */
  jitterFactor: number;
  /** Maximum retry attempts, -1 for infinite (default: -1) */
  maxRetries: number;
}
/** Default reconnection configuration */
declare const DEFAULT_BRIDGE_RECONNECTION_CONFIG: IIIReconnectionConfig;
/** Default invocation timeout in milliseconds */
declare const DEFAULT_INVOCATION_TIMEOUT_MS = 30000;
//#endregion
//#region src/telemetry-system/types.d.ts
/** Configuration for WebSocket reconnection behavior */
interface ReconnectionConfig {
  /** Starting delay in milliseconds (default: 1000ms) */
  initialDelayMs: number;
  /** Maximum delay cap in milliseconds (default: 30000ms) */
  maxDelayMs: number;
  /** Exponential backoff multiplier (default: 2) */
  backoffMultiplier: number;
  /** Random jitter factor 0-1 (default: 0.3) */
  jitterFactor: number;
  /** Maximum retry attempts, -1 for infinite (default: -1) */
  maxRetries: number;
}
/** Configuration for OpenTelemetry initialization. */
interface OtelConfig {
  /** Whether OpenTelemetry export is enabled. Defaults to true. Set to false or OTEL_ENABLED=false/0/no/off to disable. */
  enabled?: boolean;
  /** The service name to report. Defaults to OTEL_SERVICE_NAME or "iii-node". */
  serviceName?: string;
  /** The service version to report. Defaults to SERVICE_VERSION env var or "unknown". */
  serviceVersion?: string;
  /** The service namespace to report. Defaults to SERVICE_NAMESPACE env var. */
  serviceNamespace?: string;
  /** The service instance ID to report. Defaults to SERVICE_INSTANCE_ID env var or auto-generated UUID. */
  serviceInstanceId?: string;
  /** III Engine WebSocket URL. Defaults to III_URL or "ws://localhost:49134". */
  engineWsUrl?: string;
  /** OpenTelemetry instrumentations to register (e.g., PrismaInstrumentation). */
  instrumentations?: Instrumentation[];
  /** Whether OpenTelemetry metrics export is enabled. Defaults to true. Set to false or OTEL_METRICS_ENABLED=false/0/no/off to disable. */
  metricsEnabled?: boolean;
  /** Metrics export interval in milliseconds. Defaults to 60000 (60 seconds). */
  metricsExportIntervalMs?: number;
  /** Log processor flush delay in milliseconds. Defaults to 100ms. */
  logsFlushIntervalMs?: number;
  /** Maximum number of log records exported per batch. Defaults to 1. */
  logsBatchSize?: number;
  /** Whether to auto-instrument globalThis.fetch calls. Defaults to true. Works on Node.js, Bun, and Deno. Set to false to disable. */
  fetchInstrumentationEnabled?: boolean;
  /** Optional reconnection configuration for the WebSocket connection. */
  reconnectionConfig?: Partial<ReconnectionConfig>;
}
//#endregion
//#region src/telemetry-system/context.d.ts
/**
 * Extract the current trace ID from the active span context.
 */
declare function currentTraceId(): string | undefined;
/**
 * Extract the current span ID from the active span context.
 */
declare function currentSpanId(): string | undefined;
/**
 * Inject the current trace context into a W3C traceparent header string.
 */
declare function injectTraceparent(): string | undefined;
/**
 * Extract a trace context from a W3C traceparent header string.
 */
declare function extractTraceparent(traceparent: string): Context;
/**
 * Inject the current baggage into a W3C baggage header string.
 */
declare function injectBaggage(): string | undefined;
/**
 * Extract baggage from a W3C baggage header string.
 */
declare function extractBaggage(baggage: string): Context;
/**
 * Extract both trace context and baggage from their respective headers.
 */
declare function extractContext(traceparent?: string, baggage?: string): Context;
/**
 * Get a baggage entry from the current context.
 */
declare function getBaggageEntry(key: string): string | undefined;
/**
 * Set a baggage entry in the current context.
 */
declare function setBaggageEntry(key: string, value: string): Context;
/**
 * Remove a baggage entry from the current context.
 */
declare function removeBaggageEntry(key: string): Context;
/**
 * Get all baggage entries from the current context.
 */
declare function getAllBaggage(): Record<string, string>;
//#endregion
//#region src/telemetry-system/index.d.ts
/**
 * Initialize OpenTelemetry with the given configuration.
 * This should be called once at application startup.
 */
declare function initOtel(config?: OtelConfig): void;
/**
 * Shutdown OpenTelemetry, flushing any pending data.
 */
declare function shutdownOtel(): Promise<void>;
/**
 * Get the OpenTelemetry tracer instance.
 */
declare function getTracer(): Tracer | null;
/**
 * Get the OpenTelemetry meter instance.
 */
declare function getMeter(): Meter$1 | null;
/**
 * Get the OpenTelemetry logger instance.
 */
declare function getLogger(): Logger | null;
/**
 * Start a new span with the given name and run the callback within it.
 */
declare function withSpan<T>(name: string, options: {
  kind?: SpanKind$1;
  traceparent?: string;
}, fn: (span: Span) => Promise<T>): Promise<T>;
//#endregion
//#region src/triggers.d.ts
/**
 * Configuration passed to a trigger handler when a trigger instance is
 * registered or unregistered.
 *
 * @typeParam TConfig - Type of the trigger-specific configuration.
 */
type TriggerConfig<TConfig> = {
  /** Trigger instance ID. */id: string; /** Function to invoke when the trigger fires. */
  function_id: string; /** Trigger-specific configuration. */
  config: TConfig; /** Arbitrary metadata attached to the trigger. */
  metadata?: Record<string, unknown>;
};
/**
 * Handler interface for custom trigger types. Passed to
 * `ISdk.registerTriggerType`.
 *
 * @typeParam TConfig - Type of the trigger-specific configuration.
 *
 * @example
 * ```typescript
 * const handler: TriggerHandler<{ interval: number }> = {
 *   async registerTrigger({ id, function_id, config }) {
 *     // Set up periodic invocation
 *   },
 *   async unregisterTrigger({ id, function_id, config }) {
 *     // Clean up
 *   },
 * }
 * ```
 */
type TriggerHandler<TConfig> = {
  /** Called when a trigger instance is registered. */registerTrigger(config: TriggerConfig<TConfig>): Promise<void>; /** Called when a trigger instance is unregistered. */
  unregisterTrigger(config: TriggerConfig<TConfig>): Promise<void>;
};
//#endregion
//#region src/types.d.ts
/**
 * Async function handler for a registered function. Receives the invocation
 * payload and returns the result.
 *
 * @typeParam TInput - Type of the invocation payload.
 * @typeParam TOutput - Type of the return value.
 *
 * @example
 * ```typescript
 * const handler: RemoteFunctionHandler<{ name: string }, { message: string }> =
 *   async (data) => ({ message: `Hello, ${data.name}!` })
 * ```
 */
type RemoteFunctionHandler<TInput = any, TOutput = any> = (data: TInput) => Promise<TOutput>;
/** OTEL Log Event from the engine */
type OtelLogEvent = {
  /** Timestamp in Unix nanoseconds */timestamp_unix_nano: number; /** Observed timestamp in Unix nanoseconds */
  observed_timestamp_unix_nano: number; /** OTEL severity number (1-24): TRACE=1-4, DEBUG=5-8, INFO=9-12, WARN=13-16, ERROR=17-20, FATAL=21-24 */
  severity_number: number; /** Severity text (e.g., "INFO", "WARN", "ERROR") */
  severity_text: string; /** Log message body */
  body: string; /** Structured attributes */
  attributes: Record<string, unknown>; /** Trace ID for correlation (if available) */
  trace_id?: string; /** Span ID for correlation (if available) */
  span_id?: string; /** Resource attributes from the emitting service */
  resource: Record<string, string>; /** Service name that emitted the log */
  service_name: string; /** Instrumentation scope name (if available) */
  instrumentation_scope_name?: string; /** Instrumentation scope version (if available) */
  instrumentation_scope_version?: string;
};
type RegisterTriggerInput = Omit<RegisterTriggerMessage, 'message_type' | 'id'>;
type RegisterServiceInput = Omit<RegisterServiceMessage, 'message_type'>;
type RegisterFunctionInput = Omit<RegisterFunctionMessage, 'message_type'>;
type RegisterFunctionOptions = Omit<RegisterFunctionMessage, 'message_type' | 'id'>;
type RegisterTriggerTypeInput = Omit<RegisterTriggerTypeMessage, 'message_type'>;
type FunctionsAvailableCallback = (functions: FunctionInfo[]) => void;
interface ISdk {
  /**
   * Registers a new trigger. A trigger is a way to invoke a function when a certain event occurs.
   * @param trigger - The trigger to register
   * @returns A trigger object that can be used to unregister the trigger
   *
   * @example
   * ```typescript
   * const trigger = iii.registerTrigger({
   *   type: 'cron',
   *   function_id: 'my-service::process-batch',
   *   config: { schedule: '*\/5 * * * *' },
   * })
   *
   * // Later, remove the trigger
   * trigger.unregister()
   * ```
   */
  registerTrigger(trigger: RegisterTriggerInput): Trigger;
  /**
   * Registers a new service.
   * @param message - The service to register
   */
  registerService(message: RegisterServiceInput): void;
  /**
   * Registers a new function with a local handler or an HTTP invocation config.
   * @param functionId - Unique function identifier
   * @param handler - Async handler for local execution, or an HTTP invocation config for external functions (Lambda, Cloudflare Workers, etc.)
   * @param options - Optional function registration options (description, request/response formats, metadata)
   * @returns A handle that can be used to unregister the function
   *
   * @example
   * ```typescript
   * // Local handler
   * const ref = iii.registerFunction(
   *   'greet',
   *   async (data: { name: string }) => ({ message: `Hello, ${data.name}!` }),
   *   { description: 'Returns a greeting' },
   * )
   *
   * // HTTP invocation
   * const lambdaRef = iii.registerFunction(
   *   'external::my-lambda',
   *   {
   *     url: 'https://abc123.lambda-url.us-east-1.on.aws',
   *     method: 'POST',
   *     timeout_ms: 30_000,
   *     auth: { type: 'bearer', token_key: 'LAMBDA_AUTH_TOKEN' },
   *   },
   *   { description: 'Proxied Lambda function' },
   * )
   *
   * // Later, remove the function
   * ref.unregister()
   * ```
   */
  registerFunction(functionId: string, handler: RemoteFunctionHandler | HttpInvocationConfig, options?: RegisterFunctionOptions): FunctionRef;
  /**
   * Invokes a function using a request object.
   *
   * @param request - The trigger request containing function_id, payload, and optional action/timeout
   * @returns The result of the function
   *
   * @example
   * ```typescript
   * // Synchronous invocation
   * const result = await iii.trigger<{ name: string }, { message: string }>({
   *   function_id: 'greet',
   *   payload: { name: 'World' },
   *   timeoutMs: 5000,
   * })
   * console.log(result.message) // "Hello, World!"
   *
   * // Fire-and-forget
   * await iii.trigger({
   *   function_id: 'send-email',
   *   payload: { to: 'user@example.com' },
   *   action: TriggerAction.Void(),
   * })
   *
   * // Enqueue for async processing
   * const receipt = await iii.trigger({
   *   function_id: 'process-order',
   *   payload: { orderId: '123' },
   *   action: TriggerAction.Enqueue({ queue: 'orders' }),
   * })
   * ```
   */
  trigger<TInput, TOutput>(request: TriggerRequest<TInput>): Promise<TOutput>;
  /**
   * Lists all registered functions.
   *
   * @example
   * ```typescript
   * const functions = await iii.listFunctions()
   * for (const fn of functions) {
   *   console.log(`${fn.function_id}: ${fn.description}`)
   * }
   * ```
   */
  listFunctions(): Promise<FunctionInfo[]>;
  /**
   * Lists all registered triggers.
   * @param includeInternal - Whether to include internal triggers (default: false)
   */
  listTriggers(includeInternal?: boolean): Promise<TriggerInfo[]>;
  /**
   * Lists all trigger types registered with the engine.
   * @param includeInternal - Whether to include internal trigger types (default: false)
   *
   * @example
   * ```typescript
   * const triggerTypes = await iii.listTriggerTypes()
   * for (const tt of triggerTypes) {
   *   console.log(`${tt.id}: ${tt.description}`)
   * }
   * ```
   */
  listTriggerTypes(includeInternal?: boolean): Promise<TriggerTypeInfo[]>;
  /**
   * Registers a new trigger type. A trigger type is a way to invoke a function when a certain event occurs.
   * @param triggerType - The trigger type to register
   * @param handler - The handler for the trigger type
   * @returns A trigger type object that can be used to unregister the trigger type
   *
   * @example
   * ```typescript
   * type CronConfig = { schedule: string }
   *
   * iii.registerTriggerType<CronConfig>(
   *   { id: 'cron', description: 'Fires on a cron schedule' },
   *   {
   *     async registerTrigger({ id, function_id, config }) {
   *       startCronJob(id, config.schedule, () =>
   *         iii.trigger({ function_id, payload: {} }),
   *       )
   *     },
   *     async unregisterTrigger({ id }) {
   *       stopCronJob(id)
   *     },
   *   },
   * )
   * ```
   */
  registerTriggerType<TConfig>(triggerType: RegisterTriggerTypeInput, handler: TriggerHandler<TConfig>): TriggerTypeRef<TConfig>;
  /**
   * Unregisters a trigger type.
   * @param triggerType - The trigger type to unregister
   *
   * @example
   * ```typescript
   * iii.unregisterTriggerType({ id: 'cron', description: 'Fires on a cron schedule' })
   * ```
   */
  unregisterTriggerType(triggerType: RegisterTriggerTypeInput): void;
  /**
   * Creates a streaming channel pair for worker-to-worker data transfer.
   * Returns a Channel with a local writer/reader and serializable refs that
   * can be passed as fields in the invocation data to other functions.
   *
   * @param bufferSize - Optional buffer size for the channel (default: 64)
   * @returns A Channel with writer, reader, and their serializable refs
   *
   * @example
   * ```typescript
   * const channel = await iii.createChannel()
   *
   * // Pass the writer ref to another function
   * await iii.trigger({
   *   function_id: 'stream-producer',
   *   payload: { outputChannel: channel.writerRef },
   * })
   *
   * // Read data locally
   * channel.reader.onMessage((msg) => {
   *   console.log('Received:', msg)
   * })
   * ```
   */
  createChannel(bufferSize?: number): Promise<Channel>;
  /**
   * Creates a new stream implementation.
   *
   * This overrides the default stream implementation.
   *
   * @param streamName - The name of the stream
   * @param stream - The stream implementation
   *
   * @example
   * ```typescript
   * const redisStream: IStream<UserSession> = {
   *   async get({ group_id, item_id }) {
   *     return JSON.parse(await redis.get(`${group_id}:${item_id}`) ?? 'null')
   *   },
   *   async set({ group_id, item_id, data }) {
   *     const old = await this.get({ stream_name: 'sessions', group_id, item_id })
   *     await redis.set(`${group_id}:${item_id}`, JSON.stringify(data))
   *     return { old_value: old ?? undefined, new_value: data }
   *   },
   *   async delete({ group_id, item_id }) {
   *     const old = await this.get({ stream_name: 'sessions', group_id, item_id })
   *     await redis.del(`${group_id}:${item_id}`)
   *     return { old_value: old ?? undefined }
   *   },
   *   async list({ group_id }) { return [] },
   *   async listGroups() { return [] },
   *   async update({ group_id, item_id, ops }) { return { new_value: {} } },
   * }
   *
   * iii.createStream('sessions', redisStream)
   * ```
   */
  createStream<TData>(streamName: string, stream: IStream<TData>): void;
  /**
   * Registers a callback to receive the current functions list
   * when the engine announces changes.
   *
   * @example
   * ```typescript
   * const unsubscribe = iii.onFunctionsAvailable((functions) => {
   *   console.log(`${functions.length} functions available:`)
   *   for (const fn of functions) {
   *     console.log(`  - ${fn.function_id}`)
   *   }
   * })
   *
   * // Later, stop listening
   * unsubscribe()
   * ```
   */
  onFunctionsAvailable(callback: FunctionsAvailableCallback): () => void;
  /**
   * Gracefully shutdown the iii, cleaning up all resources.
   *
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   await iii.shutdown()
   *   process.exit(0)
   * })
   * ```
   */
  shutdown(): Promise<void>;
}
/**
 * Handle returned by {@link ISdk.registerTrigger}. Use `unregister()` to
 * remove the trigger from the engine.
 */
type Trigger = {
  /** Removes this trigger from the engine. */unregister(): void;
};
/**
 * Handle returned by {@link ISdk.registerFunction}. Contains the function's
 * `id` and an `unregister()` method.
 */
type FunctionRef = {
  /** The unique function identifier. */id: string; /** Removes this function from the engine. */
  unregister: () => void;
};
/**
 * Typed handle returned by {@link ISdk.registerTriggerType}.
 *
 * Provides convenience methods to register triggers and functions scoped
 * to this trigger type, so callers don't need to repeat the `type` field.
 *
 * @typeParam TConfig - Trigger-specific configuration type.
 *
 * @example
 * ```typescript
 * type CronConfig = { schedule: string }
 *
 * const cron = iii.registerTriggerType<CronConfig>(
 *   { id: 'cron', description: 'Fires on a cron schedule' },
 *   cronHandler,
 * )
 *
 * // Register a trigger — type is inferred as CronConfig
 * cron.registerTrigger('my-fn', { schedule: '* * * * *' })
 *
 * // Register a function and bind a trigger in one call
 * cron.registerFunction(
 *   'my-fn',
 *   async (data) => { return { ok: true } },
 * )
 * ```
 */
type TriggerTypeRef<TConfig = unknown> = {
  /** The trigger type identifier. */id: string;
  /**
   * Register a trigger bound to this trigger type.
   *
   * @param functionId - The function to invoke when the trigger fires.
   * @param config - Trigger-specific configuration.
   * @param metadata - Optional arbitrary metadata attached to the trigger.
   * @returns A {@link Trigger} handle with an `unregister()` method.
   */
  registerTrigger(functionId: string, config: TConfig, metadata?: Record<string, unknown>): Trigger;
  /**
   * Register a function and immediately bind it to this trigger type.
   *
   * @param functionId - Unique function identifier.
   * @param handler - Local function handler.
   * @param config - Trigger-specific configuration.
   * @param metadata - Optional arbitrary metadata attached to the trigger.
   * @returns A {@link FunctionRef} handle.
   */
  registerFunction(functionId: string, handler: RemoteFunctionHandler, config: TConfig, metadata?: Record<string, unknown>): FunctionRef;
  /**
   * Unregister this trigger type from the engine.
   */
  unregister(): void;
};
/**
 * A streaming channel pair for worker-to-worker data transfer. Created via
 * {@link ISdk.createChannel}.
 */
type Channel = {
  /** Writer end of the channel. */writer: ChannelWriter; /** Reader end of the channel. */
  reader: ChannelReader; /** Serializable reference to the writer (can be sent to other workers). */
  writerRef: StreamChannelRef; /** Serializable reference to the reader (can be sent to other workers). */
  readerRef: StreamChannelRef;
};
type InternalHttpRequest<TBody = unknown> = {
  path_params: Record<string, string>;
  query_params: Record<string, string | string[]>;
  body: TBody;
  headers: Record<string, string | string[]>;
  method: string;
  response: ChannelWriter;
  request_body: ChannelReader;
};
/**
 * Response object passed to HTTP function handlers. Use `status()` and
 * `headers()` to set response metadata, write to `stream` for streaming
 * responses, and call `close()` when done.
 */
type HttpResponse = {
  /** Set the HTTP status code. */status: (statusCode: number) => void; /** Set response headers. */
  headers: (headers: Record<string, string>) => void; /** Writable stream for the response body. */
  stream: NodeJS.WritableStream; /** Close the response. */
  close: () => void;
};
/**
 * Incoming HTTP request received by a function registered with an HTTP trigger.
 *
 * @typeParam TBody - Type of the parsed request body.
 */
type HttpRequest<TBody = unknown> = Omit<InternalHttpRequest<TBody>, 'response'>;
/**
 * Alias for {@link HttpRequest}. Represents an incoming API request.
 *
 * @typeParam TBody - Type of the parsed request body.
 */
type ApiRequest<TBody = unknown> = HttpRequest<TBody>;
/**
 * Structured API response returned from HTTP function handlers.
 *
 * @typeParam TStatus - HTTP status code literal type.
 * @typeParam TBody - Type of the response body.
 *
 * @example
 * ```typescript
 * const response: ApiResponse = {
 *   status_code: 200,
 *   headers: { 'content-type': 'application/json' },
 *   body: { message: 'ok' },
 * }
 * ```
 */
type ApiResponse<TStatus extends number = number, TBody = string | Buffer | Record<string, unknown>> = {
  /** HTTP status code. */status_code: TStatus; /** Response headers. */
  headers?: Record<string, string>; /** Response body. */
  body?: TBody;
};
//#endregion
//#region src/utils.d.ts
/**
 * Safely stringify a value, handling circular references, BigInt, and other edge cases.
 * Returns "[unserializable]" if serialization fails for any reason.
 */
declare function safeStringify(value: unknown): string;
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
declare const http: (callback: (req: HttpRequest, res: HttpResponse) => Promise<void | ApiResponse>) => (req: InternalHttpRequest) => Promise<void | ApiResponse>;
//#endregion
export { LogFunctions as $, getTracer as A, getBaggageEntry as B, Logger as C, TriggerRequest as Ct, SpanStatusCode$1 as D, Span as E, WorkerStatus as Et, currentTraceId as F, OtelConfig as G, injectTraceparent as H, extractBaggage as I, DEFAULT_INVOCATION_TIMEOUT_MS as J, ReconnectionConfig as K, extractContext as L, shutdownOtel as M, withSpan as N, getLogger as O, currentSpanId as P, IIIReconnectionConfig as Q, extractTraceparent as R, TriggerHandler as S, TriggerInfo as St, SeverityNumber$1 as T, WorkerInfo as Tt, removeBaggageEntry as U, injectBaggage as V, setBaggageEntry as W, EngineTriggers as X, EngineFunctions as Y, IIIConnectionState as Z, RegisterTriggerTypeInput as _, RegisterFunctionMessage as _t, Channel as a, FunctionInfo as at, TriggerTypeRef as b, StreamChannelRef as bt, HttpRequest as c, MessageType as ct, InternalHttpRequest as d, OnFunctionRegistrationResult as dt, ChannelReader as et, OtelLogEvent as f, OnTriggerRegistrationInput as ft, RegisterTriggerInput as g, RegisterFunctionFormat as gt, RegisterServiceInput as h, OnTriggerTypeRegistrationResult as ht, ApiResponse as i, EnqueueResult as it, initOtel as j, getMeter as k, HttpResponse as l, MiddlewareFunctionInput as lt, RegisterFunctionOptions as m, OnTriggerTypeRegistrationInput as mt, safeStringify as n, AuthInput as nt, FunctionRef as o, HttpAuthConfig as ot, RegisterFunctionInput as p, OnTriggerRegistrationResult as pt, DEFAULT_BRIDGE_RECONNECTION_CONFIG as q, ApiRequest as r, AuthResult as rt, FunctionsAvailableCallback as s, HttpInvocationConfig as st, http as t, ChannelWriter as tt, ISdk as u, OnFunctionRegistrationInput as ut, RemoteFunctionHandler as v, RegisterTriggerMessage as vt, Meter$1 as w, TriggerTypeInfo as wt, TriggerConfig as x, TriggerAction as xt, Trigger as y, RegisterTriggerTypeMessage as yt, getAllBaggage as z };
//# sourceMappingURL=utils-Cx5sef26.d.mts.map