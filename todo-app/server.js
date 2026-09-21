// DoYu Todo Calendar — zero-dependency backend (Node 22+ : built-in http + node:sqlite)
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "todo.db");
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------- DB ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    dot TEXT NOT NULL, bg TEXT NOT NULL, tx TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,                       -- YYYY-MM-DD (the day it is listed on)
    text TEXT NOT NULL,
    cat TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE,
    done INTEGER NOT NULL DEFAULT 0,
    dl_date TEXT, dl_label TEXT,              -- optional deadline + calendar label
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_todos_date ON todos(date);
  CREATE INDEX IF NOT EXISTS idx_todos_dl ON todos(dl_date);
  CREATE TABLE IF NOT EXISTS monthly (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month TEXT NOT NULL,                      -- YYYY-MM
    text TEXT NOT NULL,
    cat TEXT NOT NULL REFERENCES categories(name) ON UPDATE CASCADE,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_monthly_month ON monthly(month);
`);
// migration: recurring todos (older DBs lack these columns) + per-occurrence completion
const todoCols = db.prepare("PRAGMA table_info(todos)").all().map((c) => c.name);
for (const c of ["repeat_type", "repeat_days", "repeat_until"]) if (!todoCols.includes(c)) db.exec(`ALTER TABLE todos ADD COLUMN ${c} TEXT`);
db.exec(`CREATE TABLE IF NOT EXISTS todo_done (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (todo_id, date)
)`);
db.exec(`CREATE TABLE IF NOT EXISTS todo_skip (
  todo_id INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (todo_id, date)
)`);
if (db.prepare("SELECT COUNT(*) c FROM categories").get().c === 0) {
  const ins = db.prepare("INSERT INTO categories(name,dot,bg,tx) VALUES (?,?,?,?)");
  [["업무", "#8FAEFF", "#E3EBFF", "#3C5BC4"], ["개인", "#FF9DB5", "#FFE4EB", "#C24468"],
   ["공부", "#7DD3A8", "#DDF4E8", "#2A8659"], ["운동", "#FFBE5C", "#FFEED2", "#B26F0A"]]
    .forEach((c) => ins.run(...c));
}

// ---------- validation ----------
class HttpError extends Error { constructor(status, msg, extra) { super(msg); this.status = status; this.extra = extra; } }
const bad = (m) => new HttpError(400, m);
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/, RE_MONTH = /^\d{4}-\d{2}$/, RE_HEX = /^#[0-9a-fA-F]{6}$/;
const validDate = (s) => typeof s === "string" && RE_DATE.test(s) && !isNaN(Date.parse(s));
const str = (v, name, max) => {
  if (typeof v !== "string" || !v.trim()) throw bad(`${name}을(를) 입력하세요`);
  if (v.trim().length > max) throw bad(`${name}은(는) ${max}자 이하여야 해요`);
  return v.trim();
};
const catExists = (n) => {
  if (!db.prepare("SELECT 1 FROM categories WHERE name=?").get(n)) throw bad("존재하지 않는 카테고리예요");
  return n;
};

// ---------- row mappers ----------
const todoOut = (r) => ({
  id: r.id, date: r.date, text: r.text, cat: r.cat, done: !!r.done,
  dl: r.dl_date ? { date: r.dl_date, label: r.dl_label || "" } : null,
  repeat: r.repeat_type
    ? { type: r.repeat_type, days: r.repeat_days ? r.repeat_days.split(",").map(Number) : [], until: r.repeat_until || null }
    : null,
  // recurring todos are completed per date, not as a whole
  doneDates: r.repeat_type ? db.prepare("SELECT date FROM todo_done WHERE todo_id=? ORDER BY date").all(r.id).map((x) => x.date) : [],
  // days of a recurring todo that were skipped ("이 날만 건너뛰기")
  skipDates: r.repeat_type ? db.prepare("SELECT date FROM todo_skip WHERE todo_id=? ORDER BY date").all(r.id).map((x) => x.date) : [],
});
const monthlyOut = (r) => ({ id: r.id, month: r.month, text: r.text, cat: r.cat, done: !!r.done });

// ---------- handlers ----------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp("^" + pattern + "$"), fn });

route("GET", "/api/state", () => {
  const monthly = {};
  db.prepare("SELECT * FROM monthly ORDER BY id").all().forEach((r) => (monthly[r.month] ||= []).push(monthlyOut(r)));
  return {
    cats: db.prepare("SELECT name n, dot, bg, tx FROM categories ORDER BY id").all(),
    todos: db.prepare("SELECT * FROM todos ORDER BY date, id").all().map(todoOut),
    monthly,
  };
});

route("POST", "/api/categories", (_, { body }) => {
  const n = str(body.name, "카테고리 이름", 12);
  for (const k of ["dot", "bg", "tx"]) if (!RE_HEX.test(body[k] || "")) throw bad("색상 형식이 올바르지 않아요");
  if (db.prepare("SELECT 1 FROM categories WHERE name=?").get(n)) throw new HttpError(409, "이미 있는 카테고리예요");
  db.prepare("INSERT INTO categories(name,dot,bg,tx) VALUES (?,?,?,?)").run(n, body.dot, body.bg, body.tx);
  return [201, { n, dot: body.dot, bg: body.bg, tx: body.tx }];
});

// Rename: todos/monthly follow automatically (FOREIGN KEY ... ON UPDATE CASCADE).
route("PATCH", "/api/categories/([^/]+)", ([, raw], { body }) => {
  let old;
  try { old = decodeURIComponent(raw); } catch { throw bad("카테고리 이름이 올바르지 않아요"); }
  const row = db.prepare("SELECT name n, dot, bg, tx FROM categories WHERE name=?").get(old);
  if (!row) throw new HttpError(404, "카테고리를 찾을 수 없어요");
  const n = str(body.name, "카테고리 이름", 12);
  if (n !== old) {
    if (db.prepare("SELECT 1 FROM categories WHERE name=?").get(n)) throw new HttpError(409, "이미 있는 카테고리예요");
    db.prepare("UPDATE categories SET name=? WHERE name=?").run(n, old);
  }
  return db.prepare("SELECT name n, dot, bg, tx FROM categories WHERE name=?").get(n);
});

// Deleting a category that is still in use needs ?cascade=1 (removes its todos too).
route("DELETE", "/api/categories/([^/]+)", ([, raw], { query }) => {
  let name;
  try { name = decodeURIComponent(raw); } catch { throw bad("카테고리 이름이 올바르지 않아요"); }
  if (!db.prepare("SELECT 1 FROM categories WHERE name=?").get(name)) throw new HttpError(404, "카테고리를 찾을 수 없어요");
  if (db.prepare("SELECT COUNT(*) c FROM categories").get().c <= 1) throw bad("카테고리는 최소 1개 있어야 해요");
  const used = db.prepare("SELECT (SELECT COUNT(*) FROM todos WHERE cat=?) + (SELECT COUNT(*) FROM monthly WHERE cat=?) c").get(name, name).c;
  if (used && query.get("cascade") !== "1") throw new HttpError(409, `이 카테고리의 할 일이 ${used}개 있어요`, { used });
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM todos WHERE cat=?").run(name);
    db.prepare("DELETE FROM monthly WHERE cat=?").run(name);
    db.prepare("DELETE FROM categories WHERE name=?").run(name);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return [204];
});

function readDeadline(dl) {
  if (!dl) return { dlDate: null, dlLabel: null };
  if (!validDate(dl.date)) throw bad("마감일이 올바르지 않아요");
  return { dlDate: dl.date, dlLabel: String(dl.label || "").trim().slice(0, 4) };
}
function readRepeat(r, startDate, hasDeadline) {
  if (!r) return { rType: null, rDays: null, rUntil: null };
  if (hasDeadline) throw bad("반복 일정에는 마감일을 함께 설정할 수 없어요");
  const rType = r.type;
  if (!["daily", "weekly", "monthly"].includes(rType)) throw bad("반복 종류가 올바르지 않아요");
  let rDays = null, rUntil = null;
  if (rType === "weekly") {
    if (!Array.isArray(r.days)) throw bad("반복할 요일을 선택하세요");
    const days = [...new Set(r.days)].sort();
    if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw bad("반복할 요일을 선택하세요");
    rDays = days.join(",");
  }
  if (r.until) {
    if (!validDate(r.until)) throw bad("반복 종료일이 올바르지 않아요");
    if (r.until < startDate) throw bad("종료일은 시작일 이후여야 해요");
    rUntil = r.until;
  }
  return { rType, rDays, rUntil };
}

route("POST", "/api/todos", (_, { body }) => {
  const text = str(body.text, "할 일", 200);
  if (!validDate(body.date)) throw bad("날짜가 올바르지 않아요");
  const cat = catExists(body.cat);
  const { dlDate, dlLabel } = readDeadline(body.dl);
  const { rType, rDays, rUntil } = readRepeat(body.repeat, body.date, !!dlDate);
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO todos(date,text,cat,dl_date,dl_label,repeat_type,repeat_days,repeat_until) VALUES (?,?,?,?,?,?,?,?)")
    .run(body.date, text, cat, dlDate, dlLabel, rType, rDays, rUntil);
  return [201, todoOut(db.prepare("SELECT * FROM todos WHERE id=?").get(lastInsertRowid))];
});

route("PATCH", "/api/todos/(\\d+)", ([, id], { body }) => {
  const row = db.prepare("SELECT * FROM todos WHERE id=?").get(id);
  if (!row) throw new HttpError(404, "할 일을 찾을 수 없어요");
  const text = body.text !== undefined ? str(body.text, "할 일", 200) : row.text;
  if (body.skip !== undefined) {
    if (!row.repeat_type) throw bad("반복 일정만 건너뛸 수 있어요");
    if (!validDate(body.date)) throw bad("건너뛸 날짜가 필요해요");
    if (body.skip) db.prepare("INSERT OR IGNORE INTO todo_skip(todo_id,date) VALUES (?,?)").run(id, body.date);
    else db.prepare("DELETE FROM todo_skip WHERE todo_id=? AND date=?").run(id, body.date);
  }
  let done = row.done;
  if (body.done !== undefined) {
    if (row.repeat_type) {
      if (!validDate(body.date)) throw bad("반복 일정은 완료할 날짜가 필요해요");
      if (body.done) db.prepare("INSERT OR IGNORE INTO todo_done(todo_id,date) VALUES (?,?)").run(id, body.date);
      else db.prepare("DELETE FROM todo_done WHERE todo_id=? AND date=?").run(id, body.date);
    } else done = body.done ? 1 : 0;
  }
  const cat = body.cat !== undefined ? catExists(body.cat) : row.cat;
  let dlDate = row.dl_date, dlLabel = row.dl_label, rType = row.repeat_type, rDays = row.repeat_days, rUntil = row.repeat_until;
  if ("dl" in body) ({ dlDate, dlLabel } = readDeadline(body.dl));
  if ("repeat" in body) ({ rType, rDays, rUntil } = readRepeat(body.repeat, row.date, !!dlDate));
  if (dlDate && rType) throw bad("반복 일정에는 마감일을 함께 설정할 수 없어요");
  if (row.repeat_type && !rType) { // no longer recurring: drop per-day records
    db.prepare("DELETE FROM todo_done WHERE todo_id=?").run(id);
    db.prepare("DELETE FROM todo_skip WHERE todo_id=?").run(id);
  }
  db.prepare("UPDATE todos SET text=?, done=?, cat=?, dl_date=?, dl_label=?, repeat_type=?, repeat_days=?, repeat_until=? WHERE id=?")
    .run(text, done, cat, dlDate, dlLabel, rType, rDays, rUntil, id);
  return todoOut(db.prepare("SELECT * FROM todos WHERE id=?").get(id));
});

route("DELETE", "/api/todos/(\\d+)", ([, id]) => {
  if (!db.prepare("DELETE FROM todos WHERE id=?").run(id).changes) throw new HttpError(404, "할 일을 찾을 수 없어요");
  return [204];
});

route("POST", "/api/monthly", (_, { body }) => {
  const text = str(body.text, "할 일", 200);
  if (!RE_MONTH.test(body.month || "")) throw bad("월 형식이 올바르지 않아요");
  const cat = catExists(body.cat);
  const { lastInsertRowid } = db.prepare("INSERT INTO monthly(month,text,cat) VALUES (?,?,?)").run(body.month, text, cat);
  return [201, monthlyOut(db.prepare("SELECT * FROM monthly WHERE id=?").get(lastInsertRowid))];
});

route("PATCH", "/api/monthly/(\\d+)", ([, id], { body }) => {
  const row = db.prepare("SELECT * FROM monthly WHERE id=?").get(id);
  if (!row) throw new HttpError(404, "할 일을 찾을 수 없어요");
  const text = body.text !== undefined ? str(body.text, "할 일", 200) : row.text;
  const done = body.done !== undefined ? (body.done ? 1 : 0) : row.done;
  const cat = body.cat !== undefined ? catExists(body.cat) : row.cat;
  db.prepare("UPDATE monthly SET text=?, done=?, cat=? WHERE id=?").run(text, done, cat, id);
  return monthlyOut(db.prepare("SELECT * FROM monthly WHERE id=?").get(id));
});

route("DELETE", "/api/monthly/(\\d+)", ([, id]) => {
  if (!db.prepare("DELETE FROM monthly WHERE id=?").run(id).changes) throw new HttpError(404, "할 일을 찾을 수 없어요");
  return [204];
});

// ---------- server ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".png": "image/png" };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, "요청이 너무 커요")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { const b = JSON.parse(Buffer.concat(chunks).toString("utf8")); resolve(b && typeof b === "object" ? b : {}); }
      catch { reject(bad("JSON 형식이 올바르지 않아요")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  if (status === 204) { res.writeHead(204); return res.end(); }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
}

// Optional single-user password (HTTP Basic). Off unless AUTH_USER and AUTH_PASS are both set.
const AUTH_USER = process.env.AUTH_USER || "", AUTH_PASS = process.env.AUTH_PASS || "";
const sha = (s) => crypto.createHash("sha256").update(s).digest();
function authorized(req) {
  if (!AUTH_USER || !AUTH_PASS) return true;
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (!m) return false;
  const [u, ...p] = Buffer.from(m[1], "base64").toString("utf8").split(":");
  return crypto.timingSafeEqual(sha(u), sha(AUTH_USER)) & crypto.timingSafeEqual(sha(p.join(":")), sha(AUTH_PASS));
}

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams: query } = new URL(req.url, "http://localhost");
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Todo Calendar", charset="UTF-8"' });
    return res.end("Authentication required");
  }
  try {
    if (pathname.startsWith("/api/")) {
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname));
      if (!r) return sendJson(res, routes.some((x) => x.re.test(pathname)) ? 405 : 404, { error: "not found" });
      const body = req.method === "POST" || req.method === "PATCH" ? await readBody(req) : {};
      const out = await r.fn(pathname.match(r.re), { body, query });
      return Array.isArray(out) ? sendJson(res, out[0], out[1]) : sendJson(res, 200, out);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "method not allowed" });
    serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message, ...e.extra });
    console.error(e);
    sendJson(res, 500, { error: "서버 오류가 발생했어요" });
  }
});

const HOST = process.env.HOST || "0.0.0.0"; // set HOST=127.0.0.1 when a reverse proxy (Caddy) sits in front
server.listen(PORT, HOST, () => console.log(`Todo Calendar running → http://${HOST}:${PORT}  (db: ${DB_PATH})`));
process.on("SIGINT", () => { server.close(); db.close(); process.exit(0); });
