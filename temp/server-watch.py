# One-off: poll server build log until done/fail (max ~45 min)
import time, paramiko

HOST, USER = "124.221.11.222", "ubuntu"

def poll_once():
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    c.connect(HOST, username=USER, timeout=20)
    _, out, _ = c.exec_command("tail -5 /home/ubuntu/deploy-build.log; echo '---PS---'; sudo -n docker ps --format '{{.Names}} {{.Status}}'", timeout=30)
    txt = out.read().decode(errors="replace").strip()
    c.close()
    return txt

start = time.time()
last = ""
while time.time() - start < 2700:
    try:
        txt = poll_once()
    except Exception as e:
        txt = f"(poll error: {e})"
    elapsed = int(time.time() - start)
    print(f"\n===== [{elapsed}s] =====")
    print(txt)
    low = txt.lower()
    if "error" in low and "level=error" in low:
        print("BUILD ERROR DETECTED"); break
    if "onzo-api" in txt and ("healthy" in txt or "running" in txt.lower()):
        print("API CONTAINER UP"); break
    if txt == last:
        pass
    last = txt
    time.sleep(60)

print("\nPOLL END")
