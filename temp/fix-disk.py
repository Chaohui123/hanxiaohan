# Fix: /var/lib/docker (vdb 50G) at 100% — prune caches, truncate caddy log, restart caddy.
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=300):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== before ==")
print(run("df -h /var/lib/docker | tail -1"))
print(run("sudo -n du -sh /var/lib/docker/buildkit /var/lib/docker/overlay2 /var/lib/docker/volumes /var/lib/docker/containers 2>/dev/null"))

print("\n== caddy access.log size & truncate ==")
print(run("sudo -n find /var/lib/docker/volumes -name access.log -exec du -sh {} \\; 2>/dev/null"))
print(run("sudo -n find /var/lib/docker/volumes -name access.log -exec truncate -s 0 {} \\; 2>/dev/null && echo truncated"))

print("\n== container json logs >100M ==")
print(run("sudo -n find /var/lib/docker/containers -name '*-json.log' -size +100M -exec du -sh {} \\; 2>/dev/null | head -5"))
print(run("sudo -n find /var/lib/docker/containers -name '*-json.log' -size +100M -exec truncate -s 0 {} \\; 2>/dev/null && echo logs-truncated"))

print("\n== builder prune ==")
print(run("sudo -n docker builder prune -af 2>&1 | tail -2", 600))

print("\n== system prune (no volumes) ==")
print(run("sudo -n docker system prune -af 2>&1 | tail -3", 600))

print("\n== restart caddy ==")
print(run("sudo -n docker restart onzo-caddy && echo caddy-restarted", 120))

print("\n== after ==")
print(run("df -h /var/lib/docker | tail -1"))
c.close()
