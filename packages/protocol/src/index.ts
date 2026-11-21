/**
 * Muse Agent Link — shared protocol types (v0.1)
 * Spec: protocol/PROTOCOL.md — keep this file and the spec in sync.
 */

export type AgentKind = 'dsh' | 'antigravity';

export type ThreadState = 'active' | 'awaiting_approval' | 'stopped' | 'closed';

export interface Thread {
  id: string;
  machineId: string;
  agent: AgentKind;
  workspace: string;
  model?: string;
  /** DSH only: Agent Preset id. */
  preset?: string;
  state: ThreadState;
  createdAt: string;
  lastActivityAt: string;
}

export type JobState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface Job {
  id: string;
  machineId: string;
  agent: AgentKind;
  workspace: string;
  prompt: string;
  model?: string;
  preset?: string;
  timeoutSec?: number;
  state: JobState;
  leaseId?: string;
  leaseExpiresAt?: string;
  attempts: number;
  resultSummary?: string;
  /** Workspace-relative paths of files produced by the job. */
  artifacts?: string[];
  createdAt: string;
  updatedAt: string;
}

export type ApprovalRisk = 'normal' | 'destructive';
export type ApprovalDecision = 'approve_once' | 'deny';
export type ApprovalVia = 'controller' | 'local-ui';

export interface Approval {
  id: string;
  threadId: string;
  jobId?: string;
  tool: string;
  argsSummary: string;
  workspace: string;
  risk: ApprovalRisk;
  expiresAt: string;
  decision?: ApprovalDecision;
  decidedVia?: ApprovalVia;
}

export type MessageMode = 'queue' | 'steer';

export type EventType =
  | 'turn.started'
  | 'output.delta'
  | 'tool.started'
  | 'tool.finished'
  | 'question.asked'
  | 'approval.requested'
  | 'approval.resolved'
  | 'turn.finished'
  | 'thread.state'
  | 'job.state';

export interface LinkEvent {
  seq: number;
  threadId: string;
  type: EventType;
  at: string;
  payload: Record<string, unknown>;
}

export interface MachineStatus {
  machineId: string;
  endpointVersion: string;
  agents: Record<
    AgentKind,
    {
      available: boolean;
      version?: string;
      runningTurns: number;
      concurrencyLimit: number;
    }
  >;
}

export interface ApiError {
  error: {
    code:
      | 'unauthorized'
      | 'forbidden_source'
      | 'pairing_code_invalid'
      | 'workspace_not_allowed'
      | 'thread_not_found'
      | 'session_conflict'
      | 'approval_expired'
      | 'concurrency_limit'
      | 'agent_unavailable'
      | 'internal';
    message: string;
  };
}
