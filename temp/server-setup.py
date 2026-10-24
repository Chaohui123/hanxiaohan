# One-off: server migration + env completion + CI keypair (secrets never printed)
import os, re, secrets, subprocess, paramiko

HOST, USER = "124.221.11.222", "ubuntu"
REPO = "https://github.com/Chaohui123/hanxiaohan.git"

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect(HOST, username=USER, timeout=20)

def run(cmd, timeout=120):
    _, out, err = c.exec_command(cmd, timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    return (o + ("\n" + e if e else "")).strip()

print("== 1. backup old .env.production ==")
print(run("sudo -n cp /root/onzo/.env.production /home/ubuntu/env.production.bak && sudo -n chown ubuntu:ubuntu /home/ubuntu/env.production.bak && echo backed-up"))

print("== 2. clone repo to /home/ubuntu/onzo ==")
print(run("rm -rf /home/ubuntu/onzo && git clone --depth 50 %s /home/ubuntu/onzo 2>&1 | tail -2" % REPO, timeout=300))

print("== 3. migrate + complete .env.production ==")
run("cp /home/ubuntu/env.production.bak /home/ubuntu/onzo/.env.production")
existing = run("grep -oE '^[A-Z_]+=' /home/ubuntu/onzo/.env.production | tr -d '=' | sort")
keys = set(existing.split())
print("existing keys:", len(keys))

# read KIMI key from local .env (never printed)
local_env = open(".env", encoding="utf-8").read()
kimi = re.search(r"^KIMI_API_KEY=(.+)$", local_env, re.M).group(1).strip()

adds = []
if "API_KEY" not in keys:               adds.append(("API_KEY", secrets.token_hex(32)))
if "KIMI_API_KEY" not in keys:          adds.append(("KIMI_API_KEY", kimi))
if "KIMI_BASE_URL" not in keys:         adds.append(("KIMI_BASE_URL", "https://api.kimi.com/coding/v1"))
if "KIMI_VISION_MODEL" not in keys:     adds.append(("KIMI_VISION_MODEL", "kimi-k3"))
if "GRAFANA_PASSWORD" not in keys:      adds.append(("GRAFANA_PASSWORD", secrets.token_urlsafe(18)))
if "N8N_ENCRYPTION_KEY" not in keys:    adds.append(("N8N_ENCRYPTION_KEY", secrets.token_hex(16)))

for k, v in adds:
    run(f"printf '%s=%s\\n' '{k}' '{v}' >> /home/ubuntu/onzo/.env.production")
print("added keys:", [k for k, _ in adds] or "none")
# keep values for later local handover (API_KEY/GRAFANA needed by user for n8n/grafana login)
handover = {k: v for k, v in adds if k in ("API_KEY", "GRAFANA_PASSWORD", "N8N_ENCRYPTION_KEY")}

print("== 4. ubuntu into docker group ==")
print(run("sudo -n usermod -aG docker ubuntu && id -nG ubuntu | tr ' ' '\\n' | grep -x docker && echo group-added"))

print("== 5. CI keypair ==")
subprocess.run(["ssh-keygen", "-t", "ed25519", "-f", "temp/ci_deploy_key", "-N", "", "-C", "onzo-ci-deploy"], check=True, capture_output=True)
pub = open("temp/ci_deploy_key.pub").read().strip()
priv = open("temp/ci_deploy_key").read()
run("mkdir -p /home/ubuntu/.ssh && chmod 700 /home/ubuntu/.ssh")
sftp = c.open_sftp()
with sftp.file("/home/ubuntu/.ssh/authorized_keys", "a") as f:
    f.write(pub + "\n")
sftp.close()
run("chmod 600 /home/ubuntu/.ssh/authorized_keys")
print("pubkey appended to ubuntu authorized_keys")

print("== 6. GitHub SSH secrets ==")
env = dict(os.environ, GH_TOKEN=subprocess.run(
    ["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
    capture_output=True, text=True).stdout.split("password=")[1].split()[0])
for name, val in [("SSH_HOST", HOST), ("SSH_USER", USER), ("SSH_PRIVATE_KEY", priv)]:
    r = subprocess.run(["gh", "secret", "set", name, "-b", val, "-R", "Chaohui123/hanxiaohan"],
                       capture_output=True, text=True, env=env)
    print(name, "set" if r.returncode == 0 else f"FAILED: {r.stderr[:120]}")

os.remove("temp/ci_deploy_key"); os.remove("temp/ci_deploy_key.pub")
print("local keypair wiped")

print("== 7. verify fetch in new clone ==")
print(run("cd /home/ubuntu/onzo && git log --oneline -1"))

with open("temp/server-handover.txt", "w", encoding="utf-8") as f:
    for k, v in handover.items():
        f.write(f"{k}={v}\n")
print("handover values written to temp/server-handover.txt (local, delete after use)")

c.close()
print("ALL DONE")
