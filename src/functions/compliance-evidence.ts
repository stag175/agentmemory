import type { ISdk } from "iii-sdk";
import type {
  AuditEntry,
  ComplianceControlStatus,
  ComplianceEvidenceControl,
  ComplianceEvidenceFinding,
  ComplianceEvidenceInput,
  ComplianceEvidenceNextAction,
  ComplianceEvidenceRef,
  ComplianceEvidenceReport,
  Memory,
  TeamSharedItem,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { resolveRulesRequest } from "./rules-resolver.js";

const REQUIRED_PERMISSIONS = [
  "project:read",
  "project:write",
  "governance:delete",
] as const;

const RELEASE_GATE_KEYS = [
  "distributionMetadata",
  "build",
  "test",
  "docs",
  "packSmoke",
  "redactionForget",
  "retrievalScope",
  "retrievalArena",
  "restMcpParity",
] as const;

type RoleGrant = {
  name: string;
  permissions: string[];
  memberCount?: number;
};

type ReleaseStatus = "pass" | "fail" | "blocked" | "not_run";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function countBy<T>(items: T[], keyFn: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyFn(item) ?? "unspecified";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function safeList<T>(
  kv: StateKV,
  scope: string,
): Promise<{ rows: T[]; error?: string }> {
  try {
    return { rows: await kv.list<T>(scope) };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function hasPermission(permissions: string[], required: string): boolean {
  const [domain] = required.split(":");
  return (
    permissions.includes("*") ||
    permissions.includes(required) ||
    permissions.includes(`${domain}:*`)
  );
}

function extractRoles(teamPolicy: unknown): {
  teamId?: string;
  roles: RoleGrant[];
  actorCount: number;
} {
  if (!isRecord(teamPolicy)) return { roles: [], actorCount: 0 };

  const roles: RoleGrant[] = [];
  const rawRoles = teamPolicy.roles;
  if (Array.isArray(rawRoles)) {
    for (const role of rawRoles) {
      if (!isRecord(role)) continue;
      const name = nonEmptyString(role.name) ?? nonEmptyString(role.role);
      if (!name) continue;
      const permissions = stringArray(role.permissions);
      const members = stringArray(role.members).length || stringArray(role.users).length;
      roles.push({
        name,
        permissions,
        ...(members > 0 ? { memberCount: members } : {}),
      });
    }
  } else if (isRecord(rawRoles)) {
    for (const [name, value] of Object.entries(rawRoles)) {
      if (Array.isArray(value)) {
        roles.push({ name, permissions: stringArray(value) });
      } else if (isRecord(value)) {
        const permissions = stringArray(value.permissions);
        const members = stringArray(value.members).length || stringArray(value.users).length;
        roles.push({
          name,
          permissions,
          ...(members > 0 ? { memberCount: members } : {}),
        });
      }
    }
  }

  const actorCount =
    stringArray(teamPolicy.members).length ||
    stringArray(teamPolicy.users).length ||
    roles.reduce((sum, role) => sum + (role.memberCount ?? 0), 0);

  return {
    teamId: nonEmptyString(teamPolicy.teamId),
    roles,
    actorCount,
  };
}

function evidenceRef(
  refs: ComplianceEvidenceRef[],
  ref: ComplianceEvidenceRef,
): string {
  refs.push(ref);
  return ref.id;
}

function finding(
  findings: ComplianceEvidenceFinding[],
  input: ComplianceEvidenceFinding,
): void {
  findings.push(input);
}

function normalizeReleaseStatus(value: unknown): ReleaseStatus | undefined {
  if (value === "pass" || value === "fail" || value === "blocked" || value === "not_run") {
    return value;
  }
  return undefined;
}

function releaseChecks(evidence: unknown): Array<{
  key: string;
  status: ReleaseStatus;
  evidenceCount: number;
  failureCount: number;
  blockerCount: number;
}> {
  if (!isRecord(evidence)) return [];
  const source = isRecord(evidence.checks)
    ? evidence.checks
    : isRecord(evidence.releaseGate)
      ? evidence.releaseGate
      : evidence;
  return Object.entries(source).flatMap(([key, value]) => {
    if (!isRecord(value)) return [];
    const status = normalizeReleaseStatus(value.status);
    if (!status) return [];
    return [
      {
        key,
        status,
        evidenceCount: stringArray(value.evidence).length,
        failureCount: stringArray(value.failures).length,
        blockerCount: stringArray(value.blockers).length,
      },
    ];
  });
}

function statusFromFindings(
  controlId: string,
  findings: ComplianceEvidenceFinding[],
  fallback: ComplianceControlStatus = "pass",
): ComplianceControlStatus {
  const scoped = findings.filter((item) => item.controlId === controlId);
  if (scoped.some((item) => item.severity === "high")) return "fail";
  if (scoped.length > 0) return "warn";
  return fallback;
}

function nextActionsFromFindings(
  findings: ComplianceEvidenceFinding[],
): ComplianceEvidenceNextAction[] {
  return findings.map((item, index) => ({
    id: `next_${index + 1}`,
    priority: item.severity === "high" ? "high" : item.severity === "medium" ? "medium" : "low",
    controlId: item.controlId,
    action: item.recommendation,
  }));
}

export function registerComplianceEvidenceFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::compliance-evidence",
    async (input: ComplianceEvidenceInput = {}): Promise<ComplianceEvidenceReport> => {
      const generatedAt = new Date().toISOString();
      const includeRuleContent = input.includeRuleContent === true;
      const evidenceRefs: ComplianceEvidenceRef[] = [];
      const findings: ComplianceEvidenceFinding[] = [];
      const controls: ComplianceEvidenceControl[] = [];

      const project = nonEmptyString(input.project);
      const workspaceRoot = nonEmptyString(input.workspaceRoot);
      const teamPolicy = extractRoles(input.teamPolicy);

      const [memoriesResult, auditResult, teamSharedResult] = await Promise.all([
        safeList<Memory>(kv, KV.memories),
        safeList<AuditEntry>(kv, KV.audit),
        teamPolicy.teamId
          ? safeList<TeamSharedItem>(kv, KV.teamShared(teamPolicy.teamId))
          : Promise.resolve({ rows: [] as TeamSharedItem[] }),
      ]);

      const memories = project
        ? memoriesResult.rows.filter((memory) => memory.project === project)
        : memoriesResult.rows;
      const auditRows = auditResult.rows;
      const teamShared = teamSharedResult.rows;

      const policyRefIds: string[] = [];
      if (input.teamPolicy !== undefined) {
        policyRefIds.push(
          evidenceRef(evidenceRefs, {
            id: "team-policy:request",
            type: "team-policy",
            label: "Request-scoped team policy",
            metadata: {
              teamId: teamPolicy.teamId,
              roleCount: teamPolicy.roles.length,
              actorCount: teamPolicy.actorCount,
              requiredPermissions: [...REQUIRED_PERMISSIONS],
            },
          }),
        );
      }

      const rolesMissing = teamPolicy.roles.flatMap((role) => {
        const missing = REQUIRED_PERMISSIONS.filter(
          (permission) => !hasPermission(role.permissions, permission),
        );
        return missing.length > 0 ? [{ role: role.name, missing }] : [];
      });

      if (input.teamPolicy === undefined) {
        finding(findings, {
          id: "access_policy_missing",
          controlId: "access-posture",
          severity: "medium",
          message: "No request-scoped team policy was provided for access posture evaluation.",
          evidenceRefIds: policyRefIds,
          recommendation: "Provide teamPolicy roles with project:read, project:write, and governance:delete grants for the evidence pack.",
        });
      } else if (teamPolicy.roles.length === 0) {
        finding(findings, {
          id: "access_roles_missing",
          controlId: "access-posture",
          severity: "medium",
          message: "The request-scoped team policy did not expose any roles.",
          evidenceRefIds: policyRefIds,
          recommendation: "Add explicit role entries and permission grants to the local team policy input.",
        });
      } else if (rolesMissing.length > 0) {
        finding(findings, {
          id: "access_permissions_incomplete",
          controlId: "access-posture",
          severity: "medium",
          message: "One or more request-scoped roles lack required project or governance permissions.",
          evidenceRefIds: policyRefIds,
          recommendation: "Review least-privilege role grants and document who can read, write, and delete governance-scoped data.",
        });
      }

      for (const item of teamShared.slice(0, 50)) {
        evidenceRef(evidenceRefs, {
          id: `team-shared:${item.id}`,
          type: "team-shared",
          label: `Team shared ${item.type}`,
          metadata: {
            id: item.id,
            type: item.type,
            project: item.project,
            visibility: item.visibility,
            sharedBy: item.sharedBy,
            sharedAt: item.sharedAt,
          },
        });
      }

      controls.push({
        id: "access-posture",
        title: "Access Posture",
        status: statusFromFindings("access-posture", findings),
        summary: `${teamPolicy.roles.length} request-scoped roles evaluated against ${REQUIRED_PERMISSIONS.length} required permissions.`,
        metrics: {
          roleCount: teamPolicy.roles.length,
          actorCount: teamPolicy.actorCount,
          requiredPermissions: [...REQUIRED_PERMISSIONS],
          missingByRole: rolesMissing,
          teamSharedRefCount: teamShared.length,
        },
        evidenceRefIds: policyRefIds,
      });

      if (memoriesResult.error) {
        finding(findings, {
          id: "memory_store_unavailable",
          controlId: "lifecycle-hygiene",
          severity: "high",
          message: "Memory store could not be listed for lifecycle hygiene evidence.",
          evidenceRefIds: [],
          recommendation: "Restore access to the local memory KV scope and rerun the SOC2 evidence pack.",
        });
      }
      if (auditResult.error) {
        finding(findings, {
          id: "audit_store_unavailable",
          controlId: "audit-trail",
          severity: "high",
          message: "Audit store could not be listed for audit trail evidence.",
          evidenceRefIds: [],
          recommendation: "Restore access to the local audit KV scope and rerun the SOC2 evidence pack.",
        });
      }

      const auditRefIds = auditRows.slice(0, 100).map((entry) =>
        evidenceRef(evidenceRefs, {
          id: `audit:${entry.id}`,
          type: "audit",
          label: `${entry.operation} via ${entry.functionId}`,
          metadata: {
            id: entry.id,
            timestamp: entry.timestamp,
            operation: entry.operation,
            functionId: entry.functionId,
            targetCount: entry.targetIds.length,
            reasonPresent: typeof entry.details?.reason === "string" && entry.details.reason.trim().length > 0,
          },
        }),
      );
      const governanceDeletes = auditRows.filter(
        (entry) =>
          entry.operation === "delete" &&
          (entry.functionId === "mem::governance-delete" ||
            entry.functionId === "mem::governance-bulk"),
      );
      const governanceDeletesWithReason = governanceDeletes.filter(
        (entry) =>
          typeof entry.details?.reason === "string" &&
          entry.details.reason.trim().length > 0,
      );
      if (governanceDeletes.length === 0) {
        finding(findings, {
          id: "governance_delete_not_observed",
          controlId: "audit-trail",
          severity: "low",
          message: "No governance delete audit entries were present in local audit evidence.",
          evidenceRefIds: auditRefIds,
          recommendation: "Retain at least one governance delete dry-run or approved deletion record with a reason in release evidence when applicable.",
        });
      } else if (governanceDeletesWithReason.length < governanceDeletes.length) {
        finding(findings, {
          id: "governance_delete_reason_gap",
          controlId: "audit-trail",
          severity: "medium",
          message: "Some governance delete audit entries do not include a reason.",
          evidenceRefIds: auditRefIds,
          recommendation: "Require governance deletion reasons in operational runbooks and release gates.",
        });
      }
      controls.push({
        id: "audit-trail",
        title: "Audit Trail",
        status: statusFromFindings("audit-trail", findings),
        summary: `${auditRows.length} audit entries summarized by operation and function.`,
        metrics: {
          total: auditRows.length,
          byOperation: countBy(auditRows, (entry) => entry.operation),
          byFunction: countBy(auditRows, (entry) => entry.functionId),
          governanceDelete: {
            total: governanceDeletes.length,
            withReason: governanceDeletesWithReason.length,
            coverage:
              governanceDeletes.length === 0
                ? 0
                : governanceDeletesWithReason.length / governanceDeletes.length,
          },
        },
        evidenceRefIds: auditRefIds,
      });

      const memoryRefIds = memories.slice(0, 100).map((memory) =>
        evidenceRef(evidenceRefs, {
          id: `memory:${memory.id}`,
          type: "memory",
          label: memory.title,
          metadata: {
            id: memory.id,
            type: memory.type,
            project: memory.project,
            lifecycleState: memory.lifecycleState ?? "legacy_unspecified",
            reviewState: memory.reviewState ?? "unreviewed",
            privacyScope: memory.privacyScope ?? "unspecified",
            sourceType: memory.sourceType,
            sourceHashPresent: Boolean(memory.sourceHash),
            sourceUriPresent: Boolean(memory.sourceUri),
            sourceObservationCount: memory.sourceObservationIds?.length ?? 0,
            redactionApplied: memory.redactionApplied === true,
            sensitivityLabelCount: memory.sensitivityLabels?.length ?? 0,
          },
        }),
      );
      const missingPrivacy = memories.filter((memory) => !memory.privacyScope).length;
      const missingSource = memories.filter(
        (memory) =>
          !memory.sourceType &&
          !memory.sourceHash &&
          !memory.sourceUri &&
          (!memory.sourceObservationIds || memory.sourceObservationIds.length === 0),
      ).length;
      const unreviewed = memories.filter(
        (memory) => !memory.reviewState || memory.reviewState === "unreviewed",
      ).length;
      if (memories.length > 0 && missingPrivacy > 0) {
        finding(findings, {
          id: "memory_privacy_scope_gap",
          controlId: "lifecycle-hygiene",
          severity: "medium",
          message: "Some local memories do not declare a privacy scope.",
          evidenceRefIds: memoryRefIds,
          recommendation: "Backfill privacyScope on live memories and keep future writes on the lifecycle-aware path.",
        });
      }
      if (memories.length > 0 && missingSource > 0) {
        finding(findings, {
          id: "memory_source_provenance_gap",
          controlId: "lifecycle-hygiene",
          severity: "medium",
          message: "Some local memories do not carry source provenance.",
          evidenceRefIds: memoryRefIds,
          recommendation: "Backfill sourceType, sourceHash, sourceUri, or sourceObservationIds where provenance can be established.",
        });
      }
      controls.push({
        id: "lifecycle-hygiene",
        title: "Lifecycle Hygiene",
        status: statusFromFindings("lifecycle-hygiene", findings, memories.length === 0 ? "not_applicable" : "pass"),
        summary: `${memories.length} memories summarized for lifecycle, review, privacy, and source coverage.`,
        metrics: {
          total: memories.length,
          byLifecycle: countBy(memories, (memory) => memory.lifecycleState ?? "legacy_unspecified"),
          byReview: countBy(memories, (memory) => memory.reviewState ?? "unreviewed"),
          byPrivacy: countBy(memories, (memory) => memory.privacyScope ?? "unspecified"),
          unreviewed,
          missingPrivacyScope: missingPrivacy,
          missingSourceProvenance: missingSource,
          redactionApplied: memories.filter((memory) => memory.redactionApplied === true).length,
          sourceCoverage:
            memories.length === 0 ? 0 : (memories.length - missingSource) / memories.length,
        },
        evidenceRefIds: memoryRefIds,
      });

      const ruleRefIds: string[] = [];
      let rulesMetric: Record<string, unknown> = {
        workspaceRoot,
        total: 0,
        warnings: [],
      };
      if (!workspaceRoot) {
        finding(findings, {
          id: "rules_workspace_missing",
          controlId: "rules-provenance",
          severity: "low",
          message: "No workspaceRoot was provided, so rule provenance could not be scanned.",
          evidenceRefIds: [],
          recommendation: "Provide workspaceRoot to include local AGENTS.md and compatible rule hashes in the SOC2 evidence pack.",
        });
      } else {
        const rulesResult = await resolveRulesRequest({
          workspaceRoot,
          includeContent: includeRuleContent,
        });
        if (!rulesResult.success) {
          finding(findings, {
            id: "rules_resolution_failed",
            controlId: "rules-provenance",
            severity: "medium",
            message: "Workspace rules could not be resolved for provenance evidence.",
            evidenceRefIds: [],
            recommendation: "Check workspaceRoot and file permissions, then rerun the evidence pack.",
          });
          rulesMetric = {
            workspaceRoot,
            total: 0,
            warnings: [rulesResult.error],
          };
        } else {
          rulesMetric = {
            workspaceRoot: rulesResult.workspaceRoot,
            scannedAt: rulesResult.scannedAt,
            total: rulesResult.rules.length,
            warnings: rulesResult.warnings.map((warning) => ({
              code: warning.code,
              relativePath: warning.relativePath,
            })),
            rules: rulesResult.rules.map((rule) => ({
              id: rule.id,
              host: rule.host,
              sourceKind: rule.sourceKind,
              relativePath: rule.relativePath,
              scope: rule.scope,
              activation: rule.activation,
              precedence: rule.precedence,
              contentHash: rule.contentHash,
              metadata: rule.metadata,
              ...("content" in rule ? { content: rule.content } : {}),
            })),
          };
          for (const rule of rulesResult.rules) {
            ruleRefIds.push(
              evidenceRef(evidenceRefs, {
                id: `rules:${rule.id}`,
                type: "rules",
                label: rule.relativePath,
                metadata: {
                  host: rule.host,
                  sourceKind: rule.sourceKind,
                  relativePath: rule.relativePath,
                  scope: rule.scope,
                  activation: rule.activation,
                  precedence: rule.precedence,
                  contentHash: rule.contentHash,
                  file: rule.metadata,
                  ...("content" in rule ? { content: rule.content } : {}),
                },
              }),
            );
          }
        }
      }
      controls.push({
        id: "rules-provenance",
        title: "Rules Provenance",
        status: statusFromFindings("rules-provenance", findings, workspaceRoot ? "pass" : "warn"),
        summary: `${ruleRefIds.length} local instruction rules summarized with metadata and hashes.`,
        metrics: rulesMetric,
        evidenceRefIds: ruleRefIds,
      });

      const checks = releaseChecks(input.releaseGateEvidence);
      const releaseRefIds = checks.map((check) =>
        evidenceRef(evidenceRefs, {
          id: `release-gate:${check.key}`,
          type: "release-gate",
          label: check.key,
          metadata: check,
        }),
      );
      const missingReleaseKeys = RELEASE_GATE_KEYS.filter(
        (key) => !checks.some((check) => check.key === key),
      );
      if (input.releaseGateEvidence === undefined) {
        finding(findings, {
          id: "release_gate_evidence_missing",
          controlId: "release-readiness",
          severity: "medium",
          message: "No release gate evidence was provided for readiness summary.",
          evidenceRefIds: releaseRefIds,
          recommendation: "Attach recent build, test, docs, package smoke, redaction/forget, retrieval scope, and REST/MCP parity evidence.",
        });
      } else if (checks.length === 0) {
        finding(findings, {
          id: "release_gate_evidence_unrecognized",
          controlId: "release-readiness",
          severity: "medium",
          message: "Release gate evidence was provided but no recognized check statuses were found.",
          evidenceRefIds: releaseRefIds,
          recommendation: "Use pass, fail, blocked, or not_run statuses keyed by the standard release gate names.",
        });
      } else if (checks.some((check) => check.status === "fail" || check.status === "blocked")) {
        finding(findings, {
          id: "release_gate_blocked_or_failed",
          controlId: "release-readiness",
          severity: "high",
          message: "One or more release gate checks are failed or blocked.",
          evidenceRefIds: releaseRefIds,
          recommendation: "Clear failed or blocked release checks before treating the SOC2 pack as release-ready evidence.",
        });
      } else if (missingReleaseKeys.length > 0) {
        finding(findings, {
          id: "release_gate_partial",
          controlId: "release-readiness",
          severity: "medium",
          message: "Release gate evidence is partial.",
          evidenceRefIds: releaseRefIds,
          recommendation: "Attach every standard release gate check so the readiness summary is complete.",
        });
      }
      controls.push({
        id: "release-readiness",
        title: "Release Readiness",
        status: statusFromFindings("release-readiness", findings),
        summary: `${checks.length} release gate checks summarized from provided evidence.`,
        metrics: {
          total: checks.length,
          byStatus: countBy(checks, (check) => check.status),
          missingKeys: missingReleaseKeys,
          checks,
        },
        evidenceRefIds: releaseRefIds,
      });

      return {
        success: true,
        generatedAt,
        scope: {
          ...(project ? { project } : {}),
          ...(workspaceRoot ? { workspaceRoot } : {}),
          includeRuleContent,
          teamPolicyProvided: input.teamPolicy !== undefined,
          releaseGateEvidenceProvided: input.releaseGateEvidence !== undefined,
        },
        controls,
        findings,
        nextActions: nextActionsFromFindings(findings),
        evidenceRefs,
      };
    },
  );
}
