import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("viewer Trust surface", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("exposes a visible Trust tab and view", () => {
    expect(viewer).toContain('<button data-tab="trust">Trust</button>');
    expect(viewer).toContain('<div id="view-trust" class="view"></div>');
    expect(viewer).toContain("'audit', 'trust', 'activity'");
  });

  it("loads ledger, review queue, agent events, and search explain through REST", () => {
    expect(viewer).toContain("apiGet('memory-ledger?' + ledgerParams.toString())");
    expect(viewer).toContain("apiGet('memory-review-queue?' + trustQueryString(20))");
    expect(viewer).toContain("apiGet('agent-events?' + trustQueryString(50))");
    expect(viewer).toContain("apiGet('memory/today?' + trustQueryString(20))");
    expect(viewer).toContain("apiPost('memory-proposals/list', trustProposalPayload(20))");
    expect(viewer).toContain("apiPost('search/explain', body)");
    expect(viewer).toContain("explain: true");
    expect(viewer).toContain("includeReport: true");
    expect(viewer).toContain("tokenBudget: 1200");
  });

  it("labels retrieved and injected memories in the Memory Used drawer", () => {
    expect(viewer).toContain("Memory Used");
    expect(viewer).toContain("Prompt / task");
    expect(viewer).toContain("Trace</button>");
    expect(viewer).toContain("Retrieved");
    expect(viewer).toContain("Injected");
    expect(viewer).toContain("Ranking");
    expect(viewer).toContain("Plan");
    expect(viewer).toContain("result.packedContext || explain.packedContext");
    expect(viewer).toContain("packed && packed.selected");
    expect(viewer).toContain("trustEvidenceMemoryId");
    expect(viewer).toContain("No source evidence");
    expect(viewer).toContain("source-backed");
    expect(viewer).toContain("needs source");
    expect(viewer).toContain("Open Workbench");
  });

  it("exposes a reversible edit workbench using lifecycle REST endpoints", () => {
    expect(viewer).toContain("Reversible Edit Workbench");
    expect(viewer).toContain("id=\"trust-workbench-memory-id\"");
    expect(viewer).toContain("data-action=\"trust-workbench-preview-tombstone\"");
    expect(viewer).toContain("apiPost('memory/inspect', { memoryId: wb.memoryId })");
    expect(viewer).toContain("apiGet(historyPath)");
    expect(viewer).toContain("path: 'memory/update'");
    expect(viewer).toContain("path: 'memory/archive'");
    expect(viewer).toContain("path: 'memory/restore'");
    expect(viewer).toContain("path: 'memory/delete'");
    expect(viewer).toContain("mode: 'tombstone'");
    expect(viewer).toContain("dryRun: !!dryRun");
  });

  it("keeps the Trust tab in the existing tab loader", () => {
    expect(viewer).toMatch(/case 'trust': if \(!state\.trust\.loaded\) await loadTrust\(\); break;/);
    expect(viewer).toContain("Memory Used");
    expect(viewer).toContain("Memory Ledger");
    expect(viewer).toContain("Review Queue");
    expect(viewer).toContain("Agent Events");
  });

  it("surfaces the Today in Memory inbox inside the Trust tab", () => {
    expect(viewer).toContain("Today in Memory");
    expect(viewer).toContain("renderTrustToday(today)");
    expect(viewer).toContain("renderTrustTodaySection('Failed Commands'");
    expect(viewer).toContain("renderTrustTodaySection('Unresolved Claims'");
    expect(viewer).toContain("renderTrustTodaySection('Proposed Consolidations'");
    expect(viewer).toContain("todayRowMemoryId");
  });

  it("surfaces memory proposals with explicit review authority controls", () => {
    expect(viewer).toContain("Memory PRs");
    expect(viewer).toContain("renderTrustProposals(proposals)");
    expect(viewer).toContain("trustProposalPayload");
    expect(viewer).toContain("id=\"trust-proposal-permissions\"");
    expect(viewer).toContain("data-action=\"trust-proposal-approve\"");
    expect(viewer).toContain("data-action=\"trust-proposal-reject\"");
    expect(viewer).toContain("data-action=\"trust-proposal-apply\"");
    expect(viewer).toContain("runTrustProposalAction('approve'");
    expect(viewer).toContain("runTrustProposalAction('reject'");
    expect(viewer).toContain("runTrustProposalAction('apply'");
    expect(viewer).toContain("Apply this approved memory proposal?");
  });

  it("renders the trust-filter inputs through attr(), not the text-only esc()", () => {
    expect(viewer).toContain(
      "id=\"trust-project-filter\" placeholder=\"Project filter\" value=\"' + attr(state.trust.projectFilter) + '\"",
    );
    expect(viewer).toContain(
      "id=\"trust-explain-query\" placeholder=\"Prompt / task\" value=\"' + attr(state.trust.explainQuery) + '\"",
    );
    expect(viewer).not.toContain("value=\"' + esc(state.trust.projectFilter) + '\"");
    expect(viewer).not.toContain("value=\"' + esc(state.trust.explainQuery) + '\"");
    // esc() must be documented as text-context-only so quotes-in-attributes mistakes are not repeated.
    expect(viewer).toContain("TEXT-CONTEXT ONLY");
  });

  it("attr() encodes the double quotes that esc() leaves intact", () => {
    const escSource = extractFunctionBody(viewer, "esc");
    const attrSource = extractFunctionBody(viewer, "attr");
    // esc() leans on document/createElement; provide a minimal text-context shim that mirrors it.
    const esc = (s: string) =>
      s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") : "";
    const attr = new Function(`${attrSource}\nreturn attr;`)() as (s: string) => string;

    const hostile = 'p" onmouseover="alert(1)';
    // The latent self-XSS: esc() never escapes the closing quote, so it breaks out of value="...".
    expect(esc(hostile)).toContain('"');
    // attr() neutralizes the quote (and the apostrophe) so the value attribute cannot be escaped.
    expect(attr(hostile)).not.toContain('"');
    expect(attr(hostile)).toContain("&quot;");
    expect(attr("a'b")).toContain("&#39;");
    expect(attr("a&b<c>")).toBe("a&amp;b&lt;c&gt;");
    // Sanity: the shipped esc() really is the quote-blind text-context helper documented above.
    expect(escSource).toContain("textContent");
  });
});

describe("notification hook redaction", () => {
  const bundle = readFileSync("plugin/scripts/notification.mjs", "utf-8");

  it("routes permission-prompt title and message through safeString before sending", () => {
    expect(bundle).toContain("title: safeString(data.title)");
    expect(bundle).toContain("message: safeString(data.message)");
    expect(bundle).not.toContain("title: data.title");
    expect(bundle).not.toContain("message: data.message");
  });

  it("safeString actually redacts secrets in transit", () => {
    const safeString = loadBundleHelper(bundle, ["SECRET_VALUE_PATTERNS", "redactString", "safeString"]) as (
      value: unknown,
      max?: number,
    ) => string | undefined;

    expect(safeString("ghp_" + "a".repeat(30))).toBe("[redacted]");
    expect(safeString("Authorization: Bearer " + "x".repeat(40))).toContain("[redacted]");
    expect(safeString("token=" + "y".repeat(24))).toBe("token=[redacted]");
    expect(safeString("approve git push to origin?")).toBe("approve git push to origin?");
    expect(safeString("")).toBeUndefined();
    expect(safeString(undefined)).toBeUndefined();
  });
});

function loadBundleHelper(source: string, names: string[]): unknown {
  const decls = names
    .map((name) => {
      if (name === "SECRET_VALUE_PATTERNS") return extractConst(source, name);
      return extractFunctionBody(source, name);
    })
    .join("\n");
  const last = names[names.length - 1];
  return new Function(`${decls}\nreturn ${last};`)();
}

function extractConst(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`const ${name} not found`);
  let depth = 0;
  let seenBracket = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[") {
      depth++;
      seenBracket = true;
    } else if (ch === "]") {
      depth--;
      if (seenBracket && depth === 0) return source.slice(start, i + 1) + ";";
    }
  }
  throw new Error(`const ${name} not balanced`);
}

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found`);
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") {
      depth++;
      seenBrace = true;
    } else if (ch === "}") {
      depth--;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} body not balanced`);
}
