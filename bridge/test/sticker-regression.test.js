import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importToOutgoing } from '../src/memes.js';
import { createSender } from '../src/sender.js';

 test('GIF import reports real dimensions and digest of submitted bytes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sticker-regression-'));
  try {
    const buffer = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const result = importToOutgoing({buffer, ext: 'gif', outgoingDir: dir});
    assert.equal(result.width, 1); assert.equal(result.height, 1);
    assert.equal(result.md5, createHash('md5').update(readFileSync(result.path)).digest('hex'));
    assert.equal(result.len, buffer.length);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('failed conversion cannot silently send source webp', () => {
  assert.throws(() => importToOutgoing({file: 'missing.webp', pythonPath: 'missing-python', outgoingDir: tmpdir(), buffer: Buffer.from('x')}), /MEME_CONVERSION_FAILED/);
});

for (const [name, row, ok] of [
  ['matching md5', {localType:47, stickerMd5:'a'.repeat(32)}, true],
  ['different md5', {localType:47, stickerMd5:'b'.repeat(32)}, false],
  ['unrelated text', {localType:1, fullText:'other'}, false],
  ['unconfirmed server id', {localType:47, serverId:0}, false],
]) test('sticker receipt: ' + name, async () => {
  let calls=0;
  const sender=createSender({reader:{sessions:async()=>[{username:'wxid_test',conversationId:1}],messages:async()=>calls++ ? [{localId:2,isSend:1,serverId:'123',...row}] : []},hook:{post:async()=>({ret:0})},conversationId:(_,__,id)=>id,receiptTimeoutMs:0});
  const result=await sender.sendSticker({kind:'private',target:1,sticker:{md5:'a'.repeat(32),path:'test.gif'}});
  assert.equal(result.ok,ok);
});

test('native HTTP rejection is not disguised as receipt timeout', async () => {
  const sender=createSender({reader:{sessions:async()=>[{username:'wxid_test',conversationId:1}],messages:async()=>[]},hook:{post:async()=>{throw Object.assign(new Error('HTTP 422 Native sticker rejected'),{code:'NATIVE_HTTP_ERROR',status:422});}},conversationId:(_,__,id)=>id});
  const result=await sender.sendSticker({kind:'private',target:1,sticker:{md5:'a'.repeat(32),path:'test.gif'}});
  assert.equal(result.error,'NATIVE_HTTP_ERROR'); assert.equal(result.status,422); assert.match(result.detail,/rejected/);
});
