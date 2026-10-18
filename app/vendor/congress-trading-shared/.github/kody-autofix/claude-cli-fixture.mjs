import assert from 'node:assert/strict';
import {generate, MODEL, scanDirectory, attemptRef} from './fleet.mjs';
import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir = await mkdtemp(join(tmpdir(), 'kody-cli-fixture-'));
const outputPath = join(dir, 'answer.json');
// This fixture never reads a real provider credential.  All upstream requests are
// intercepted in memory; the placeholder is deliberately not an API key.
let calls=0; const budgetRows = new Map();
const data={repository:'Simple-With-Us/example',repositoryId:'1',number:1,head:'a'.repeat(40),profile:'web',prefixes:['server/'],findings:[{path:'server/a.ts',line:1,body:'Change n to 2.'}],files:[{path:'server/a.ts',content:'const n = 1;\n'}]};
const now=Date.now(), day=new Date(now).toISOString().slice(0,10);
const env={SWU_KODY_FLEET_BUDGET_ENABLED:'true',FLEET_BUDGET_URL:'https://usage.jays.services/api/ingest/fleet-budget',FLEET_BUDGET_TOKEN:'synthetic-offline-budget-token-only',PATH:process.env.PATH,DEEPSEEK_API_KEY:'synthetic-local-only',DAILY_ATTEMPT_LIMIT:'1',BUDGET_POLICY_ID:'approved-fixture',GITHUB_RUN_ID:'1'};
const reservation={result:'reserved',repository:data.repository,repositoryId:data.repositoryId,number:1,head:data.head,runId:'1',day,expiresAt:now+15*60_000,attemptRef:attemptRef(data),slotRef:`tags/swu-kody-budget/v1/${day}/1`,policyId:env.BUDGET_POLICY_ID,snapshotDigest:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
try {
await writeFile(join(dir,'snapshot.json'),JSON.stringify(data));
const receipt=await scanDirectory(dir);
await generate(data,outputPath,env,reservation,receipt,async(url,options)=>{
  const request=JSON.parse(options.body);
  if(url===env.FLEET_BUDGET_URL){
    let row=budgetRows.get(request.requestId), dispatchAllowed=false;
    if(request.action==='reserve'){
      row??={reservationId:`fixture-${budgetRows.size}`,requestId:request.requestId,provider:'deepseek',model:MODEL,
        day:new Date().toISOString().slice(0,10),status:'reserved',maximumCostMicros:'319488',dispatchBefore:new Date(Date.now()+60_000).toISOString()};
      budgetRows.set(request.requestId,row);
    }else if(request.action==='dispatch'){
      assert.equal(row.status,'reserved');row.status='dispatched';dispatchAllowed=true;
    }else if(request.action==='reconcile')row.status=request.usage===null?'uncertain':'settled';
    else if(request.action==='cancel')row.status='cancelled';
    else assert.fail('Unexpected budget command.');
    return new Response(JSON.stringify({ok:true,...row,dispatchAllowed}),{headers:{'x-api-version':'1',date:new Date().toUTCString()}});
  }
  calls++;
  assert.equal(url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.model, MODEL);
  assert.deepEqual((request.tools ?? []).map(tool => tool.name), ['StructuredOutput']);
  console.log('Mock request',calls,'model',request.model,'tools',(request.tools??[]).map(t=>t.name),'stream',request.stream);
  const output={id:'msg_fixture',type:'message',role:'assistant',model:MODEL,content:[{type:'tool_use',id:'toolu_fixture',name:'StructuredOutput',input:{edits:[{path:'server/a.ts',old_text:'const n = 1;',new_text:'const n = 2;'}]}}],stop_reason:'tool_use',stop_sequence:null,usage:{input_tokens:100,output_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0}};
  if(!request.stream)return new Response(JSON.stringify(output),{headers:{'content-type':'application/json'}});
  const events=[['message_start',{type:'message_start',message:{...output,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'tool_use',id:'toolu_fixture',name:'StructuredOutput',input:{}}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'input_json_delta',partial_json:JSON.stringify(output.content[0].input)}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:100}}],
    ['message_stop',{type:'message_stop'}]];
  return new Response(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
});
assert.deepEqual(JSON.parse(await readFile(outputPath,'utf8')), {edits:[{path:'server/a.ts',old_text:'const n = 1;',new_text:'const n = 2;'}]});
console.log('PASS: pinned real CLI accepted the synthetic schema result in',calls,'request(s).');

} finally { await rm(dir, {recursive:true, force:true}); }
