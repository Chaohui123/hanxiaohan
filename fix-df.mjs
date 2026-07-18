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
  const d=(await call("tat","2020-10-28","RunCommand",{InstanceIds:[INST],CommandType:"SHELL",WorkingDirectory:"/root/onzo",Timeout:900,Content:Buffer.from(cmd).toString("base64")}));
  const invId=d?.Response?.InvocationId||"";
  for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,5000));
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
    process.stdout.write(".");
  }
  return "Timeout";
}
// Upload .dockerignore
const data=readFileSync(".dockerignore");const b64=data.toString("base64");
const C=6000;const parts=Math.ceil(b64.length/C);
await exec("> /tmp/di.b64");
for(let i=0;i<parts;i++){const c=b64.slice(i*C,(i+1)*C);const safe=c.replace(/'/g,"'\''");await exec("python3 -c \"open('/tmp/di.b64','a').write('"+safe+"')\"")};
console.log(await exec("base64 -d /tmp/di.b64 > /root/onzo/.dockerignore && rm /tmp/di.b64 && grep scripts /root/onzo/.dockerignore || echo 'scripts excluded from dockerignore: CLEAN'"));

// Rebuild
const result = await exec("cd /root/onzo && docker compose --env-file .env up -d --build api-services 2>&1 | tail -3");
console.log(result);
