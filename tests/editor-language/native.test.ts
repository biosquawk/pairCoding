import test from 'node:test';
import assert from 'node:assert/strict';
import { disableNativeCompletionProviders } from '../../src/services/editor-language/native';
test('all shipped stock providers disabled through public mode config, preserving hover/diagnostics settings',()=>{
  const modes=Array.from({length:9},()=>({modeConfiguration:{completionItems:true,hovers:true,diagnostics:true},calls:0,setModeConfiguration(c:any){this.calls++;this.modeConfiguration=c;}}));
  const monaco:any={typescript:{typescriptDefaults:modes[0],javascriptDefaults:modes[1]},json:{jsonDefaults:modes[2]},css:{cssDefaults:modes[3],lessDefaults:modes[4],scssDefaults:modes[5]},html:{htmlDefaults:modes[6],handlebarDefaults:modes[7],razorDefaults:modes[8]}};
  disableNativeCompletionProviders(monaco);disableNativeCompletionProviders(monaco);
  assert.ok(modes.every(m=>m.calls===1 && m.modeConfiguration.completionItems===false && m.modeConfiguration.hovers && m.modeConfiguration.diagnostics));
});
