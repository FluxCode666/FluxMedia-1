import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';

test('syntax validation compiles without executing administrator code',async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,SCRIPT_RUNTIME_BIND:`:${port}`,SCRIPT_RUNTIME_TOKEN:'test-only'},stdio:'ignore'});
 try {
  const url=`http://127.0.0.1:${port}`;let ready=false;
  for(let i=0;i<100;i++){try{if((await fetch(url+'/healthz')).ok){ready=true;break}}catch{}await delay(50)}
  assert.ok(ready,'runtime starts with its installed QuickJS dependency');
  const invoke=(script,validateOnly)=>fetch(url+'/v1/execute',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer test-only'},body:JSON.stringify({script,validateOnly,operation:'images.generate',stage:'request',input:{},context:{}})});
  const compiled=await invoke('throw new Error("must not execute");',true);assert.equal(compiled.status,200);assert.equal((await compiled.json()).data.output.valid,true);
  const malformed=await invoke('return {',true);assert.ok(malformed.status>=400);
  const executed=await invoke('throw new Error("must not execute");',false);assert.ok(executed.status>=400);
 } finally {child.kill('SIGTERM');await new Promise(r=>child.once('exit',r))}
});
