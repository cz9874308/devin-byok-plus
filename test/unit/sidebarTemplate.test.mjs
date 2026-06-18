/**
 * sidebarTemplate.js 单元测试
 * 测试 HTML 模板渲染功能
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');

// 动态导入 sidebarTemplate
let renderSidebarHtml;

test('sidebarTemplate.js 模块加载', async (t) => {
  await t.test('应该能够加载模块', async () => {
    const module = await import(join(projectRoot, 'src/views/sidebarTemplate.js'));
    renderSidebarHtml = module.renderSidebarHtml;
    assert.ok(renderSidebarHtml, '模块应该导出 renderSidebarHtml 函数');
    assert.strictEqual(typeof renderSidebarHtml, 'function', 'renderSidebarHtml 应该是函数');
  });
});

test('HTML 结构渲染', async (t) => {
  const mockContext = {
    nonce: 'test-nonce-123',
    cspSource: 'vscode-resource:',
    scriptUri: 'script.js',
    cssUri: 'style.css',
    tmp02: { hybridPort: 3006, inferencePort: 3001, running: false, uptime: 0, requestCount: 0 },
    tmp2: {},
    tmp8: '',
    tmp9: false,
    tmp10: 'test-nonce',
    tmp11: 'vscode-resource:',
    tmp12: 'script.js',
    tmp12a: 'tailwind.css',
    tmp17: '#888',
    tmp21: '#444',
    tmp25: '', tmp26: '', tmp27: '', tmp28: '', tmp29: '', tmp30: '', tmp31: '', tmp32: '',
    tmp3: '', tmp4: '', tmp5: false, tmp6: '', tmp34: 'badge-warning', tmp35: '未安装', tmp36: '等待日志...'
  };

  await t.test('应该返回有效的 HTML 字符串', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html, '应该返回 HTML');
    assert.ok(html.includes('<!DOCTYPE html>'), '应该包含 DOCTYPE');
    assert.ok(html.includes('<html'), '应该包含 html 标签');
  });

  await t.test('应该包含必要的 meta 标签', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('<meta charset="UTF-8">'), '应该包含 charset meta');
    assert.ok(html.includes('Content-Security-Policy'), '应该包含 CSP meta');
  });

  await t.test('应该包含三个 Tab 按钮', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('data-tab="tab-system"'), '应该包含系统补丁 tab');
    assert.ok(html.includes('data-tab="tab-config"'), '应该包含配置连接 tab');
    assert.ok(html.includes('data-tab="tab-control"'), '应该包含控制状态 tab');
  });

  await t.test('应该包含使用教程', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('📖 使用教程'), '应该包含使用教程标题');
    assert.ok(html.includes('tutorialBody'), '应该包含教程内容区域');
  });

  await t.test('应该包含保存配置按钮', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('💾 保存配置'), '应该包含保存按钮');
    assert.ok(html.includes('data-ws-action="saveConfig"'), '应该有 saveConfig action');
  });

  await t.test('应该包含日志控制按钮', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('data-ws-action="clearLogs"'), '应该有清空日志按钮');
    assert.ok(html.includes('data-ws-action="toggleLogPause"'), '应该有暂停日志按钮');
    assert.ok(html.includes('data-ws-action="copyLogs"'), '应该有复制日志按钮');
  });

  await t.test('应该包含高级路由配置', () => {
    const html = renderSidebarHtml(mockContext);
    assert.ok(html.includes('高级路由配置'), '应该包含高级路由标题');
    assert.ok(html.includes('cfgAnthropicPath'), '应该包含 Anthropic 路径配置');
    assert.ok(html.includes('cfgOpenaiPath'), '应该包含 OpenAI 路径配置');
  });
});

test('XSS 防护', async (t) => {
  const maliciousContext = {
    nonce: '<script>alert("xss")</script>',
    cspSource: 'vscode-resource:',
    scriptUri: 'script.js',
    cssUri: 'style.css',
    tmp02: { hybridPort: 3006, inferencePort: 3001, running: false, uptime: 0, requestCount: 0 },
    tmp2: { ANTHROPIC_API_PATH: '<script>alert("xss")</script>' },
    tmp8: '<img src=x onerror=alert("xss")>',
    tmp9: false,
    tmp10: 'test-nonce',
    tmp11: 'vscode-resource:',
    tmp12: 'script.js',
    tmp12a: 'tailwind.css',
    tmp17: '#888',
    tmp21: '#444',
    tmp25: '<script>evil()</script>',
    tmp26: '"><script>alert("xss")</script>',
    tmp27: '', tmp28: '', tmp29: '', tmp30: '', tmp31: '', tmp32: '',
    tmp3: '', tmp4: '', tmp5: false, tmp6: '', tmp34: 'badge-warning', tmp35: '未安装', tmp36: '等待日志...'
  };

  await t.test('应该转义用户输入', () => {
    const html = renderSidebarHtml(maliciousContext);
    // 校验危险标签未以可执行形式出现（尖括号必须被转义）
    assert.ok(!html.includes('<script>alert'), '不应该包含未转义的 script 标签');
    assert.ok(!html.includes('<img src=x onerror'), '不应该包含未转义的 img 标签');
    // 反向确认：恶意内容应以转义实体形式存在
    assert.ok(html.includes('&lt;script&gt;') || html.includes('&lt;img'), '危险输入应被转义为 HTML 实体');
  });
});

test('边界情况处理', async (t) => {
  await t.test('应该处理空值', () => {
    const emptyContext = {
      nonce: '', cspSource: '', scriptUri: '', cssUri: '',
      tmp02: { hybridPort: 0, inferencePort: 0, running: false, uptime: 0, requestCount: 0 },
      tmp2: {}, tmp8: '', tmp9: false, tmp10: '', tmp11: '', tmp12: '', tmp12a: '',
      tmp17: '', tmp21: '', tmp25: '', tmp26: '', tmp27: '', tmp28: '', tmp29: '', tmp30: '',
      tmp31: '', tmp32: '', tmp3: '', tmp4: '', tmp5: false, tmp6: '',
      tmp34: '', tmp35: '', tmp36: ''
    };
    const html = renderSidebarHtml(emptyContext);
    assert.ok(html.length > 0, '即使值为空也应该返回 HTML');
  });

  await t.test('应该处理未定义的值', () => {
    const minimalContext = {
      nonce: 'test',
      cspSource: 'vscode-resource:',
      scriptUri: 'script.js',
      cssUri: 'style.css',
      tmp02: { hybridPort: 3006, inferencePort: 3001, running: false, uptime: 0, requestCount: 0 },
      tmp2: {},
      tmp10: 'test-nonce',
      tmp11: 'vscode-resource:',
      tmp12: 'script.js',
      tmp12a: 'tailwind.css',
      tmp17: '#888',
      tmp21: '#444',
      tmp34: 'badge-warning',
      tmp35: '未安装',
      tmp36: '等待日志...'
    };
    const html = renderSidebarHtml(minimalContext);
    assert.ok(html.length > 0, '缺少部分值时应该返回 HTML');
  });
});

test('DOM id 完整性', async (t) => {
  const mockContext = {
    nonce: 'test-nonce',
    cspSource: 'vscode-resource:',
    scriptUri: 'script.js',
    cssUri: 'style.css',
    tmp02: { hybridPort: 3006, inferencePort: 3001, running: false, uptime: 0, requestCount: 0 },
    tmp2: {},
    tmp8: '',
    tmp9: false,
    tmp10: 'test-nonce',
    tmp11: 'vscode-resource:',
    tmp12: 'script.js',
    tmp12a: 'tailwind.css',
    tmp17: '#888',
    tmp21: '#444',
    tmp25: '', tmp26: '', tmp27: '', tmp28: '', tmp29: '', tmp30: '', tmp31: '', tmp32: '',
    tmp3: '', tmp4: '', tmp5: false, tmp6: '', tmp34: 'badge-warning', tmp35: '未安装', tmp36: '等待日志...'
  };

  await t.test('应该包含所有关键 DOM id', () => {
    const html = renderSidebarHtml(mockContext);
    const criticalIds = [
      'tutorialBody',
      'tab-system', 'tab-config', 'tab-control',
      'cfgByok1Host', 'cfgByok1Key', 'cfgByok1Model', 'cfgByok1ThinkingEffort',
      'cfgByok2Host', 'cfgByok2Key', 'cfgByok2Model', 'cfgByok2ThinkingEffort',
      'cfgAnthropicPath', 'cfgOpenaiPath', 'cfgMaxTokens', 'cfgCompletionTimeoutMs',
      'cfgHybridPort', 'cfgInferencePort',
      'logBox', 'logPauseBtn',
      'advancedRouteBody'
    ];

    criticalIds.forEach(id => {
      assert.ok(html.includes(`id="${id}"`), `应该包含 id="${id}"`);
    });
  });

  await t.test('不应该有重复的 id', () => {
    const html = renderSidebarHtml(mockContext);
    const idMatches = html.match(/id="([^"]+)"/g) || [];
    const ids = idMatches.map(m => m.match(/id="([^"]+)"/)[1]);
    const uniqueIds = new Set(ids);
    assert.strictEqual(ids.length, uniqueIds.size, '不应该有重复的 DOM id');
  });
});
