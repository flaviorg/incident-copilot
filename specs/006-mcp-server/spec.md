# 006: MCP server

Milestone M6. Status: implemented.

## Context

MCP is the second port: coding agents and assistants (VS Code, Cursor, Inspector) can query incidents and propose remediations over the same store as the API. The central rule is that **no tool approves or executes**: a proposal goes through the same gate path and only runs together with the batch, after the human decision through the API.

## Scope

- `src/mcp/server.ts`, stdio entrypoint. Redirects `console.log`, `console.info` and `console.debug` to stderr before loading the application, and every log goes to stderr as JSON.
- `create-mcp-server.ts`, with the same container as the API (same `DB_PATH`).
- 3 tools, with short `content` and `structuredContent` validated by `outputSchema`:
  - `list_incidents`;
  - `get_incident`: incident view and the most recent trace events;
  - `propose_remediation`.
- `IncidentService.proposeExternalAction`:
  - rejects oversized fields before writing (`incidentId` and `actionType` up to 64 characters, `target` up to 200, `runbookRef` up to 120, `params` up to 2,000 as JSON), because the MCP client does not authenticate;
  - only accepts `awaiting_approval` incidents;
  - classifies the action, validates parameters and runs the dry run on the blackboard's world;
  - writes everything in one transaction with optimistic versioning;
  - audits with actor `mcp_client:<name>`;
  - tier 4, unknown type, invalid parameter and failed dry run become an audited `isError`.
- `.vscode/mcp.json` (key `servers`) and `.cursor/mcp.json` (key `mcpServers`). Scripts `mcp` and `mcp:inspect`.

## Non-goals

- Approval or execution tool, by construction.
- Resource `incident-copilot://autonomy-matrix` and prompt `triage-incident` (v2 backlog).
- HTTP or SSE transport: stdio only.
- Publishing the server to npm.
- MCP client authentication: the process runs locally, with the permissions of whoever starts it.

## Acceptance criteria (EARS)

- **AC-34** The server shall write only JSON-RPC messages to stdout; every log goes to stderr.
- **AC-35** When `propose_remediation` receives a tier 2 or 3 action for an `awaiting_approval` incident, the server shall record it as `ready` or with a `pending` approval (returning `approvalId`), with `proposedBy: "mcp_client"` and `planRevision: null`, executing nothing; for an incident in any other state, it shall return `isError`.
- **AC-36** When `propose_remediation` receives a tier 4 or unknown action, the server shall return `isError: true` with a short reason, without internal details, and audit the block.
- **AC-37** The server and the API shall use the same store: an incident created through the API shall appear in `list_incidents`.

## How to verify

| Criterion | Tests |
|---|---|
| AC-34 | `tests/e2e/mcp.e2e.test.ts` ("stdout carries only JSON-RPC; logs go to stderr"), with a raw process |
| AC-35 | `tests/e2e/mcp.e2e.test.ts` ("tier 2 becomes ready, tier 3 creates an approval, nothing executes", "incidents not awaiting approval reject proposals", "MCP proposals run together with the batch on the human decision") |
| AC-36 | `tests/e2e/mcp.e2e.test.ts` ("forbidden and unknown types are short isError results and are audited") |
| AC-37 | `tests/e2e/mcp.e2e.test.ts` ("same store as the API: incident created over HTTP shows up") |

The tests use the SDK `Client` with `StdioClientTransport` (`tests/helpers/mcp-client.ts`) and start the server with `--import ./tests/setup/no-network.ts`.

## Reference

incident-copilot design document, revision 2, dated 2026-10-04. It lives in the course repository, outside this repository. Sections:

- "5.4 MCP server tools";
- "6.1 Error taxonomy";
- "8.3 Acceptance criteria in EARS".

The SDK's input validation and the error message shape are in `docs/api-notes.md`.
