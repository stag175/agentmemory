Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

//#region src/state.ts
/** Types of state change events. */
let StateEventType = /* @__PURE__ */ function(StateEventType) {
	StateEventType["Created"] = "state:created";
	StateEventType["Updated"] = "state:updated";
	StateEventType["Deleted"] = "state:deleted";
	return StateEventType;
}({});

//#endregion
exports.StateEventType = StateEventType;
//# sourceMappingURL=state.cjs.map