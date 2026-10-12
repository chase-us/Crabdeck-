/**
 * Canonical local event contract — Crabdeck Omni-Layer v0.1.0.
 *
 * LOCAL ONLY. These event types describe things that happen inside this
 * browser tab (workflow designer activity) or on this machine (local
 * backend state). There is deliberately NO remote command event type:
 * WAR_ROOM_COMMAND (SPAWN_NODE / KILL_NODE / FORCE_MOLT / TRIGGER_CHAOS)
 * and any dispatch path that pushes commands to remote nodes are
 * explicitly out of scope and must not be added here.
 */

export type EventType = "AGENT_LOG" | "AGENT_SIGNAL" | "ANALYTICS_METRIC";

export type SignalStatus = "PENDING" | "SUCCESS" | "ERROR";

export type LogLevel = "info" | "ok" | "warn" | "error";

/** Every event carries an ISO-8601 timestamp and a source tag. */
export interface EventBase {
  type: EventType;
  ts: string;
  source: string;
}

/** A local workflow log line (terminal drawer entries). */
export interface AgentLogEvent extends EventBase {
  type: "AGENT_LOG";
  level: LogLevel;
  tag: string;
  text: string;
}

/** A local agent lifecycle signal. Local only — never dispatched remotely. */
export interface AgentSignalEvent extends EventBase {
  type: "AGENT_SIGNAL";
  agentId: string;
  status: SignalStatus;
  detail?: string;
}

/** A local performance number (real counts, never fabricated telemetry). */
export interface AnalyticsMetricEvent extends EventBase {
  type: "ANALYTICS_METRIC";
  name: string;
  value: number;
  unit?: string;
}

/** The complete local event contract — exactly these three types. */
export type LocalEvent = AgentLogEvent | AgentSignalEvent | AnalyticsMetricEvent;

function stamp(): string {
  return new Date().toISOString();
}

export function makeLog(
  tag: string,
  text: string,
  level: LogLevel = "info",
  source = "workflow-studio"
): AgentLogEvent {
  return { type: "AGENT_LOG", ts: stamp(), source, level, tag, text };
}

export function makeSignal(
  agentId: string,
  status: SignalStatus,
  detail?: string,
  source = "workflow-studio"
): AgentSignalEvent {
  return { type: "AGENT_SIGNAL", ts: stamp(), source, agentId, status, detail };
}

export function makeMetric(
  name: string,
  value: number,
  unit?: string,
  source = "workflow-studio"
): AnalyticsMetricEvent {
  return { type: "ANALYTICS_METRIC", ts: stamp(), source, name, value, unit };
}
