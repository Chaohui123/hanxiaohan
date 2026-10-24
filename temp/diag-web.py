# One-off: diagnose onzo-web-dashboard restart loop
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=60):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== web-dashboard logs (last 40) ==")
print(run("sudo -n docker logs onzo-web-dashboard --tail 40 2>&1"))

print("\n== container inspect: exit code / restart count ==")
print(run("sudo -n docker inspect onzo-web-dashboard --format 'ExitCode={{.State.ExitCode}} Restarts={{.RestartCount}} Error={{.State.Error}}'"))

print("\n== compose service definition ==")
print(run("cd /home/ubuntu/onzo && grep -A 25 'web-dashboard:' docker-compose.yml | head -30"))

print("\n== whats eating / (top dirs) ==")
print(run("sudo -n du -xh -d1 / 2>/dev/null | sort -rh | head -10", t=120))

c.close()
