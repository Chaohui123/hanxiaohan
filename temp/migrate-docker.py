# One-off: migrate /var/lib/docker to the new 50G disk (/dev/vdb) with fstab persistence
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=600):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 0. vdb current contents ==")
print(run("ls -la /root/data/disk/ | head -8"))

print("== 1. rsync present? ==")
print(run("command -v rsync || (sudo -n apt-get install -y rsync 2>&1 | tail -1)"))

print("== 2. stop docker (downtime) ==")
print(run("sudo -n systemctl stop docker docker.socket containerd 2>&1; sleep 3; sudo -n docker ps 2>&1 | head -2 || echo docker-stopped", t=120))

print("== 3. rsync /var/lib/docker -> vdb ==")
print(run("sudo -n rsync -aHAX --info=progress2 /var/lib/docker/ /root/data/disk/ 2>&1 | tail -2", t=900))
print(run("sudo -n du -sh /root/data/disk/ && sudo -n ls /root/data/disk/ | head -6"))

print("== 4. remount vdb to /var/lib/docker ==")
print(run("sudo -n umount /root/data/disk && sudo -n mount /dev/vdb /var/lib/docker && df -h /var/lib/docker | tail -1"))

print("== 5. fstab persistence ==")
print(run("""grep -q '/var/lib/docker' /etc/fstab || echo 'UUID=47e6c361-6d82-42e0-881c-bdca05769152 /var/lib/docker ext4 defaults 0 2' | sudo -n tee -a /etc/fstab; tail -2 /etc/fstab"""))

print("== 6. start docker ==")
print(run("sudo -n systemctl start containerd docker 2>&1; sleep 8; sudo -n docker ps -a --format '{{.Names}} {{.Status}}' | head -10", t=180))

print("== 7. verify images/volumes survived ==")
print(run("sudo -n docker images --format '{{.Repository}}:{{.Tag}}' | head -5; sudo -n docker volume ls | head -4"))

c.close()
