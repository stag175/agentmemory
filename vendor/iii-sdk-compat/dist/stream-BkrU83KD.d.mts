//#region src/stream.d.ts
/** Input for stream authentication. */
interface StreamAuthInput {
  /** Request headers. */
  headers: Record<string, string>;
  /** Request path. */
  path: string;
  /** Query parameters. */
  query_params: Record<string, string[]>;
  /** Client address. */
  addr: string;
}
/** Result of stream authentication. */
interface StreamAuthResult {
  /** Arbitrary context passed to stream handlers after authentication. */
  context?: any;
}
/** Context type extracted from {@link StreamAuthResult}. */
type StreamContext = StreamAuthResult['context'];
/** Event payload for stream join/leave events. */
interface StreamJoinLeaveEvent {
  /** Unique subscription identifier. */
  subscription_id: string;
  /** Name of the stream. */
  stream_name: string;
  /** Group identifier. */
  group_id: string;
  /** Item identifier (if applicable). */
  id?: string;
  /** Auth context from {@link StreamAuthResult}. */
  context?: StreamContext;
}
/** Result of a stream join request. */
interface StreamJoinResult {
  /** Whether the join was unauthorized. */
  unauthorized: boolean;
}
/** Input for retrieving a single stream item. */
type StreamGetInput = {
  /** Name of the stream. */stream_name: string; /** Group identifier. */
  group_id: string; /** Item identifier. */
  item_id: string;
};
/** Input for setting a stream item. */
type StreamSetInput = {
  /** Name of the stream. */stream_name: string; /** Group identifier. */
  group_id: string; /** Item identifier. */
  item_id: string; /** Data to store. */
  data: any;
};
/** Input for deleting a stream item. */
type StreamDeleteInput = {
  /** Name of the stream. */stream_name: string; /** Group identifier. */
  group_id: string; /** Item identifier. */
  item_id: string;
};
/** Input for listing all items in a stream group. */
type StreamListInput = {
  /** Name of the stream. */stream_name: string; /** Group identifier. */
  group_id: string;
};
/** Input for listing all groups in a stream. */
type StreamListGroupsInput = {
  /** Name of the stream. */stream_name: string;
};
/** Result of a stream set operation. */
type StreamSetResult<TData> = {
  /** Previous value (if it existed). */old_value?: TData; /** New value that was stored. */
  new_value: TData;
};
/** Result of a stream update operation. */
type StreamUpdateResult<TData> = {
  /** Previous value (if it existed). */old_value?: TData; /** New value after the update. */
  new_value: TData;
};
/** Set a field at the given path to a value. */
type UpdateSet = {
  type: 'set'; /** Dot-separated field path (e.g. `user.name`). */
  path: string; /** Value to set. */
  value: any;
};
/** Increment a numeric field by a given amount. */
type UpdateIncrement = {
  type: 'increment'; /** Dot-separated field path. */
  path: string; /** Amount to increment by. */
  by: number;
};
/** Decrement a numeric field by a given amount. */
type UpdateDecrement = {
  type: 'decrement'; /** Dot-separated field path. */
  path: string; /** Amount to decrement by. */
  by: number;
};
/** Remove a field at the given path. */
type UpdateRemove = {
  type: 'remove'; /** Dot-separated field path. */
  path: string;
};
/** Deep-merge an object into the field at the given path. */
type UpdateMerge = {
  type: 'merge'; /** Dot-separated field path. */
  path: string; /** Object to merge. */
  value: any;
};
/** Result of a stream delete operation. */
type DeleteResult = {
  /** Previous value (if it existed). */old_value?: any;
};
/**
 * Union of all atomic update operations supported by streams.
 *
 * @see {@link UpdateSet}, {@link UpdateIncrement}, {@link UpdateDecrement},
 *      {@link UpdateRemove}, {@link UpdateMerge}
 */
type UpdateOp = UpdateSet | UpdateIncrement | UpdateDecrement | UpdateRemove | UpdateMerge;
/** Input for atomically updating a stream item. */
type StreamUpdateInput = {
  /** Name of the stream. */stream_name: string; /** Group identifier. */
  group_id: string; /** Item identifier. */
  item_id: string; /** Ordered list of update operations to apply atomically. */
  ops: UpdateOp[];
};
/** Trigger config for `stream` triggers. Filters which item changes fire the handler. */
interface StreamTriggerConfig {
  /** Stream name to watch. Only changes on this stream fire the handler. */
  stream_name: string;
  /** If set, only changes within this group fire the handler. */
  group_id?: string;
  /** If set, only changes to this specific item fire the handler. */
  item_id?: string;
  /** Function ID for conditional execution. If it returns `false`, the handler is skipped. */
  condition_function_id?: string;
}
/** Trigger config for `stream:join` and `stream:leave` triggers. */
interface StreamJoinLeaveTriggerConfig {
  /** Function ID for conditional execution. If it returns `false`, the handler is skipped. */
  condition_function_id?: string;
}
/** Handler input for `stream` triggers, fired when an item changes via `stream::set`, `stream::update`, or `stream::delete`. */
interface StreamChangeEvent {
  /** The event type. */
  type: 'stream';
  /** Unix timestamp of the event. */
  timestamp: number;
  /** The stream where the change occurred. */
  streamName: string;
  /** The group where the change occurred. */
  groupId: string;
  /** The item ID that changed. */
  id?: string;
  /** The event detail object containing `type` and `data` fields. */
  event: {
    type: 'create' | 'update' | 'delete';
    data: any;
  };
}
/**
 * Interface for custom stream implementations. Passed to `ISdk.createStream`
 * to override the engine's built-in stream storage.
 *
 * @typeParam TData - Type of the data stored in the stream.
 */
interface IStream<TData> {
  /** Retrieve a single item by group and item ID. */
  get(input: StreamGetInput): Promise<TData | null>;
  /** Set (create or overwrite) a stream item. */
  set(input: StreamSetInput): Promise<StreamSetResult<TData> | null>;
  /** Delete a stream item. */
  delete(input: StreamDeleteInput): Promise<DeleteResult>;
  /** List all items in a group. */
  list(input: StreamListInput): Promise<TData[]>;
  /** List all group IDs in a stream. */
  listGroups(input: StreamListGroupsInput): Promise<string[]>;
  /** Apply atomic update operations to a stream item. */
  update(input: StreamUpdateInput): Promise<StreamUpdateResult<TData> | null>;
}
//#endregion
export { UpdateRemove as C, UpdateOp as S, StreamUpdateInput as _, StreamChangeEvent as a, UpdateIncrement as b, StreamGetInput as c, StreamJoinResult as d, StreamListGroupsInput as f, StreamTriggerConfig as g, StreamSetResult as h, StreamAuthResult as i, StreamJoinLeaveEvent as l, StreamSetInput as m, IStream as n, StreamContext as o, StreamListInput as p, StreamAuthInput as r, StreamDeleteInput as s, DeleteResult as t, StreamJoinLeaveTriggerConfig as u, StreamUpdateResult as v, UpdateSet as w, UpdateMerge as x, UpdateDecrement as y };
//# sourceMappingURL=stream-BkrU83KD.d.mts.map