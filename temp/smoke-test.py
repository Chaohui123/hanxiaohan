# One-off: real listing smoke test — upload image, POST /api/process/manual, poll result
import json, time, re, paramiko

API_KEY = [l.split("=", 1)[1].strip() for l in open("temp/server-handover.txt", encoding="utf-8") if l.startswith("API_KEY=")][0]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=120):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 1. upload test image ==")
sftp = c.open_sftp()
sftp.put("data/tmp-images/main2.jpg", "/home/ubuntu/smoke-main.jpg")
sftp.close()
out = run(f"""curl -s -m 60 -X POST http://localhost:3000/api/image/upload \
  -H "X-API-Key: {API_KEY}" -F "file=@/home/ubuntu/smoke-main.jpg" | head -c 400""")
print(out.encode("ascii", errors="replace").decode())

m = re.search(r'"(?:url|imageUrl|path)":\s*"([^"]+)"', out)
if not m:
    print("UPLOAD FAILED — abort"); raise SystemExit(1)
img_url = m.group(1)
if img_url.startswith("/"):
    img_url = "http://localhost:3000" + img_url
print("image URL:", img_url)

print("\n== 2. POST /api/process/manual ==")
body = json.dumps({
    "title": "车载真空吸盘手机支架 强磁稳固款",
    "priceCny": 25,
    "specImages": [img_url],
    "specifications": [{"name": "颜色", "value": "黑色"}, {"name": "安装方式", "value": "真空吸盘"}],
})
run(f"echo '{body}' > /home/ubuntu/smoke-body.json")
out = run(f"""curl -s -m 120 -X POST http://localhost:3000/api/process/manual \
  -H "X-API-Key: {API_KEY}" -H "Content-Type: application/json" \
  -d @/home/ubuntu/smoke-body.json | head -c 600""")
print(out.encode("ascii", errors="replace").decode())

run("rm -f /home/ubuntu/smoke-main.jpg /home/ubuntu/smoke-body.json")
c.close()
