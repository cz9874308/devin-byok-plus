import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readLogConfigFromEnv,
  configureLog,
  getLogConfig,
} from "../../src/proxy/logging/log-config.js";

test("默认值: enabled=true, verbose=false, maxMb=10, retainDays=7", () => {
  const cfg = readLogConfigFromEnv({});
  assert.equal(cfg.logEnabled, true);
  assert.equal(cfg.logVerbose, false);
  assert.equal(cfg.logMaxMb, 10);
  assert.equal(cfg.logRetainDays, 7);
});

test("env 字符串 'false' 关闭开关", () => {
  const cfg = readLogConfigFromEnv({ LOG_ENABLED: "false", LOG_VERBOSE: "false" });
  assert.equal(cfg.logEnabled, false);
  assert.equal(cfg.logVerbose, false);
});

test("env 字符串 'true' 打开 verbose", () => {
  const cfg = readLogConfigFromEnv({ LOG_VERBOSE: "true" });
  assert.equal(cfg.logVerbose, true);
});

test("数值项非法时回落默认值", () => {
  const cfg = readLogConfigFromEnv({ LOG_MAX_MB: "abc", LOG_RETAIN_DAYS: "-5" });
  assert.equal(cfg.logMaxMb, 10);
  assert.equal(cfg.logRetainDays, 7);
});

test("数值项有上限保护", () => {
  const cfg = readLogConfigFromEnv({ LOG_MAX_MB: "999999", LOG_RETAIN_DAYS: "999999" });
  assert.ok(cfg.logMaxMb <= 1024);
  assert.ok(cfg.logRetainDays <= 365);
});

test("非对象 env 入参回落默认值, 不抛异常", () => {
  assert.doesNotThrow(() => readLogConfigFromEnv(null));
  const cfg = readLogConfigFromEnv(null);
  assert.equal(cfg.logEnabled, true);
  assert.equal(cfg.logMaxMb, 10);
});

test("configureLog 热更新 verbose 生效", () => {
  configureLog({ LOG_VERBOSE: "true" });
  assert.equal(getLogConfig().logVerbose, true);
  configureLog({ LOG_VERBOSE: "false" });
  assert.equal(getLogConfig().logVerbose, false);
});

test("configureLog 只改传入的键, 不动其他键", () => {
  configureLog({ LOG_ENABLED: "true", LOG_MAX_MB: "20" });
  const before = getLogConfig();
  configureLog({ LOG_VERBOSE: "true" });
  const after = getLogConfig();
  assert.equal(after.logMaxMb, before.logMaxMb);
  assert.equal(after.logEnabled, before.logEnabled);
  assert.equal(after.logVerbose, true);
  configureLog({ LOG_VERBOSE: "false", LOG_MAX_MB: "10" });
});

test("configureLog 传 null / 非对象不抛异常", () => {
  assert.doesNotThrow(() => configureLog(null));
  assert.doesNotThrow(() => configureLog(undefined));
  assert.doesNotThrow(() => configureLog("nonsense"));
  assert.doesNotThrow(() => configureLog(123));
});

test("configureLog 接受 camelCase 运行态字段", () => {
  configureLog({ logVerbose: true });
  assert.equal(getLogConfig().logVerbose, true);
  configureLog({ logVerbose: false });
  assert.equal(getLogConfig().logVerbose, false);
});

test("configureLog 返回当前配置快照", () => {
  const returned = configureLog({ LOG_MAX_MB: "15" });
  assert.equal(returned.logMaxMb, 15);
  assert.deepEqual(returned, getLogConfig());
  configureLog({ LOG_MAX_MB: "10" });
});

test("getLogConfig 返回副本, 外部改动不污染内部状态", () => {
  const snapshot = getLogConfig();
  snapshot.logVerbose = true;
  snapshot.logMaxMb = 999;
  assert.equal(getLogConfig().logVerbose, false);
  assert.equal(getLogConfig().logMaxMb, 10);
});

test("configureLog 忽略无关键名（如 BYOK 配置）", () => {
  const before = getLogConfig();
  configureLog({ BYOK1_MODEL: "gpt-5.5", DEFAULT_MODEL: "claude" });
  assert.deepEqual(getLogConfig(), before);
});
