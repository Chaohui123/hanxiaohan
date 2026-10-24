# Quick probe: why is the API 502?
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=60):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== containers ==")
print(run("sudo -n docker ps -a --format '{{.Names}}\\t{{.Status}}' | head -15"))
print("\n== api-services last logs ==")
print(run("sudo -n docker logs --tail 25 onzo-api 2>&1 | tail -25"))
print("\n== caddy last logs ==")
print(run("sudo -n docker logs --tail 8 onzo-caddy 2>&1 | tail -8"))
print("\n== deploy-watch log tail ==")
print(run("tail -12 /home/ubuntu/deploy-watch.log 2>&1"))
print("\n== disk ==")
print(run("df -h / /var/lib/docker 2>&1 | tail -3"))
print("\n== git head on server ==")
print(run("cd /home/ubuntu/onzo && git log --oneline -3"))
c.close()
