# One-off: upload migration script to server, run inside api container, verify counts
import paramiko

c = paramiko.SSHClient()
c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
c.connect("124.221.11.222", username="ubuntu", allow_agent=True, look_for_keys=True, timeout=20)

def run(cmd, t=300):
    _, o, e = c.exec_command(cmd, timeout=t)
    return (o.read().decode(errors="replace") + e.read().decode(errors="replace")).strip()

sftp = c.open_sftp()
sftp.put("temp/migrate-sqlite-to-pg.cjs", "/home/ubuntu/migrate-sqlite-to-pg.cjs")
sftp.close()
print("uploaded")

print("== copy into container & run ==")
out = run("sudo -n docker cp /home/ubuntu/migrate-sqlite-to-pg.cjs onzo-api:/tmp/migrate.cjs && sudo -n docker exec onzo-api node /tmp/migrate.cjs 2>&1 | head -20")
print(out.encode("ascii", errors="replace").decode())

print("== verify PG counts ==")
out = run("""sudo -n docker exec onzo-postgres psql -U onzo -d onzo_prod -t -c "SELECT 'task_queue:'||COUNT(*) FROM task_queue" -c "SELECT 'failed_tasks:'||COUNT(*) FROM failed_tasks" -c "SELECT 'ozon_categories:'||COUNT(*) FROM ozon_categories" -c "SELECT 'sku_1688_mapping:'||COUNT(*) FROM sku_1688_mapping" 2>&1 | head -6""")
print(out.encode("ascii", errors="replace").decode())

run("rm /home/ubuntu/migrate-sqlite-to-pg.cjs && sudo -n docker exec onzo-api rm /tmp/migrate.cjs")
print("temp scripts cleaned")

c.close()
