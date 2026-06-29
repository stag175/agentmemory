# MCPB packaging template

This directory contains the MCP Bundle manifest for agentmemory. It is not a finished `.mcpb` artifact.

The current MCP shim lives at `packages/mcp/bin.mjs` and imports
`@agentmemory/agentmemory/dist/standalone.mjs`. A publishable MCPB builder must
copy that shim to `server/bin.mjs` and bundle the production dependency tree
inside the archive before packaging.

Do not hand-write or publish a final `.mcpb` from this directory alone. The
builder should:

1. Build the root package so `dist/standalone.mjs` exists.
2. Install production dependencies into an isolated staging directory.
3. Copy `packaging/mcpb/manifest.json` to the staging root.
4. Copy `packages/mcp/bin.mjs` to `server/bin.mjs`.
5. Include `node_modules/@agentmemory/agentmemory` and required runtime
   dependencies in the archive.
6. Generate the `.mcpb` through the bundle tooling so checksums and archive
   metadata come from the actual staged output.
