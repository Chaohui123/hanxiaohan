# One-off: final verification — api rebuild status, /ready, sqlite binding, data continuity
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=90):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

print("== api rebuild result ==")
print(run("tail -4 /home/ubuntu/rebuild-api.log"))

print("== containers ==")
print(run("sudo -n docker ps --format '{{.Names}} {{.Status}}'"))

print("== /ready ==")
out = run("curl -s -m 15 http://localhost:3000/ready | head -c 450")
print(out.encode("ascii", errors="replace").decode())

print("== sqlite binding check ==")
out = run("""sudo -n docker exec onzo-api node -e "const db=require('better-sqlite3')(':memory:');db.prepare('SELECT 1').get();console.log('sqlite-binding-OK')" 2>&1 | tail -2""")
print(out.encode("ascii", errors="replace").decode())

print("== data continuity (PG row counts) ==")
out = run("""sudo -n docker exec onzo-postgres psql -U onzo -d onzo_prod -t -c "SELECT 'task_queue:'||COUNT(*) FROM task_queue" -c "SELECT 'failed_tasks:'||COUNT(*) FROM failed_tasks" -c "SELECT 'listing_records:'||COUNT(*) FROM listing_records" -c "SELECT 'local_orders:'||COUNT(*) FROM local_orders" 2>&1 | head -6""")
print(out.encode("ascii", errors="replace").decode())

c.close()
