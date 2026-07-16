import { S as UpdateOp } from "./stream-CJdvFip3.cjs";

//#region src/state.d.ts
/** Input for retrieving a state value. */
type StateGetInput = {
  /** State scope (namespace). */scope: string; /** Key within the scope. */
  key: string;
};
/** Input for setting a state value. */
type StateSetInput = {
  /** State scope (namespace). */scope: string; /** Key within the scope. */
  key: string; /** Value to store. */
  value: any;
};
/** Input for deleting a state value. */
type StateDeleteInput = {
  /** State scope (namespace). */scope: string; /** Key within the scope. */
  key: string;
};
/** Result of a state delete operation. */
type StateDeleteResult = {
  /** Previous value (if it existed). */old_value?: any;
};
/** Input for listing all values in a state scope. */
type StateListInput = {
  /** State scope (namespace). */scope: string;
};
/** Result of a state set operation. */
type StateSetResult<TData> = {
  /** Previous value (if it existed). */old_value?: TData; /** New value that was stored. */
  new_value: TData;
};
/** Result of a state update operation. */
type StateUpdateResult<TData> = {
  /** Previous value (if it existed). */old_value?: TData; /** New value after the update. */
  new_value: TData;
};
/** Result of a state delete operation. */
type DeleteResult = {
  /** Previous value (if it existed). */old_value?: any;
};
/** Input for atomically updating a state value. */
type StateUpdateInput = {
  /** State scope (namespace). */scope: string; /** Key within the scope. */
  key: string; /** Ordered list of update operations to apply atomically. */
  ops: UpdateOp[];
};
/** Types of state change events. */
declare enum StateEventType {
  Created = "state:created",
  Updated = "state:updated",
  Deleted = "state:deleted"
}
/** Payload for state change events. */
interface StateEventData<TData = any> {
  type: 'state';
  /** Type of state change. */
  event_type: StateEventType;
  /** State scope (namespace). */
  scope: string;
  /** Key within the scope. */
  key: string;
  /** Previous value (for update/delete events). */
  old_value?: TData;
  /** New value (for create/update events). */
  new_value?: TData;
}
/**
 * Interface for state management operations. Available via the `iii-sdk/state`
 * subpath export.
 */
interface IState {
  /** Retrieve a value by scope and key. */
  get<TData>(input: StateGetInput): Promise<TData | null>;
  /** Set (create or overwrite) a state value. */
  set<TData>(input: StateSetInput): Promise<StateSetResult<TData> | null>;
  /** Delete a state value. */
  delete(input: StateDeleteInput): Promise<DeleteResult>;
  /** List all values in a scope. */
  list<TData>(input: StateListInput): Promise<TData[]>;
  /** Apply atomic update operations to a state value. */
  update<TData>(input: StateUpdateInput): Promise<StateUpdateResult<TData> | null>;
}
//#endregion
export { DeleteResult, IState, StateDeleteInput, StateDeleteResult, StateEventData, StateEventType, StateGetInput, StateListInput, StateSetInput, StateSetResult, StateUpdateInput, StateUpdateResult };
//# sourceMappingURL=state.d.cts.map