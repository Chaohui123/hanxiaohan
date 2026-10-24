# One-off: stop legacy containers, start new stack build in background, report status
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", timeout=20)

def run(cmd, timeout=120):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    return (o + ("\n" + e if e else "")).strip()

print("== legacy compose file present? ==")
print(run("sudo -n ls /root/onzo/docker-compose.yml 2>&1"))

print("== stopping legacy stack (downtime begins) ==")
print(run("cd /root/onzo && sudo -n docker compose down 2>&1 | tail -3 || sudo -n docker stop onzo-api-services onzo-caddy onzo-n8n 2>&1", timeout=180))

print("== containers now ==")
print(run("sudo -n docker ps --format '{{.Names}} {{.Status}}'") or "(none running)")

print("== launching new stack build in background ==")
print(run("cd /home/ubuntu/onzo && sudo -n sh -c 'nohup docker compose --profile production --env-file .env.production up -d --build > /home/ubuntu/deploy-build.log 2>&1 &' && echo launched"))

import time; time.sleep(5)
print("== build log (first lines) ==")
print(run("head -20 /home/ubuntu/deploy-build.log 2>&1"))

c.close()
