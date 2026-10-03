// SQLite storage via node:sqlite (no native deps). Only writes inside the project data dir.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FileReport, PARSER_VERSION } from "./exif";

export interface FileRow {
  id: number;
  sha256: string;
  name: string;
  size: number;
  stored_path: string;
  imported_at: string;
  parser_version: string;
  status: string;
}

export class Store {
  db: DatabaseSync;
  dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(path.join(this.dataDir, "files"), { recursive: true });
    this.db = new DatabaseSync(path.join(this.dataDir, "exif.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        stored_path TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        file_id INTEGER PRIMARY KEY REFERENCES files(id),
        json TEXT NOT NULL
      );
    `);
  }

  // Fixed duplicate behavior: same content returns the existing record with duplicate=true.
  importFile(sourcePath: string): { row: FileRow; report: FileReport; duplicate: boolean } {
    const abs = path.resolve(sourcePath);
    if (!abs.startsWith(this.dataDir) && !fs.existsSync(abs)) {
      throw Object.assign(new Error(`file not found: ${abs}`), { code: "FILE_NOT_FOUND" });
    }
    const buf = fs.readFileSync(abs);
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const existing = this.db.prepare("SELECT * FROM files WHERE sha256 = ?").get(sha256) as unknown as FileRow | undefined;
    if (existing) {
      const report = JSON.parse(
        (this.db.prepare("SELECT json FROM reports WHERE file_id = ?").get(existing.id) as { json: string }).json
      ) as FileReport;
      return { row: existing, report, duplicate: true };
    }
    // Parse first; failures never produce an "ok" report row.
    const { parseFile } = require("./exif") as typeof import("./exif");
    const report: FileReport = parseFile(buf);
    const storedPath = path.join(this.dataDir, "files", `${sha256}.jpg`);
    fs.writeFileSync(storedPath, buf, { mode: 0o444 }); // read-only project copy
    const stmt = this.db.prepare(
      "INSERT INTO files (sha256, name, size, stored_path, imported_at, parser_version, status) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const res = stmt.run(sha256, path.basename(abs), buf.length, storedPath, new Date().toISOString(), PARSER_VERSION, report.status);
    const id = Number(res.lastInsertRowid);
    this.db.prepare("INSERT INTO reports (file_id, json) VALUES (?, ?)").run(id, JSON.stringify(report));
    const row = this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as unknown as FileRow;
    return { row, report, duplicate: false };
  }

  listFiles(): FileRow[] {
    return this.db.prepare("SELECT * FROM files ORDER BY id").all() as unknown as FileRow[];
  }

  getFile(id: number): FileRow | undefined {
    return this.db.prepare("SELECT * FROM files WHERE id = ?").get(id) as unknown as FileRow | undefined;
  }

  getReport(id: number): FileReport | undefined {
    const r = this.db.prepare("SELECT json FROM reports WHERE file_id = ?").get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as FileReport) : undefined;
  }

  readStoredBuffer(row: FileRow): Buffer {
    return fs.readFileSync(row.stored_path);
  }

  close(): void {
    this.db.close();
  }
}

