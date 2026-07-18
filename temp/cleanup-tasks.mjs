import Database from 'better-sqlite3';
const db = new Database('/app/data/onzo.db');
db.pragma('journal_mode = WAL');

db.exec(`DELETE FROM task_queue WHERE status IN ('failed','pending_retry')`);
db.exec(`DELETE FROM failed_tasks`);

const q = db.prepare('SELECT COUNT(*) as c FROM task_queue').get();
console.log('Task queue:', q.c);

const f = db.prepare('SELECT COUNT(*) as c FROM failed_tasks').get();
console.log('Failed tasks:', f.c);

db.close();
console.log('Cleanup done');
