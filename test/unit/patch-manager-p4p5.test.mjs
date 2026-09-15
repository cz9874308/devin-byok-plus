import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PatchManager } = require('../../src/managers/patchManager.js');

// P4/P5 规则片段取自 Devin 2026-09-16 内置 windsurf 扩展真实 bundle
const P4_ORIGINAL = 'api_server_url:(0,d.getConfig)(d.Config.API_SERVER_URL)}}},e.token)';
const P4_CONTEXT = 'sendHandshakeRequest({method:"authenticate",params:{methodId:"windsurf-api-key",_meta:{api_key:A,api_server_url:(0,d.getConfig)(d.Config.API_SERVER_URL)}}},e.token)';
const P5_ORIGINAL = 'const t=s.workspace.getConfiguration().get("http.noProxy");return t&&Array.isArray(t)&&t.length>0&&(A.NO_PROXY=t.map(A=>A.trim()).join(",")),A}';

function buildRules() {
    const rules = [];
    for (const name of [
        'P4: authenticate API Server URL',
        'P5: NO_PROXY 豁免 localhost',
    ]) {
        rules.push({ name, originalRegex: null });
    }
    return rules;
}
void buildRules;

function ruleByName(name, originalRegexSource) {
    return { name, originalRegex: new RegExp(originalRegexSource) };
}

const REGEX_SRC = {
    P4: String.raw`api_server_url:\(0,([A-Za-z_$][\w$]*)\.getConfig\)\(\1\.Config\.API_SERVER_URL\)`,
    P5: String.raw`get\("http\.noProxy"\);return ([A-Za-z_$][\w$]*)&&Array\.isArray\(\1\)&&\1\.length>0&&\(([A-Za-z_$][\w$]*)\.NO_PROXY=\1\.map\(([A-Za-z_$][\w$]*)=>\3\.trim\(\)\)\.join\(","\)\),\2\}`,
};

describe('P4: authenticate API Server URL', () => {
    it('isPatched 对原始内容 → false', () => {
        const rule = ruleByName('P4: authenticate API Server URL', REGEX_SRC.P4);
        assert.equal(PatchManager.isPatched(P4_CONTEXT, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001'), false);
    });

    it('isPatched 对已打补丁(127.0.0.1/localhost 两种形态) → true', () => {
        const rule = ruleByName('P4: authenticate API Server URL', REGEX_SRC.P4);
        const contentA = P4_CONTEXT.replace(P4_ORIGINAL, 'api_server_url:"http://127.0.0.1:3006"}}},e.token)');
        const contentB = P4_CONTEXT.replace(P4_ORIGINAL, 'api_server_url:"http://localhost:3006"}}},e.token)');
        assert.equal(PatchManager.isPatched(contentA, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001'), true);
        assert.equal(PatchManager.isPatched(contentB, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001'), true);
    });

    it('applyPatchContent 将 api_server_url 改写为本地代理 URL', () => {
        const rule = ruleByName('P4: authenticate API Server URL', REGEX_SRC.P4);
        const res = PatchManager.applyPatchContent(P4_CONTEXT, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001');
        assert.equal(res.changed, true);
        assert.ok(res.content.includes('api_server_url:"http://127.0.0.1:3006"'));
    });

    it('applyPatchContent 对已打但 URL 不同的内容 → 更新 URL', () => {
        const rule = ruleByName('P4: authenticate API Server URL', REGEX_SRC.P4);
        const content = P4_CONTEXT.replace(P4_ORIGINAL, 'api_server_url:"http://localhost:3006"}}},e.token)');
        const res = PatchManager.applyPatchContent(content, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001');
        assert.equal(res.changed, true);
        assert.ok(res.content.includes('api_server_url:"http://127.0.0.1:3006"'));
    });
});

describe('P5: NO_PROXY 豁免 localhost', () => {
    it('isPatched 对原始内容 → false', () => {
        const rule = ruleByName('P5: NO_PROXY 豁免 localhost', REGEX_SRC.P5);
        assert.equal(PatchManager.isPatched(P5_ORIGINAL, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001'), false);
    });

    it('isPatched 对已打补丁 → true', () => {
        const rule = ruleByName('P5: NO_PROXY 豁免 localhost', REGEX_SRC.P5);
        assert.equal(PatchManager.isPatched('A.NO_PROXY="localhost,127.0.0.1"+(t&&t.length>0?"x":"")', rule, '', ''), true);
    });

    it('applyPatchContent 全局替换重复模块 (webpack 双份)', () => {
        const rule = ruleByName('P5: NO_PROXY 豁免 localhost', REGEX_SRC.P5);
        const content = P5_ORIGINAL + 'XXXX' + P5_ORIGINAL;
        const res = PatchManager.applyPatchContent(content, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001');
        assert.equal(res.changed, true);
        assert.equal((res.content.match(/NO_PROXY="localhost,127\.0\.0\.1"\+/g) || []).length, 2);
        assert.ok(res.content.includes('A.NO_PROXY="localhost,127.0.0.1"+(t&&Array.isArray(t)&&t.length>0?","+t.map(A=>A.trim()).join(","):"");return A}'));
    });

    it('applyPatchContent 幂等 (已打内容再跑 → unchanged)', () => {
        const rule = ruleByName('P5: NO_PROXY 豁免 localhost', REGEX_SRC.P5);
        const once = PatchManager.applyPatchContent(P5_ORIGINAL, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001');
        const twice = PatchManager.applyPatchContent(once.content, rule, 'http://127.0.0.1:3006', 'http://127.0.0.1:3001');
        assert.equal(twice.changed, false);
        assert.equal(twice.content, once.content);
    });
});