import test from 'node:test';
import assert from 'node:assert/strict';
import { toModelUri,fromModelUri,toWorkspaceUri,fromWorkspaceUri,normalizeContent } from '../../src/services/editor-language/codec';
// Actual Monaco public URI implementation (not an editor/browser integration test).
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js';
test('one canonical project hex authority and POSIX/Unicode/spaces/nonBMP/decode-once roundtrip',()=>{
  for(const path of ['src/Zażółć space 😀.ts','literal/%2e%2e.txt','a/#hash?.ts',"a/quote'().txt"]){
    const uri=toModelUri('projekt 😀',path);assert.equal(fromModelUri('projekt 😀',uri),path);
    assert.equal(fromWorkspaceUri(toWorkspaceUri(path)),path);
    assert.equal(fromModelUri('projekt 😀',URI.parse(uri).toString()),path,'actual Monaco URI serializer');
  }
});
test('wrong scope, traversal, separators, double decode, absolute/drive/UNC/query/control/device aliases rejected',()=>{
  for(const path of ['../a','/a','a//b','a/./b','a/../b','C:/a','a\\b','NUL.txt','aux','a.','a ','a\u0000b'])assert.throws(()=>toModelUri('p',path),path);
  const uri=toModelUri('p','a.ts');assert.throws(()=>fromModelUri('other',uri));
  for(const suffix of ['%2e%2e/a','%2Fa','%5Ca','a.ts?x','a.ts#x','a%2ets'])assert.throws(()=>fromModelUri('p',uri.slice(0,uri.lastIndexOf('/')+1)+suffix),suffix);
  assert.equal(fromModelUri('p',toModelUri('p','%2e%2e/a')),'%2e%2e/a');
});
test('CRLF ingress normalizes only paired CRLF, not lone CR/BOM/Unicode',()=>assert.equal(normalizeContent('\ufeffA\r\n😀\rB'),'\ufeffA\n😀\rB'));
