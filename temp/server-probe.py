# One-off: probe sudo, repo state, env status as ubuntu user (no secret values printed)
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", timeout=15)

def run(cmd, pw=None):
    _, out, err = c.exec_command(cmd, timeout=40)
    if pw:
        out.channel.sendall(pw + "\n")
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    return (o + "\n" + e).strip()

for label, cmd in [
    ("sudo non-interactive", "sudo -n true 2>&1 && echo SUDO_NOPASSWD_OK"),
    ("docker group", "id -nG | tr ' ' '\\n' | grep -x docker || echo 'not in docker group'"),
    ("docker via sudo", "sudo -n docker ps --format '{{.Names}} {{.Status}}' 2>&1 | head -8"),
    ("repo perms", "ls -ld /root /root/onzo 2>&1"),
    ("repo remote", "sudo -n git -C /root/onzo remote -v 2>&1 | head -1"),
    ("repo current commit", "sudo -n git -C /root/onzo log --oneline -1 2>&1"),
    ("github via SSH", "sudo -n timeout 15 git -C /root/onzo ls-remote git@github.com:Chaohui123/hanxiaohan.git HEAD 2>&1 | head -2"),
    ("github via HTTPS", "sudo -n timeout 15 git -C /root/onzo ls-remote https://github.com/Chaohui123/hanxiaohan.git HEAD 2>&1 | head -2"),
    ("env.production exists", "sudo -n ls -la /root/onzo/.env.production /root/onzo/.env 2>&1"),
    ("env key count (7 required)", "sudo -n grep -cE '^(API_KEY|KIMI_API_KEY|GRAFANA_PASSWORD|N8N_ENCRYPTION_KEY|OZON_CLIENT_IDS|OZON_API_KEYS|DEEPSEEK_API_KEY)=' /root/onzo/.env.production 2>&1"),
    ("compose version", "sudo -n docker compose version 2>&1 | head -1"),
    ("ubuntu authorized_keys", "wc -l /home/ubuntu/.ssh/authorized_keys 2>&1 || echo 'none yet'"),
]:
    print(f"--- {label} ---")
    print(run(cmd) or "(empty)")

c.close()
