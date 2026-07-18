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
// Step 1: Install build tools on the host first (fast)
console.log("Installing gcc on host...");
console.log(await exec("apk add --no-cache gcc g++ make python3-dev 2>&1 | tail -2 || apt-get install -y build-essential python3 2>&1 | tail -2 || echo 'using existing tools'"));

// Step 2: Rebuild better-sqlite3 directly on host (which has working build tools)
console.log("Rebuilding better-sqlite3 on host...");
console.log(await exec("cd /root/onzo && rm -f node_modules/.pnpm/better-sqlite3*/node_modules/better-sqlite3/build/Release/better_sqlite3.node 2>/dev/null; npx node-gyp rebuild --directory=node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 2>&1 | tail -5 || npm rebuild better-sqlite3 2>&1 | tail -5"));
// Check if host version works
console.log(await exec("node -e \"require('better-sqlite3')\" 2>&1 && echo HOST_SQLITE_OK || echo HOST_SQLITE_FAIL"));

// Step 3: Copy HOST node-gyp compiled version into container (host is Ubuntu, container is Alpine - won't work)
// Alternative: rebuild inside container by connecting interactively
console.log("Trying interactive rebuild in container...");
console.log(await exec("docker exec onzo-api sh -c 'apk add --no-cache gcc g++ make python3-dev 2>&1 | tail -1'"));
console.log(await exec("docker exec onzo-api sh -c 'cd /app && npm rebuild better-sqlite3 2>&1 | tail -5'"));
// Restart container
console.log(await exec("docker restart onzo-api 2>&1"));
await new Promise(r=>setTimeout(r,30000));
console.log(await exec("docker logs onzo-api 2>&1 | grep -E 'SQLite|DB|connected' | tail -3"));
console.log(await exec("curl -s http://localhost:3000/health"));
