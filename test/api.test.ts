import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/db";
import { buildFixture } from "../src/fixtures";
import { createServer } from "../src/server";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "exif-test-"));
}

test("导入：重复导入行为固定，重启后记录保留，失败不产生正常报告", () => {
  const dir = tmpDir();
  const src = path.join(dir, "a.jpg");
  fs.writeFileSync(src, buildFixture({}).buf);

  const store = new Store(path.join(dir, "data"));
  const r1 = store.importFile(src);
  assert.equal(r1.duplicate, false);
  assert.equal(r1.report.status, "ok");
  const r2 = store.importFile(src);
  assert.equal(r2.duplicate, true);
  assert.equal(r2.row.id, r1.row.id);
  assert.equal(store.listFiles().length, 1);
  // 只读副本在项目数据目录内
  assert.ok(r1.row.stored_path.startsWith(path.join(dir, "data")));
  store.close();

  // 模拟重启
  const store2 = new Store(path.join(dir, "data"));
  assert.equal(store2.listFiles().length, 1);
  assert.equal(store2.getReport(r1.row.id)!.status, "ok");
  store2.close();

  // 损坏文件：状态为 error，不会写成 ok
  const badDir = tmpDir();
  const badSrc = path.join(badDir, "bad.jpg");
  fs.writeFileSync(badSrc, buildFixture({ badMagic: true }).buf);
  const store3 = new Store(path.join(badDir, "data"));
  const rb = store3.importFile(badSrc);
  assert.equal(rb.report.status, "error");
  assert.equal(rb.row.status, "error");
  store3.close();
});

test("HTTP API：导入、段清单、标签、偏移解释、报告、导出", async () => {
  const dir = tmpDir();
  const src = path.join(dir, "b.jpg");
  fs.writeFileSync(src, buildFixture({ byteOrder: "MM" }).buf);
  const store = new Store(path.join(dir, "data"));
  const server = createServer(store);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const imp = await fetch(`${base}/api/files/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: src }),
  });
  assert.equal(imp.status, 201);
  const impBody = await imp.json() as { file: { id: number } };
  const id = impBody.file.id;

  const segs = await (await fetch(`${base}/api/files/${id}/segments`)).json() as unknown[];
  assert.equal(segs.length, 4);

  const tags = await (await fetch(`${base}/api/files/${id}/tags`)).json() as { tag: string; display: string }[];
  assert.ok(tags.some((t) => t.tag === "0x010F" && t.display === "TestCam"));

  const exp = await (await fetch(`${base}/api/files/${id}/explain/0x010F`)).json() as {
    value: { offset: number; inline: boolean };
  };
  assert.equal(exp.value.offset, 172);
  assert.equal(exp.value.inline, false);

  const rep = await (await fetch(`${base}/api/files/${id}/report`)).json() as { byteOrder: string };
  assert.equal(rep.byteOrder, "MM");

  const expRes = await fetch(`${base}/api/files/${id}/export`);
  assert.equal(expRes.status, 200);
  assert.match(expRes.headers.get("content-disposition")!, /attachment/);

  const notFound = await fetch(`${base}/api/files/999/report`);
  assert.equal(notFound.status, 404);
  const badReq = await fetch(`${base}/api/files/import`, { method: "POST", body: "{}" });
  assert.equal(badReq.status, 400);

  server.close();
  store.close();
});
