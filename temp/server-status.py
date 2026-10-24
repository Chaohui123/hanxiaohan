# One-off: full deployment status probe (read-only, prints no secrets)
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", timeout=20)

def run(cmd, t=60):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 1. docker data-root on vdb? ==")
print(run("df -h /var/lib/docker 2>&1 | tail -1; grep vdb /etc/fstab || grep /var/lib/docker /etc/fstab || echo no-fstab-entry"))
print(run("sudo -n docker info 2>/dev/null | grep -i 'docker root dir' || echo docker-info-failed"))

print("\n== 2. disk usage ==")
print(run("df -h / /var/lib/docker 2>&1"))

print("\n== 3. containers ==")
print(run("sudo -n docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}' | head -20") or "(none)")

print("\n== 4. deploy build log tail ==")
print(run("tail -15 /home/ubuntu/deploy-build.log 2>&1 || echo no-build-log"))

print("\n== 5. repo state ==")
print(run("cd /home/ubuntu/onzo && git log --oneline -1 2>&1; ls .env.production 2>&1"))

print("\n== 6. legacy stack ==")
print(run("sudo -n ls /root/onzo/docker-compose.yml 2>&1 | head -1"))

print("\n== 7. API health (local) ==")
print(run("curl -s -m 8 -o /dev/null -w 'localhost:3000 -> %{http_code}\\n' http://localhost:3000/health 2>&1 || true"))
print(run("sudo -n docker ps --format '{{.Names}}' | grep -E 'api|caddy' || echo no-api-caddy-running"))

print("\n== 8. memory/load ==")
print(run("free -h | head -2; uptime"))

c.close()
