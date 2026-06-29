import { describe, expect, it } from "vitest";
import {
  FRAMEWORK_ADAPTERS,
  formatFrameworkAdapterList,
  formatFrameworkSetup,
  knownFrameworkAdapters,
  resolveFrameworkAdapter,
} from "../src/cli/connect/frameworks.js";

const requiredFrameworks = [
  "openai-agents",
  "autogen",
  "crewai",
  "langgraph",
];

describe("framework adapter descriptors", () => {
  it("registers the named agent runtime frameworks without host-agent mutation", () => {
    expect(knownFrameworkAdapters()).toEqual(
      FRAMEWORK_ADAPTERS.map((descriptor) => descriptor.name),
    );
    for (const name of requiredFrameworks) {
      expect(knownFrameworkAdapters()).toContain(name);
    }
    for (const descriptor of FRAMEWORK_ADAPTERS) {
      expect(descriptor.status).toBe("descriptor-only");
      expect(descriptor.packageHints.length).toBeGreaterThan(0);
      expect(descriptor.setup.length).toBeGreaterThan(0);
      expect(descriptor.env).toContain("AGENTMEMORY_URL=http://localhost:3111");
      expect(descriptor.surfaces).toContain("rest");
      expect(descriptor.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("resolves aliases for common framework names", () => {
    expect(resolveFrameworkAdapter("OpenAI")?.name).toBe("openai-agents");
    expect(resolveFrameworkAdapter("autogen-agentchat")?.name).toBe("autogen");
    expect(resolveFrameworkAdapter("Crew-AI")?.name).toBe("crewai");
    expect(resolveFrameworkAdapter("langchain-graph")?.name).toBe("langgraph");
    expect(resolveFrameworkAdapter("missing-framework")).toBeNull();
  });

  it("formats list and setup helpers as read-only guidance", () => {
    const list = formatFrameworkAdapterList();
    expect(list).toContain("descriptor-only");
    expect(list).toContain("agentmemory connect frameworks <name>");

    const setup = formatFrameworkSetup("langgraph");
    expect(setup).toContain("LangGraph");
    expect(setup).toContain("No files are changed");
    expect(setup).toContain("/agentmemory/context");
    expect(formatFrameworkSetup("missing-framework")).toBeNull();
  });
});
