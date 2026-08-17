/**
 * Workspace Module
 *
 * Sub-agent coding sessions for the entity. OpenCode runs as a supervised
 * subprocess; the entity is the user of the workspace; the workspace is
 * framed as a faculty of the entity, not a separate sub-agent.
 *
 * See `~/.claude/plans/recompiled-coding-faculty.md` for the full design.
 */

export {
  getWorkspaceSupervisor,
  markWorkspaceActivity,
  readProjectsPath,
  readSandboxRetentionDays,
  readWorkspaceEntityName,
  runSandboxRetention,
  setWorkspaceSupervisor,
  WorkspaceSupervisor,
} from "./supervisor.ts";
export type {
  OpenSessionResult,
  WorkspaceSupervisorConfig,
} from "./supervisor.ts";
export { composeBriefing, deriveSessionTitle } from "./briefing.ts";
export { distillSummary } from "./summary.ts";
export {
  buildBwrapArgv,
  ensureSandbox,
  resolveSandboxPaths,
  writeAgentsMd,
  writeOpenCodeConfig,
} from "./sandbox.ts";
export type { SandboxPaths } from "./sandbox.ts";
export { renderAgentFile } from "./agent-template.ts";
export type { AgentTemplateInput } from "./agent-template.ts";
export {
  ensureOpencodeRuntime,
  ensureSandboxRuntimeLink,
  resolveOpencodeRuntimeDir,
} from "./opencode-runtime.ts";
export { runEngagedSession } from "./engaged-runner.ts";
export type { EngagedSessionArgs } from "./engaged-runner.ts";
export type {
  OpenCodeEvent,
  OpenCodeRunResult,
  OpenWorkspaceOptions,
  WorkspaceCapabilities,
  WorkspaceSessionSnapshot,
} from "./session.ts";
export { bundleSkills, WORKSPACE_SKILLS } from "./skills.ts";
export { handleWorkspaceMcpRequest } from "./coordination-layer.ts";
export type {
  WorkspaceCoordinationConfig,
  WorkspaceRequestContext,
} from "./coordination-layer.ts";
export { getApprovalQueue } from "./approval-queue.ts";
export type {
  ApprovalProposal,
  ApprovalStatus,
  DiffPreview,
  EntityDataType,
  ReflectionRecommendation,
} from "./approval-queue.ts";
export { reflectOnProposal } from "./reflection.ts";
export type { ReflectionInput } from "./reflection.ts";
export { approvePath, classifyPath } from "./permissions.ts";
export type {
  PathClassification,
  PermissionTier,
  SessionPermissionState,
} from "./permissions.ts";
export { getQueryQueue } from "./query-queue.ts";
export type { WorkspaceQuery } from "./query-queue.ts";
export {
  broadcastWorkspaceEvent,
  broadcastWorkspaceResumed,
  broadcastWorkspaceStalled,
  broadcastWorkspaceTerminal,
  truncateForEntityContext,
} from "./transcript.ts";
