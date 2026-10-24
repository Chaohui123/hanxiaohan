# One-off: prune build cache, then migrate /var/lib/containerd onto vdb via bind-mount (fstab-persistent)
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=900):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 0. before ==")
print(run("df -h / /var/lib/docker | tail -2"))

print("\n== 1. prune build cache + dangling images (online) ==")
print(run("sudo -n docker builder prune -af 2>&1 | tail -2", t=600))
print(run("sudo -n docker image prune -f 2>&1 | tail -1"))
print(run("sudo -n du -sh /var/lib/containerd 2>/dev/null", t=300))

print("\n== 2. stop docker + containerd (downtime begins) ==")
print(run("sudo -n systemctl stop docker docker.socket containerd 2>&1; sleep 3; echo stopped", t=120))

print("\n== 3. rsync containerd -> vdb ==")
print(run("sudo -n mkdir -p /var/lib/docker/containerd-data && sudo -n rsync -aHAX -x /var/lib/containerd/ /var/lib/docker/containerd-data/ 2>&1 | tail -3; echo rsync-done", t=1800))
print(run("sudo -n du -sh /var/lib/docker/containerd-data", t=300))

print("\n== 4. swap old dir, bind-mount ==")
print(run("sudo -n mv /var/lib/containerd /var/lib/containerd.old && sudo -n mkdir -p /var/lib/containerd && sudo -n mount --bind /var/lib/docker/containerd-data /var/lib/containerd && echo bind-mounted"))
print(run("grep -q 'containerd-data' /etc/fstab || echo '/var/lib/docker/containerd-data /var/lib/containerd none bind 0 0' | sudo -n tee -a /etc/fstab; tail -2 /etc/fstab"))

print("\n== 5. start docker ==")
print(run("sudo -n systemctl start containerd docker 2>&1; sleep 10; sudo -n docker ps --format '{{.Names}} {{.Status}}' | head -10", t=180))

print("\n== 6. verify images survived ==")
print(run("sudo -n docker images --format '{{.Repository}}:{{.Tag}}' | head -10"))

print("\n== 7. after (containerd.old still on vda2, pending deletion) ==")
print(run("df -h / /var/lib/docker | tail -2"))

c.close()
