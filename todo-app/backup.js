// Consistent SQLite snapshot: node backup.js <output-file>
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const out = process.argv[2];
if (!out) { console.error("usage: node backup.js <output-file>"); process.exit(1); }
if (fs.existsSync(out)) fs.unlinkSync(out);
const db = new DatabaseSync(process.env.DB_PATH || "/data/todo.db", { readOnly: true });
db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
db.close();
console.log("backup written:", out);
