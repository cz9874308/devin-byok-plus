#!/usr/bin/env node
// 只读日志聚合报告。绝不写、删、改任何日志文件（spec 第 7 节不变量 6）。
// 用法：npm run logs:report -- --date=2026-07-30 --days=3
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 断开类 anomaly：命中任一即视为该轮断开
const BROKEN_CODES = new Set([
  'empty_stream_exhausted',
  'circuit_breaker',
  'request_timeout',
  'stream_idle_timeout',
  'stream_aborted',
  'stream_error',
]);
// 触发过自愈尝试的 anomaly
const RETRY_CODES = new Set(['retry', 'empty_stream']);

export function parseLines(lines) {
  const events = [];
  let malformed = 0;
  for (const raw of lines || []) {
    const text = String(raw || '').trim();
    if (!text) {
      continue;
    }
    try {
      events.push(JSON.parse(text));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

function pct(part, total) {
  if (!total) {
    return 'n/a';
  }
  return ((part / total) * 100).toFixed(1) + '%';
}

function turnIdsOf(events, type) {
  const set = new Set();
  for (const e of events) {
    if (e && e.type === type && e.turnId) {
      set.add(e.turnId);
    }
  }
  return set;
}

export function summarize(events) {
  const starts = turnIdsOf(events, 'turn_start');
  const turns = turnIdsOf(events, 'chat_turn');
  let orphans = 0;
  for (const id of starts) {
    if (!turns.has(id)) {
      orphans++;
    }
  }
  return {
    turnStarts: starts.size,
    chatTurns: turns.size,
    orphans,
    completionRate: pct(turns.size, starts.size),
  };
}

export function groupAnomalies(events) {
  const byCode = new Map();
  for (const e of events) {
    if (!e || e.type !== 'anomaly' || !e.code) {
      continue;
    }
    const row = byCode.get(e.code) || { code: e.code, severity: e.severity || 'low', count: 0 };
    row.count++;
    byCode.set(e.code, row);
  }
  return [...byCode.values()].sort((a, b) => b.count - a.count);
}

export function listBrokenTurns(events) {
  const out = [];
  const starts = turnIdsOf(events, 'turn_start');
  const turns = new Map();
  for (const e of events) {
    if (e && e.type === 'chat_turn' && e.turnId) {
      turns.set(e.turnId, e);
    }
  }
  for (const [turnId, turn] of turns) {
    const codes = Array.isArray(turn.anomalies) ? turn.anomalies : [];
    const hit = codes.find((c) => BROKEN_CODES.has(c));
    if (hit) {
      out.push({
        turnId,
        reason: hit,
        stopReason: turn.stopReason ?? null,
        retryCount: turn.retryCount ?? 0,
        emptyRetries: turn.emptyRetries ?? 0,
        upstreamHost: turn.upstreamHost ?? '',
        durationMs: turn.durationMs ?? 0,
      });
    }
  }
  for (const turnId of starts) {
    if (!turns.has(turnId)) {
      out.push({ turnId, reason: 'orphan' });
    }
  }
  return out;
}

export function recoveryRate(events) {
  let attempted = 0;
  let recovered = 0;
  for (const e of events) {
    if (!e || e.type !== 'chat_turn') {
      continue;
    }
    const codes = Array.isArray(e.anomalies) ? e.anomalies : [];
    if (!codes.some((c) => RETRY_CODES.has(c))) {
      continue;
    }
    attempted++;
    if (e.stopReason) {
      recovered++;
    }
  }
  return { attempted, recovered, rate: pct(recovered, attempted) };
}

export function aggregate(lines) {
  const { events, malformed } = parseLines(lines);
  return {
    malformed,
    summary: summarize(events),
    anomalies: groupAnomalies(events),
    brokenTurns: listBrokenTurns(events),
    recovery: recoveryRate(events),
  };
}

// ── 以下为脚本外壳：读文件 + 打印，不参与单测 ──

function logDir() {
  return path.join(os.homedir(), '.devin-byok-plus', 'logs');
}

function localDateOf(ts) {
  const d = new Date(Number(ts) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function utcDateStr(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

// 文件名按 UTC 日期（log-file.js:24-29），本地日期 D 的事件可能落在
// proxy-D 与 proxy-(D±1) 文件里，因此都读，最后按 ts 的本地日期过滤。
function filesForLocalDates(dir, dates) {
  const wanted = new Set();
  for (const dateStr of dates) {
    const base = new Date(dateStr + 'T00:00:00');
    wanted.add(utcDateStr(base));
    wanted.add(utcDateStr(new Date(base.getTime() - 86400000)));
    wanted.add(utcDateStr(new Date(base.getTime() + 86400000)));
  }
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      const m = /^proxy-(\d{4}-\d{2}-\d{2})(\.\d+)?\.jsonl$/.exec(n);
      return m && wanted.has(m[1]);
    })
    .map((n) => path.join(dir, n));
}

function parseArgs(argv) {
  const out = { date: localDateOf(Date.now()), days: 1 };
  for (const a of argv) {
    const m = /^--([a-z]+)=(.+)$/.exec(a);
    if (!m) {
      continue;
    }
    if (m[1] === 'date') {
      out.date = m[2];
    } else if (m[1] === 'days') {
      out.days = Math.max(1, parseInt(m[2], 10) || 1);
    }
  }
  return out;
}

function datesBack(dateStr, days) {
  const base = new Date(dateStr + 'T00:00:00');
  const list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(base.getTime() - i * 86400000);
    const p = (n) => String(n).padStart(2, '0');
    list.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
  }
  return list;
}

function main() {
  const { date, days } = parseArgs(process.argv.slice(2));
  const dates = datesBack(date, days);
  const dir = logDir();
  const files = filesForLocalDates(dir, dates);
  if (files.length === 0) {
    console.log('未找到日志文件：' + dir);
    return;
  }
  const wantedDates = new Set(dates);
  const lines = [];
  for (const f of files) {
    for (const raw of fs.readFileSync(f, 'utf8').split('\n')) {
      const text = raw.trim();
      if (!text) {
        continue;
      }
      let ts = 0;
      const m = /"ts":(\d+)/.exec(text);
      if (m) {
        ts = Number(m[1]);
      }
      if (wantedDates.has(localDateOf(ts))) {
        lines.push(text);
      }
    }
  }
  const report = aggregate(lines);
  console.log('日期（本地）：' + dates.join(', '));
  console.log('文件：' + files.map((f) => path.basename(f)).join(', '));
  console.log('坏行：' + report.malformed);
  console.log('');
  console.log('── 概览 ──');
  console.log(
    '发起 ' +
      report.summary.turnStarts +
      ' / 完成 ' +
      report.summary.chatTurns +
      ' / 完成率 ' +
      report.summary.completionRate +
      ' / 孤儿轮 ' +
      report.summary.orphans
  );
  console.log('');
  console.log('── anomaly 分布 ──');
  for (const row of report.anomalies) {
    console.log('  ' + row.code.padEnd(24) + row.severity.padEnd(8) + row.count);
  }
  console.log('');
  console.log('── 自愈率（重试/空流重试后是否有 stopReason）──');
  console.log(
    '  ' +
      report.recovery.recovered +
      '/' +
      report.recovery.attempted +
      ' = ' +
      report.recovery.rate
  );
  console.log('');
  console.log('── 断开轮清单 ──');
  for (const b of report.brokenTurns) {
    if (b.reason === 'orphan') {
      console.log('  ' + b.turnId.slice(0, 8) + '  orphan（有始无终）');
      continue;
    }
    console.log(
      '  ' +
        b.turnId.slice(0, 8) +
        '  ' +
        b.reason.padEnd(24) +
        'stop=' +
        (b.stopReason ?? '-') +
        ' retry=' +
        b.retryCount +
        ' empty=' +
        b.emptyRetries +
        ' host=' +
        b.upstreamHost +
        ' dur=' +
        b.durationMs +
        'ms'
    );
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main();
}
