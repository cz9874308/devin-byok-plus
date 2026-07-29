// anomaly 代码表。全部对应代码中【已存在】的分支，不新增任何判定逻辑。
// 详见 docs/superpowers/specs/2026-07-29-file-logging-design.md 第 6 节。

export const Severity = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

export const Anomaly = Object.freeze({
  // high — 断开场景
  STREAM_ABORTED: "stream_aborted",
  STREAM_ERROR: "stream_error",
  STREAM_IDLE_TIMEOUT: "stream_idle_timeout",
  REQUEST_TIMEOUT: "request_timeout",
  FORCED_STOP: "forced_stop",
  UPSTREAM_ERROR_STATUS: "upstream_error_status",
  // medium — 重试/熔断/工具降级
  RETRY: "retry",
  CIRCUIT_BREAKER: "circuit_breaker",
  TOOL_CALLS_DOWNGRADED: "tool_calls_downgraded",
  TOOLS_ALL_FILTERED: "tools_all_filtered",
  TOOL_RECOVERED_FROM_TEXT: "tool_recovered_from_text",
  TOOL_ARGS_INVALID_JSON: "tool_args_invalid_json",
  // low — 名称纠正/透传
  TOOL_NAME_AUTOCORRECTED: "tool_name_autocorrected",
  TOOL_UNKNOWN_PASSTHROUGH: "tool_unknown_passthrough",
});

const SEVERITY_BY_CODE = Object.freeze({
  [Anomaly.STREAM_ABORTED]: Severity.HIGH,
  [Anomaly.STREAM_ERROR]: Severity.HIGH,
  [Anomaly.STREAM_IDLE_TIMEOUT]: Severity.HIGH,
  [Anomaly.REQUEST_TIMEOUT]: Severity.HIGH,
  [Anomaly.FORCED_STOP]: Severity.HIGH,
  [Anomaly.UPSTREAM_ERROR_STATUS]: Severity.HIGH,
  [Anomaly.RETRY]: Severity.MEDIUM,
  [Anomaly.CIRCUIT_BREAKER]: Severity.MEDIUM,
  [Anomaly.TOOL_CALLS_DOWNGRADED]: Severity.MEDIUM,
  [Anomaly.TOOLS_ALL_FILTERED]: Severity.MEDIUM,
  [Anomaly.TOOL_RECOVERED_FROM_TEXT]: Severity.MEDIUM,
  [Anomaly.TOOL_ARGS_INVALID_JSON]: Severity.MEDIUM,
  [Anomaly.TOOL_NAME_AUTOCORRECTED]: Severity.LOW,
  [Anomaly.TOOL_UNKNOWN_PASSTHROUGH]: Severity.LOW,
});

// 未知 code 一律归 low，绝不抛异常（日志代码不得打断业务）。
export function severityOf(code) {
  return SEVERITY_BY_CODE[code] || Severity.LOW;
}

export function isHigh(code) {
  return severityOf(code) === Severity.HIGH;
}
