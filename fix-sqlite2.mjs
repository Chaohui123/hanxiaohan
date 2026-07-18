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
// Find host's better-sqlite3 .node file
console.log("Finding host better-sqlite3...");
console.log(await exec("find /root/onzo/node_modules -name 'better_sqlite3.node' -type f 2>/dev/null | head -3"));
// Copy it into container
console.log(await exec("docker stop onzo-api 2>/dev/null; docker rm -f onzo-api-tmp 2>/dev/null; echo cleaned"));
console.log(await exec("docker run -d --name onzo-api-tmp --entrypoint '' onzo-api-services tail -f /dev/null 2>&1"));
// Copy the host's entire better-sqlite3 build directory
console.log(await exec("NODE_PATH=$(find /root/onzo/node_modules/.pnpm -name 'better-sqlite3' -type d -maxdepth 3 | head -1) && echo \"Host path: $NODE_PATH\" && docker cp $NODE_PATH/. onzo-api-tmp:/app/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3/ 2>&1 && echo SQLITE_COPIED || echo SQLITE_COPY_FAILED"));
// Copy all better-sqlite3 instances
console.log(await exec("for d in $(find /root/onzo/node_modules/.pnpm -maxdepth 4 -name 'better-sqlite3' -type d 2>/dev/null); do target=$(echo $d | sed 's|/root/onzo||'); docker exec onzo-api-tmp mkdir -p $(dirname $target) 2>/dev/null; docker cp $d/. onzo-api-tmp:$target/ 2>/dev/null; done && echo ALL_SQLITE_OK"));
// Also try pnpm rebuild inside container
console.log(await exec("docker exec onzo-api-tmp sh -c 'apk add --no-cache python3 make g++ 2>&1 | tail -1 && cd /app && pnpm rebuild better-sqlite3 2>&1 | tail -5'"));
// Commit
console.log(await exec("docker commit --change='CMD node apps/api-services/dist/index.js' onzo-api-tmp onzo-api-services:latest 2>&1"));
console.log(await exec("docker rm -f onzo-api-tmp onzo-api 2>/dev/null"));
console.log(await exec("cd /root/onzo && docker compose --env-file .env up -d api-services 2>&1 | tail -3"));
await new Promise(r=>setTimeout(r,50000));
console.log(await exec("docker ps --format '{{.Names}} {{.Status}}' | grep api"));
console.log(await exec("docker logs onzo-api 2>&1 | grep -E 'database|SQLite|DB pool|connected' | tail -5"));
console.log(await exec("curl -s http://localhost:3000/health"));
