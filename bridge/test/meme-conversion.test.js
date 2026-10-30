import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {importToOutgoing} from '../src/memes.js';
const pythonPath=process.env.MEME_TEST_PYTHON || 'python';
for(const ext of ['jpg','png','webp']) test(`conversion ${ext}: decodable two identical frames and true dimensions`,{skip:!existsSync(pythonPath)},()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'meme-conversion-'));
 try {
  const file=path.join(dir,'source.'+ext);
  const make=spawnSync(pythonPath,['-c','from PIL import Image; import sys; Image.new("RGB",(37,23),(255,0,0)).save(sys.argv[1])',file]);
  assert.equal(make.status,0,make.stderr?.toString());
  const result=importToOutgoing({file,pythonPath,outgoingDir:dir});
  assert.equal(result.width,37); assert.equal(result.height,23); assert.ok(result.len>0);
  const check=spawnSync(pythonPath,['-c','from PIL import Image,ImageSequence; import sys; im=Image.open(sys.argv[1]); assert im.format=="GIF"; assert im.n_frames>=2; assert im.size==(37,23); frames=[f.convert("RGB").tobytes() for f in ImageSequence.Iterator(im)]; assert frames[0]==frames[1]',result.path]);
  assert.equal(check.status,0,check.stderr?.toString());
 } finally {rmSync(dir,{recursive:true,force:true});}
});
