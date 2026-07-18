import { createHmac, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const ID="***REMOVED***",KEY="***REMOVED***",R="ap-shanghai",INST="lhins-d76pb230";
const s=d=>createHash("sha256").update(d).digest("hex");const h=(k,d)=>createHmac("sha256",k).update(d).digest();
async function call(svc,ver,action,params){
  const ep=svc+".tencentcloudapi.com",ts=Math.floor(Date.now()/1000);
  const date=new Date(ts*1000).toISOString().slice(0,10),payload=JSON.stringify(params);
  const ch="content-type:application/json; charset=utf-8\nhost:"+ep+"\nx-tc-action:"+action.toLowerCase()+"\n";
  const sh="content-type;host;x-tc-action";const cr="POST\n/\n\n"+ch+"\n"+sh+"\n"+s(payload);
  const cs=date+"/"+svc+"/tc3_request";const sts="TC3-HMAC-SHA256\n"+ts+"\n"+cs+"\n"+s(cr);
  const kd=h("TC3"+KEY,date),ks=h(kd,svc),ksg=h(ks,"tc3_request");
  const sig=createHmac("sha256",ksg).update(sts).digest("hex");
  const auth="TC3-HMAC-SHA256 Credential="+ID+"/"+cs+", SignedHeaders="+sh+", Signature="+sig;
  return (await fetch("https://"+ep,{method:"POST",headers:{"Content-Type":"application/json; charset=utf-8","Host":ep,"X-TC-Action":action,"X-TC-Version":ver,"X-TC-Timestamp":String(ts),"X-TC-Region":R,"Authorization":auth},body:payload})).json();
}
async function exec(cmd){
  const d=(await call("tat","2020-10-28","RunCommand",{InstanceIds:[INST],CommandType:"SHELL",WorkingDirectory:"/root/onzo",Timeout:300,Content:Buffer.from(cmd).toString("base64")}));
  const invId=d?.Response?.InvocationId||"";
  for(let i=0;i<12;i++){await new Promise(r=>setTimeout(r,4000));
    const dd=await call("tat","2020-10-28","DescribeInvocations",{InvocationIds:[invId]});
    const inv=dd?.Response?.InvocationSet?.[0];
    if(inv?.InvocationStatus==="SUCCESS"||inv?.InvocationStatus==="FAILED"){
      const tid=inv.InvocationTaskBasicInfoSet?.[0]?.InvocationTaskId;
      if(!tid) return inv.InvocationStatus;
      const td=await call("tat","2020-10-28","DescribeInvocationTasks",{InvocationTaskIds:[tid]});
      const t=td?.Response?.InvocationTaskSet?.[0];
      if(t?.TaskResult?.Output) return Buffer.from(t.TaskResult.Output,"base64").toString("utf-8");
      return t?.TaskStatus||inv.InvocationStatus;
    }
  }
  return "Timeout";
}
const content=readFileSync("apps/api-services/src/middleware/rag-rate-limit.ts");
const b64=content.toString("base64");
const CHUNK=6000;const parts=Math.ceil(b64.length/CHUNK);
await exec("> /tmp/rrl3.b64");
for(let i=0;i<parts;i++){
  const chunk=b64.slice(i*CHUNK,(i+1)*CHUNK);
  const safe=chunk.replace(/'/g,"'\''");
  await exec("python3 -c \"open('/tmp/rrl3.b64','a').write('"+safe+"')\"");
}
console.log("Decoding...");
console.log(await exec("base64 -d /tmp/rrl3.b64 > /root/onzo/apps/api-services/src/middleware/rag-rate-limit.ts && rm /tmp/rrl3.b64 && wc -c /root/onzo/apps/api-services/src/middleware/rag-rate-limit.ts"));
// Copy as JS
console.log(await exec("cp /root/onzo/apps/api-services/src/middleware/rag-rate-limit.ts /root/onzo/apps/api-services/dist/middleware/rag-rate-limit.js && wc -c /root/onzo/apps/api-services/dist/middleware/rag-rate-limit.js"));
// Rebuild container
console.log(await exec("docker rm -f onzo-api onzo-api-tmp 2>/dev/null"));
console.log(await exec("docker run -d --name onzo-api-tmp --entrypoint '' onzo-api-services tail -f /dev/null 2>&1"));
console.log(await exec("docker cp /root/onzo/apps/api-services/dist/. onzo-api-tmp:/app/apps/api-services/dist/ 2>&1"));
console.log(await exec("for d in /root/onzo/packages/*/dist; do pkg=$(basename $(dirname $d)); docker cp $d/. onzo-api-tmp:/app/packages/$pkg/dist/ 2>/dev/null; done && echo PKGS_OK"));
console.log(await exec("docker commit --change='CMD node apps/api-services/dist/index.js' onzo-api-tmp onzo-api-services:latest 2>&1"));
console.log(await exec("docker rm -f onzo-api-tmp"));
console.log(await exec("cd /root/onzo && docker compose --env-file .env up -d api-services 2>&1 | tail -3"));
console.log("Waiting 50s...");
await new Promise(r=>setTimeout(r,50000));
console.log(await exec("docker ps --format '{{.Names}} {{.Status}}' | grep api"));
console.log(await exec("docker logs onzo-api 2>&1 | tail -5"));
console.log(await exec("curl -s http://localhost:3000/health"));
