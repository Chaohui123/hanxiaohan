# One-off: verify where docker data actually lives + /var usage breakdown
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=90):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== /var/lib/docker top-level (via mount path => vdb) ==")
print(run("sudo -n ls -la /var/lib/docker/ | head -15"))
print(run("sudo -n du -xh -d1 /var/lib/docker 2>/dev/null | sort -rh | head -8", t=120))

print("\n== docker images on disk ==")
print(run("sudo -n docker images --format '{{.Repository}}:{{.Tag}} {{.Size}}' | head -12"))
print(run("sudo -n docker system df 2>&1"))

print("\n== which device holds a running container's layer ==")
print(run("sudo -n docker inspect onzo-api --format '{{.GraphDriver.Data.MergedDir}}'"))

print("\n== /var breakdown (vda2, -x stays on root fs) ==")
print(run("sudo -n du -xh -d1 /var 2>/dev/null | sort -rh | head -8", t=120))
print(run("sudo -n du -xh -d1 /var/lib 2>/dev/null | sort -rh | head -8", t=120))

print("\n== journal / log sizes ==")
print(run("sudo -n journalctl --disk-usage 2>&1; sudo -n du -sh /var/log 2>/dev/null"))

c.close()
