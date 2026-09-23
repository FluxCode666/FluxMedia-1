import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import net from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {registerRuntimeShutdown,resolveListenTarget,shutdownRuntime} from './server.mjs';

test('listen configuration combines SCRIPT_RUNTIME_HOST with the bind port',()=>{
 assert.deepEqual(resolveListenTarget({SCRIPT_RUNTIME_BIND:':8090',SCRIPT_RUNTIME_HOST:'127.0.0.1'}),{options:{port:8090,host:'127.0.0.1'},display:'127.0.0.1:8090'});
 assert.deepEqual(resolveListenTarget({SCRIPT_RUNTIME_BIND:':8090'}),{options:{port:8090},display:':8090'});
});

test('shutdown waits for HTTP close before closing the worker pool',async()=>{
 const order=[];
 const server={close(callback){order.push('close-start');queueMicrotask(()=>{order.push('close-finished');callback()})}};
 const pool={async close(){order.push('pool-close');}};
 await shutdownRuntime(server,pool);
 assert.deepEqual(order,['close-start','close-finished','pool-close']);
});

test('shutdown releases the worker pool and reports HTTP close errors',async()=>{
 let poolClosed=false;
 const failure=new Error('listener close failed');
 const server={close(callback){callback(failure)}};
 const pool={async close(){poolClosed=true;}};
 await assert.rejects(shutdownRuntime(server,pool),failure);
 assert.equal(poolClosed,true);
});

test('registered shutdown signals are idempotent and set failure exit code',async()=>{
 const signalSource=new EventEmitter();let closeCalls=0,exitCode=0,logs=0;
 const server={close(callback){closeCalls++;callback(new Error('close failed'))}};
 const shutdown=registerRuntimeShutdown(server,{async close(){}},{signalSource,logger:{error(){logs++;}},setExitCode(code){exitCode=code;}});
 signalSource.emit('SIGTERM');signalSource.emit('SIGINT');await shutdown();
 assert.equal(closeCalls,1);assert.equal(exitCode,1);assert.equal(logs,1);
});

test('syntax validation compiles without executing administrator code',async()=>{
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,SCRIPT_RUNTIME_BIND:`:${port}`,SCRIPT_RUNTIME_HOST:'127.0.0.1',SCRIPT_RUNTIME_TOKEN:'test-only'},stdio:'ignore'});
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
