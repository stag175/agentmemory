//#region src/state.ts
/** Types of state change events. */
let StateEventType = /* @__PURE__ */ function(StateEventType) {
	StateEventType["Created"] = "state:created";
	StateEventType["Updated"] = "state:updated";
	StateEventType["Deleted"] = "state:deleted";
	return StateEventType;
}({});

//#endregion
export { StateEventType };
//# sourceMappingURL=state.mjs.map