# One-off: rebuild web-dashboard with fixed nginx.conf and verify the whole stack
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=900):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 1. confirm repo has fixed nginx.conf ==")
print(run("cd /home/ubuntu/onzo && git log --oneline -1 && head -3 apps/web-dashboard/nginx.conf"))

print("\n== 2. rebuild web-dashboard ==")
print(run("cd /home/ubuntu/onzo && sudo -n docker compose --profile production --env-file .env.production up -d --build web-dashboard 2>&1 | tail -6", t=1500))

print("\n== 3. container status ==")
print(run("sleep 5; sudo -n docker ps -a --format '{{.Names}}\\t{{.Status}}' | head -10"))

print("\n== 4. web-dashboard nginx config inside container ==")
print(run("sudo -n docker exec onzo-web-dashboard head -5 /etc/nginx/conf.d/default.conf 2>&1"))

print("\n== 5. local curls ==")
print(run("curl -s -m 8 -o /dev/null -w 'web :8080 -> %{http_code}\\n' http://localhost:8080/ 2>&1"))
print(run("curl -s -m 8 -o /dev/null -w 'api :3000 -> %{http_code}\\n' http://localhost:3000/health 2>&1"))
print(run("curl -s -m 8 -o /dev/null -w 'web->api proxy -> %{http_code}\\n' http://localhost:8080/api/health 2>&1 || true"))

print("\n== 6. disk after ==")
print(run("df -h / /var/lib/docker | tail -2"))

c.close()
