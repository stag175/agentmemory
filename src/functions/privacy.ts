import type { ISdk } from "iii-sdk";

const PRIVATE_TAG_RE = /<private>[\s\S]*?<\/private>/gi;

const SECRET_PATTERN_SOURCES: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "credential_assignment",
    pattern:
      /(?:api[_-]?key|secret|token|password|credential|auth)[\s]*[=:]\s*["']?[A-Za-z0-9_\-/.+]{20,}["']?/gi,
  },
  { label: "bearer_token", pattern: /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/gi },
  { label: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9\-_]{20,}/g },
  { label: "prefixed_api_key", pattern: /(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{19,}/g },
  { label: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9\-_]{20,}/g },
  { label: "github_token", pattern: /gh[pus]_[A-Za-z0-9]{36,}/g },
  { label: "github_pat", pattern: /github_pat_[A-Za-z0-9_]{22,}/g },
  { label: "slack_token", pattern: /xoxb-[A-Za-z0-9\-]+/g },
  { label: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/g },
  { label: "google_api_key", pattern: /AIza[A-Za-z0-9\-_]{35}/g },
  { label: "jwt", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { label: "npm_token", pattern: /npm_[A-Za-z0-9]{36}/g },
  { label: "gitlab_token", pattern: /glpat-[A-Za-z0-9\-_]{20,}/g },
  { label: "doppler_token", pattern: /dop_v1_[A-Za-z0-9]{64}/g },
  {
    label: "pem_private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

export interface PrivacyScanResult {
  redacted: string;
  redactionApplied: boolean;
  labels: string[];
  matchCount: number;
}

export interface PrivacyScanSummary {
  redactionApplied: boolean;
  labels: string[];
  matchCount: number;
}

export interface RedactedOptionalString {
  value?: string;
  scan: PrivacyScanSummary;
}

export interface RedactedStringArray {
  values: string[];
  scan: PrivacyScanSummary;
}

function unique(labels: string[]): string[] {
  return Array.from(new Set(labels));
}

export function scanPrivateData(input: string): PrivacyScanResult {
  const labels: string[] = [];
  let matchCount = 0;
  let result = input.replace(PRIVATE_TAG_RE, () => {
    labels.push("private_tag");
    matchCount++;
    return "[REDACTED]";
  });

  for (const source of SECRET_PATTERN_SOURCES) {
    const pattern = new RegExp(source.pattern.source, source.pattern.flags);
    result = result.replace(pattern, () => {
      labels.push(source.label);
      matchCount++;
      return "[REDACTED_SECRET]";
    });
  }

  return {
    redacted: result,
    redactionApplied: matchCount > 0 || result !== input,
    labels: unique(labels),
    matchCount,
  };
}

export function emptyPrivacyScanSummary(): PrivacyScanSummary {
  return { redactionApplied: false, labels: [], matchCount: 0 };
}

export function summarizePrivacyScans(
  ...scans: Array<PrivacyScanSummary | PrivacyScanResult | undefined>
): PrivacyScanSummary {
  const present = scans.filter(
    (scan): scan is PrivacyScanSummary | PrivacyScanResult =>
      scan !== undefined,
  );
  return {
    redactionApplied: present.some((scan) => scan.redactionApplied),
    labels: unique(present.flatMap((scan) => scan.labels)),
    matchCount: present.reduce((sum, scan) => sum + scan.matchCount, 0),
  };
}

export function redactOptionalString(value: unknown): RedactedOptionalString {
  if (typeof value !== "string") {
    return { scan: emptyPrivacyScanSummary() };
  }
  const scan = scanPrivateData(value);
  return { value: scan.redacted, scan };
}

export function redactStringArray(values: unknown[] | undefined): RedactedStringArray {
  if (!values) return { values: [], scan: emptyPrivacyScanSummary() };
  const scans = values
    .filter((value): value is string => typeof value === "string")
    .map((value) => scanPrivateData(value));
  return {
    values: scans.map((scan) => scan.redacted),
    scan: summarizePrivacyScans(...scans),
  };
}

export function stripPrivateData(input: string): string {
  return scanPrivateData(input).redacted;
}

export function registerPrivacyFunction(sdk: ISdk): void {
  sdk.registerFunction("mem::privacy", 
    async (data: { input?: unknown } | undefined) => {
      if (!data || typeof data.input !== "string") {
        return { output: "", error: "invalid input: expected string field 'input'" };
      }
      return { output: stripPrivateData(data.input) };
    },
  );
}
