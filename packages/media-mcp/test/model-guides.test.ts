import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { getModelGuide } from '../src/model-guides.js';
const guide = { version: 1, guide_id: 'ltx-2.5-t2v', model: 'ltx-2.5', mode: 't2v', text: 'Reference prose', sources: ['https://example.org/docs'] };
test('guide preserves payload and uses authenticated exact endpoint without redirects', async () => {
  assert.deepEqual(await getModelGuide({ model: guide.model, mode: guide.mode, baseUrl: 'https://media.example/v1', apiKey: 'credential', fetchImpl: async (url, init) => {
    assert.equal(url, 'https://media.example/v1/models/ltx-2.5/guide?mode=t2v'); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer credential'); return Response.json(guide);
  } }), guide);
});
test('guide rejects unavailable, redirected, oversized and mismatched content', async () => {
  for (const response of [Response.json({}, {status:404}), new Response('', {status:302,headers:{location:'https://evil.example'}}), Response.json({...guide,text:'x'.repeat(16385)}), Response.json({...guide,model:'other'})]) {
    await assert.rejects(getModelGuide({model:guide.model,mode:guide.mode,fetchImpl:async()=>response}));
  }
});

test('guide rejects streamed oversized bodies and credentials in reference content',async()=>{
  await assert.rejects(getModelGuide({model:guide.model,mode:guide.mode,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(16385));controller.close();}}))}));
  await assert.rejects(getModelGuide({model:guide.model,mode:guide.mode,apiKey:'sensitive',fetchImpl:async()=>Response.json({...guide,text:'sensitive'})}),/Credential/);
});
test('configured guide routing uses exact endpoint ID and preserves native payload as reference',async()=>{
  const {registerMediaTools}=await import('../src/server.js');
  const prior=process.env.EASEL_MEDIA_MODELS,priorFetch=globalThis.fetch;
  process.env.EASEL_MEDIA_MODELS=JSON.stringify([{id:'endpoint:minimax-h3',model:'minimax-h3',name:'H3',endpointName:'endpoint',baseUrl:'https://configured.example/v1',apiKey:'route-secret',mediaTypes:['video']}]);
  const payload={...guide,model:'minimax-h3',mode:'base',guide_id:'minimax-h3.base'};
  globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://configured.example/v1/models/minimax-h3/guide?mode=base');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer route-secret');return Response.json(payload);};
  try{
    const tools=new Map<string,any>();registerMediaTools({registerTool(name:string,config:any,handler:any){tools.set(name,{config,handler});}} as any);
    const result=await tools.get('get_model_guide').handler({model:'endpoint:minimax-h3',mode:'base'});
    assert.deepEqual(result.structuredContent,{referenceContent:true,modelId:'endpoint:minimax-h3',guide:payload});
    await assert.rejects(tools.get('get_model_guide').handler({model:'unknown:minimax-h3',mode:'base'}),/enabled Media model/);
  }finally{globalThis.fetch=priorFetch;if(prior===undefined)delete process.env.EASEL_MEDIA_MODELS;else process.env.EASEL_MEDIA_MODELS=prior;}
});
