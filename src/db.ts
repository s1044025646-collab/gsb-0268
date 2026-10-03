import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "./config";
import { PARSER_VERSION } from "./version";
import { analyzeBuffer, type Report } from "./report";
import { ExifError } from "./errors";

export interface FileRow {
  id: number;
  sha256: string;
  name: string;
  stored_path: string;
  parser_version: string;
  status: string;
  size: number;
  imported_at: string;
}

export class Store {
  private db: DatabaseSync;
  constructor(public config: Config) {
    fs.mkdirSync(config.filesDir, { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sha256 TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        status TEXT NOT NULL,
        size INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reports (
        file_id INTEGER PRIMARY KEY REFERENCES files(id),
        json TEXT NOT NULL
      );
    `);
  }

  /**
   * 导入文件：计算摘要，把只读副本写入项目数据目录，解析并保存报告。
   * 同一文件（相同 SHA-256）重复导入：返回既有记录，duplicate=true，不重复解析。
   * 解析失败也会保存 error 状态的报告，但不会标记为 ok。
   */
  importFile(sourcePath: string): { row: FileRow; report: Report; duplicate: boolean } {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(sourcePath);
    } catch {
      throw new ExifError("E_IO", `无法读取文件：${sourcePath}`);
    }
    const probe = analyzeBuffer(buf, path.basename(sourcePath));
    const existing = this.getBySha(probe.sha256);
    if (existing) {
      const report = this.getReport(existing.id);
      return { row: existing, report: report!, duplicate: true };
    }
    const storedPath = path.join(this.config.filesDir, `${probe.sha256}.jpg`);
    fs.writeFileSync(storedPath, buf, { flag: "wx" });
    const stmt = this.db.prepare(
      `INSERT INTO files (sha256, name, stored_path, parser_version, status, size, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const res = stmt.run(
      probe.sha256,
      path.basename(sourcePath),
      storedPath,
      PARSER_VERSION,
      probe.status,
      probe.fileSize,
      new Date().toISOString()
    );
    const id = Number(res.lastInsertRowid);
    this.db.prepare(`INSERT INTO reports (file_id, json) VALUES (?, ?)`).run(
      id,
      JSON.stringify(probe)
    );
    return { row: this.getById(id)!, report: probe, duplicate: false };
  }

  getById(id: number): FileRow | null {
    const row = this.db.prepare(`SELECT * FROM files WHERE id = ?`).get(id) as
      | FileRow
      | undefined;
    return row ?? null;
  }

  getBySha(sha: string): FileRow | null {
    const row = this.db.prepare(`SELECT * FROM files WHERE sha256 = ?`).get(sha) as
      | FileRow
      | undefined;
    return row ?? null;
  }

  list(): FileRow[] {
    return this.db.prepare(`SELECT * FROM files ORDER BY id`).all() as unknown as FileRow[];
  }

  getReport(id: number): Report | null {
    const row = this.db.prepare(`SELECT json FROM reports WHERE file_id = ?`).get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as Report) : null;
  }

  /** 从只读副本重新读取字节（用于段清单等实时查询） */
  readStored(id: number): Buffer {
    const row = this.getById(id);
    if (!row) throw new ExifError("E_NOT_FOUND", `文件记录 ${id} 不存在`);
    return fs.readFileSync(row.stored_path);
  }

  close(): void {
    this.db.close();
  }
}
