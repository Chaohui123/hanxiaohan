# One-off: push image to COS via api endpoint, then re-run listing smoke with COS URL
import json, re, paramiko

API_KEY = [l.split("=", 1)[1].strip() for l in open("temp/server-handover.txt", encoding="utf-8") if l.startswith("API_KEY=")][0]

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=180):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== 1. upload to COS via /api/images/upload ==")
body = json.dumps({"filePath": "/app/data/images/ae70946f-26d7-46d9-a0a0-3ac19d6bf724.jpg", "productId": "smoke-test"})
run(f"echo '{body}' > /home/ubuntu/cos-body.json")
out = run(f"""curl -s -m 90 -X POST http://localhost:3000/api/images/upload \
  -H "X-API-Key: {API_KEY}" -H "Content-Type: application/json" -d @/home/ubuntu/cos-body.json | head -c 500""")
print(out.encode("ascii", errors="replace").decode())

m = re.search(r'"(?:url|cosUrl)":\s*"([^"]+)"', out)
if not m:
    print("COS UPLOAD FAILED — abort"); raise SystemExit(1)
cos_url = m.group(1)
print("COS URL:", cos_url)

print("\n== 2. COS URL reachable? (server side) ==")
print(run(f'curl -s -o /dev/null -w "http=%{{http_code}} size=%{{size_download}} time=%{{time_total}}s" -m 30 "{cos_url}"'))

print("\n== 3. re-run /api/process/manual with COS URL ==")
body2 = json.dumps({
    "title": "车载真空吸盘手机支架 强磁稳固款",
    "priceCny": 25,
    "specImages": [cos_url],
    "specifications": [{"name": "颜色", "value": "黑色"}, {"name": "安装方式", "value": "真空吸盘"}],
})
run(f"echo '{body2}' > /home/ubuntu/smoke-body2.json")
out = run(f"""curl -s -m 300 -X POST http://localhost:3000/api/process/manual \
  -H "X-API-Key: {API_KEY}" -H "Content-Type: application/json" -d @/home/ubuntu/smoke-body2.json | head -c 800""")
print(out.encode("ascii", errors="replace").decode())

run("rm -f /home/ubuntu/cos-body.json /home/ubuntu/smoke-body2.json")
c.close()
