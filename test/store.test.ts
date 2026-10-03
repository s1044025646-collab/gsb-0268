import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db";
import { buildExifJpeg, buildNoExifJpeg } from "./fixtures";

function tmpConfig() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "exif-test-"));
  return {
    dataDir,
    filesDir: path.join(dataDir, "files"),
    dbPath: path.join(dataDir, "exif.db"),
    port: 0,
  };
}

test("导入、重复导入固定行为、重启后可查询", () => {
  const config = tmpConfig();
  const src = path.join(config.dataDir, "src.jpg");
  fs.writeFileSync(src, buildExifJpeg("BE").buf);

  const store = new Store(config);
  const first = store.importFile(src);
  assert.equal(first.duplicate, false);
  assert.equal(first.report.status, "ok");
  assert.equal(first.report.tags.length, 9);
  // 只读副本写在项目数据目录内
  assert.ok(first.row.stored_path.startsWith(config.filesDir));
  assert.equal(first.row.parser_version.length > 0, true);

  const second = store.importFile(src);
  assert.equal(second.duplicate, true);
  assert.equal(second.row.id, first.row.id);
  store.close();

  // 模拟重启：重新打开同一数据库
  const store2 = new Store(config);
  const row = store2.getById(first.row.id);
  assert.ok(row);
  const report = store2.getReport(first.row.id)!;
  assert.equal(report.status, "ok");
  assert.equal(report.endian, "BE");
  store2.close();
});

test("无 EXIF 文件保存为 no_metadata，损坏文件保存为 error 而非正常报告", () => {
  const config = tmpConfig();
  const okSrc = path.join(config.dataDir, "ok.jpg");
  fs.writeFileSync(okSrc, buildNoExifJpeg());
  const badSrc = path.join(config.dataDir, "bad.jpg");
  fs.writeFileSync(badSrc, Buffer.from("garbage"));

  const store = new Store(config);
  const a = store.importFile(okSrc);
  assert.equal(a.row.status, "no_metadata");
  const b = store.importFile(badSrc);
  assert.equal(b.row.status, "error");
  assert.notEqual(b.row.status, "ok");
  assert.ok(b.report.errors.length > 0);
  store.close();
});
