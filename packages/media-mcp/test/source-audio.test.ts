import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { generateVideo } from '../src/video.js';
import { capabilities } from './fixtures/video-contract.js';
const audio = {data: Buffer.from('RIFF0000WAVE').toString('base64'),mimeType:'audio/wav'};
test('source audio requires exact current availability and submits one independent multipart upload', async () => {
  const calls: string[]=[];
  await generateVideo({model:'ltx-2.5',prompt:'motion',sourceAudio:audio,fetchImpl:async(url,init)=>{
    calls.push(String(url)); if (init?.method==='GET') return Response.json({...capabilities,source_audio:{supported:true,available:true}});
    const form=init?.body as FormData; assert.equal(form.getAll('source_audio').length,1); assert.equal((form.get('source_audio') as File).type,'audio/wav'); return Response.json({id:'a'.repeat(32),status:'queued'});
  }} as any); assert.equal(calls.length,2);
});
test('older unavailable or wrong-model capabilities block only supplied audio before POST', async()=>{
  for(const extra of [{},{source_audio:{supported:true,available:false}},{model:'other',source_audio:{supported:true,available:true}}]) await assert.rejects(generateVideo({model:'ltx-2.5',prompt:'motion',sourceAudio:audio,fetchImpl:async(_url,init)=>{assert.equal(init?.method,'GET');return Response.json({...capabilities,...extra});}} as any));
});
test('null audio is omitted with no discovery and wrong MIME fails locally',async()=>{
  await generateVideo({model:'ltx-2.5',prompt:'motion',sourceAudio:null,fetchImpl:async(_url,init)=>{assert.equal(init?.method,'POST');assert.equal((init?.body as FormData).has('source_audio'),false);return Response.json({id:'a'.repeat(32),status:'queued'});}} as any);
  await assert.rejects(generateVideo({model:'ltx-2.5',prompt:'motion',sourceAudio:{...audio,mimeType:'image/png'},fetchImpl:async()=>assert.fail('no request')} as any));
});

test('audio and image have independent 32 MiB bounds; oversize audio fails before discovery',async()=>{
  const {decodeSourceAudio,MAX_SOURCE_AUDIO_BYTES}=await import('../src/source-audio-upload.js');
  const full=Buffer.alloc(MAX_SOURCE_AUDIO_BYTES).toString('base64');assert.equal(decodeSourceAudio({...audio,data:full}).bytes.length,MAX_SOURCE_AUDIO_BYTES);
  assert.throws(()=>decodeSourceAudio({...audio,data:Buffer.alloc(MAX_SOURCE_AUDIO_BYTES+1).toString('base64')}));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const imageBytes=Buffer.alloc(MAX_SOURCE_AUDIO_BYTES);png.copy(imageBytes);
  await generateVideo({model:'ltx-2.5',prompt:'motion',sourceAudio:{...audio,data:full},inputReference:{data:imageBytes.toString('base64'),mimeType:'image/png'},fetchImpl:async(_url,init)=>{
    if(init?.method==='GET')return Response.json({...capabilities,source_audio:{supported:true,available:true}});
    const form=init?.body as FormData;assert.equal((form.get('source_audio') as File).size,MAX_SOURCE_AUDIO_BYTES);assert.equal((form.get('input_reference') as File).size,MAX_SOURCE_AUDIO_BYTES);return Response.json({id:'a'.repeat(32),status:'queued'});
  }});
});

test('H3 first-image/audio sends frames124 and no seconds with exact H3 discovery',async()=>{
  const h3={object:'video.capabilities',schema_version:1,model:'minimax-h3',fps:24,frames:{min:124,max:362,default:124,step:17,offset:5},sizes:['768x512'],default_size:'768x512',seed:{min:'0',max:'18446744073709551615',encoding:'decimal_string'},profiles:{ia2v:{supported:true,available:true,validation:'graph_contract_tested',gpu_executed:false,visually_reviewed:false}},semantic_references:{max_count:2,fields:['semantic_references']},temporal_groups:{max_count:3,image_counts:[1,5,22,39],fields:['temporal_groups']},uploads:{field:'images',mime_types:['image/png','image/jpeg'],max_total_bytes:33554432,max_total_pixels:32000000,max_image_pixels:32000000,max_count:119},unsupported:[],source_audio:{supported:true,available:true}};
  await generateVideo({model:'minimax-h3',prompt:'speaking with closed lips during pauses',frames:124,size:'768x512',sourceAudio:audio,inputReference:{data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',mimeType:'image/png'},fetchImpl:async(url,init)=>{
    if(init?.method==='GET'){assert.ok(String(url).endsWith('/v1/videos/capabilities?model=minimax-h3'));return Response.json(h3);}
    const form=init?.body as FormData;assert.equal(form.get('frames'),'124');assert.equal(form.has('seconds'),false);assert.equal(form.getAll('source_audio').length,1);assert.equal(form.getAll('input_reference').length,1);return Response.json({id:'a'.repeat(32),status:'queued'});
  }});
});
