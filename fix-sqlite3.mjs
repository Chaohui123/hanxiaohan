import { createHmac, createHash } from "node:crypto";
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
// Build in background with nohup, wait for completion
console.log("Starting background better-sqlite3 rebuild (expect ~15 min)...");
const cmd = "docker stop onzo-api 2>/dev/null; docker rm -f onzo-api-build 2>/dev/null; docker run -d --name onzo-api-build --entrypoint '' onzo-api-services sh -c 'apk add --no-cache python3 make g++ && cd /app && npm rebuild better-sqlite3 && echo REBUILD_SUCCESS || echo REBUILD_FAILED' 2>&1";
console.log(await exec(cmd));
console.log("Building (will wait up to 15 min)...");
// Wait for container to exit
const result = await exec("while docker ps --format '{{.Names}}' | grep -q onzo-api-build; do sleep 30; done; docker logs onzo-api-build 2>&1 | tail -10");
console.log(result);
console.log("Committing...");
console.log(await exec("docker commit --change='CMD node apps/api-services/dist/index.js' onzo-api-build onzo-api-services:latest 2>&1"));
console.log(await exec("docker rm -f onzo-api-build onzo-api 2>/dev/null; cd /root/onzo && docker compose --env-file .env up -d api-services 2>&1 | tail -3"));
await new Promise(r=>setTimeout(r,50000));
console.log(await exec("docker ps --format '{{.Names}} {{.Status}}' | grep api"));
console.log(await exec("docker logs onzo-api 2>&1 | grep -E 'database|SQLite|DB pool|connected' | tail -3"));
console.log(await exec("curl -s http://localhost:3000/health"));
