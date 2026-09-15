import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    wrapEnvelope,
    endOfStreamEnvelope,
    emptyResponse,
    wrapUnary,
    unaryHeaders,
    streamHeaders,
} from '../../src/proxy/connect.js';

// Connect 协议 envelope 必须保持未压缩(identity):
// chisel(Rust connect 客户端)未协商压缩, 服务端无条件 gzip 会被拒收
// (server sent compressed envelope, but compression is not supported)。
describe('connect envelope identity 化', () => {
    it('wrapEnvelope 默认不压缩 (flags=0, 原样 payload)', () => {
        const payload = Buffer.from('{"ok":true}');
        const env = wrapEnvelope(payload);
        assert.equal(env[0], 0);
        assert.equal(env.readUInt32BE(1), payload.length);
        assert.ok(env.subarray(5).equals(payload));
    });

    it('wrapEnvelope 显式压缩仍可用 (flags=1, gzip)', () => {
        const payload = Buffer.from('{"ok":true}');
        const env = wrapEnvelope(payload, true);
        assert.equal(env[0], 1);
        assert.equal(env.readUInt32BE(1), env.length - 5);
    });

    it('endOfStreamEnvelope flags=2 且 payload 为明文 {}', () => {
        const env = endOfStreamEnvelope();
        assert.equal(env[0], 2);
        assert.equal(env.readUInt32BE(1), 2);
        assert.equal(env.subarray(5).toString('utf8'), '{}');
    });

    it('emptyResponse 为空 buffer (无 gzip 头)', () => {
        const buf = emptyResponse();
        assert.equal(buf.length, 0);
    });

    it('wrapUnary 原样返回 (无 gzip)', () => {
        const payload = Buffer.from('abc');
        assert.ok(wrapUnary(payload).equals(payload));
    });

    it('unaryHeaders 不声明 content-encoding', () => {
        const h = unaryHeaders();
        assert.equal(h['content-type'], 'application/proto');
        assert.equal(h['content-encoding'], undefined);
    });

    it('streamHeaders 不声明 connect-content-encoding', () => {
        const h = streamHeaders();
        assert.equal(h['content-type'], 'application/connect+proto');
        assert.equal(h['transfer-encoding'], 'chunked');
        assert.equal(h['connect-content-encoding'], undefined);
    });
});