"use strict";

const SDK_INFO = {
  "telemetry.sdk.language": "nodejs",
  "telemetry.sdk.name": "opentelemetry",
  "telemetry.sdk.version": "2.8.0",
};

function defaultServiceName() {
  return `unknown_service:${process.argv?.[1] || "node"}`;
}

function isPromiseLike(value) {
  return !!value && typeof value.then === "function";
}

function normalizeRawAttributes(attributes) {
  return attributes.map(([key, value]) => [
    key,
    isPromiseLike(value)
      ? value.catch(() => undefined)
      : value,
  ]);
}

class Resource {
  constructor(attributes = {}, options = {}) {
    this._rawAttributes = normalizeRawAttributes(Object.entries(attributes));
    this._schemaUrl = typeof options.schemaUrl === "string" ? options.schemaUrl : undefined;
    this._asyncAttributesPending = this._rawAttributes.some(([, value]) => isPromiseLike(value));
    this._memoizedAttributes = undefined;
  }

  get asyncAttributesPending() {
    return this._asyncAttributesPending;
  }

  get schemaUrl() {
    return this._schemaUrl;
  }

  get attributes() {
    if (this._memoizedAttributes && !this._asyncAttributesPending) {
      return this._memoizedAttributes;
    }
    const attributes = {};
    for (const [key, value] of this._rawAttributes) {
      if (isPromiseLike(value) || value == null) continue;
      if (attributes[key] === undefined) attributes[key] = value;
    }
    if (!this._asyncAttributesPending) this._memoizedAttributes = attributes;
    return attributes;
  }

  async waitForAsyncAttributes() {
    if (!this._asyncAttributesPending) return;
    for (let index = 0; index < this._rawAttributes.length; index++) {
      const [key, value] = this._rawAttributes[index];
      this._rawAttributes[index] = [key, isPromiseLike(value) ? await value : value];
    }
    this._asyncAttributesPending = false;
    this._memoizedAttributes = undefined;
  }

  getRawAttributes() {
    return this._rawAttributes.slice();
  }

  merge(other) {
    if (other == null) return this;
    const merged = new Map(this.getRawAttributes());
    const incoming =
      typeof other.getRawAttributes === "function"
        ? other.getRawAttributes()
        : Object.entries(other.attributes || {});
    for (const [key, value] of incoming) merged.set(key, value);
    return resourceFromAttributes(Object.fromEntries(merged), {
      schemaUrl: other.schemaUrl || this.schemaUrl,
    });
  }
}

function resourceFromAttributes(attributes, options) {
  return new Resource(attributes, options);
}

function resourceFromDetectedResource(detectedResource, options) {
  return new Resource(detectedResource?.attributes || {}, options);
}

function emptyResource() {
  return new Resource({});
}

function defaultResource() {
  return new Resource({
    "service.name": defaultServiceName(),
    ...SDK_INFO,
  });
}

function detectResources() {
  return emptyResource();
}

const noopDetector = { detect: () => emptyResource() };

module.exports = {
  Resource,
  resourceFromAttributes,
  resourceFromDetectedResource,
  emptyResource,
  defaultResource,
  defaultServiceName,
  detectResources,
  envDetector: noopDetector,
  hostDetector: noopDetector,
  osDetector: noopDetector,
  processDetector: noopDetector,
  serviceInstanceIdDetector: noopDetector,
};
