import type { Attributes } from "@opentelemetry/api";

export type RawResourceAttribute = [string, unknown];
export type DetectedResourceAttributes = Attributes;
export interface ResourceOptions {
  schemaUrl?: string;
}

export declare class Resource {
  constructor(attributes?: DetectedResourceAttributes, options?: ResourceOptions);
  readonly asyncAttributesPending?: boolean;
  readonly attributes: Attributes;
  readonly schemaUrl?: string;
  waitForAsyncAttributes(): Promise<void>;
  merge(other: Resource | null): Resource;
  getRawAttributes(): RawResourceAttribute[];
}

export declare function resourceFromAttributes(
  attributes: DetectedResourceAttributes,
  options?: ResourceOptions,
): Resource;
export declare function resourceFromDetectedResource(
  detectedResource: { attributes?: DetectedResourceAttributes },
  options?: ResourceOptions,
): Resource;
export declare function emptyResource(): Resource;
export declare function defaultResource(): Resource;
export declare function defaultServiceName(): string;
export declare function detectResources(): Resource;

export interface ResourceDetector {
  detect(): Resource;
}

export declare const envDetector: ResourceDetector;
export declare const hostDetector: ResourceDetector;
export declare const osDetector: ResourceDetector;
export declare const processDetector: ResourceDetector;
export declare const serviceInstanceIdDetector: ResourceDetector;
