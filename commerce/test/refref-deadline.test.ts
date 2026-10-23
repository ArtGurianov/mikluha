import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { RefrefClient } from '../src/refref.js';

test('absolute deadline bounds a trickling response body even when the socket stays active',async()=>{
  let bytes=0;
  const server=createServer((_req,res)=>{
    res.writeHead(201,{'content-type':'application/json'});
    res.write(' '); bytes++;
    const timer=setInterval(()=>{res.write(' ');bytes++;},10);
    res.once('close',()=>clearInterval(timer));
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const refref=new RefrefClient({apiBase:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,apiKey:'synthetic',timeoutMs:100,deadlineMs:80});
    const at=Date.now();
    const result=await refref.createAttempt('mk-synthetic',{referralResolutionId:'r',snapshot:{},snapshotHash:'h'},'fixed-key');
    assert.equal(result.kind,'UNKNOWN');
    assert.ok(bytes>=3,'response is actively streaming');
    assert.ok(Date.now()-at<1000,'wall-clock deadline closes the response');
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); }
});
