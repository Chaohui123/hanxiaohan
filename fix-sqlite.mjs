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
  const d=(await call("tat","2020-10-28","RunCommand",{InstanceIds:[INST],CommandType:"SHELL",WorkingDirectory:"/root/onzo",Timeout:600,Content:Buffer.from(cmd).toString("base64")}));
  const invId=d?.Response?.InvocationId||"";
  for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,5000));
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

// Approach: rebuild better-sqlite3 inside a temp container with build tools
console.log("Stopping API...");
console.log(await exec("docker stop onzo-api 2>/dev/null; echo stopped"));

console.log("Creating build container with tools...");
// Use the current image as base, but install build tools and rebuild sqlite
const buildCmd = `docker run -d --name onzo-api-build --entrypoint "" onzo-api-services sh -c "
  apk add --no-cache python3 make g++ && 
  cd /app && 
  npx node-gyp rebuild --directory=node_modules/.pnpm/better-sqlite3*/node_modules/better-sqlite3 2>&1 || 
  npm rebuild better-sqlite3 2>&1 || 
  echo REBUILD_FAILED
"`;
console.log(await exec(buildCmd));
console.log("Waiting for rebuild (3 min)...");
await new Promise(r=>setTimeout(r,180000));
console.log(await exec("docker logs onzo-api-build 2>&1 | tail -10"));

// Commit and restart
console.log(await exec("docker commit --change='CMD node apps/api-services/dist/index.js' onzo-api-build onzo-api-services:latest 2>&1"));
console.log(await exec("docker rm -f onzo-api-build onzo-api 2>/dev/null"));
console.log(await exec("cd /root/onzo && docker compose --env-file .env up -d api-services 2>&1 | tail -3"));
console.log("Waiting for startup...");
await new Promise(r=>setTimeout(r,50000));
console.log(await exec("docker ps --format '{{.Names}} {{.Status}}' | grep api"));
console.log(await exec("docker logs onzo-api 2>&1 | grep -E 'error|Error|DB|database|sqlite|SQLite' | tail -5"));
console.log(await exec("curl -s http://localhost:3000/health"));
console.log(await exec("curl -s http://localhost:3000/ready | head -c 200"));
