// CLI entry: import / list / segments / tags / explain / report / export / serve / demo
import fs from "node:fs";
import path from "node:path";
import { Store } from "./db";
import { startServer, tagView, explainTagOffset } from "./server";
import { buildFixture } from "./fixtures";

const DATA_DIR = process.env.EXIF_DATA_DIR ?? path.join(process.cwd(), "data");

function out(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function needStore(): Store {
  return new Store(DATA_DIR);
}

function getReportOrFail(store: Store, id: number) {
  const report = store.getReport(id);
  if (!report) {
    console.error(`错误 NOT_FOUND: 没有 id=${id} 的记录`);
    process.exit(1);
  }
  return report!;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = needStore();
  switch (cmd) {
    case "import": {
      const p = args[0];
      if (!p) { console.error("用法: cli import <文件路径>"); process.exit(2); }
      if (!fs.existsSync(p)) { console.error(`错误 FILE_NOT_FOUND: ${p}`); process.exit(1); }
      const { row, report, duplicate } = store.importFile(p);
      out({ file: row, duplicate, status: report.status, errors: report.errors });
      break;
    }
    case "list":
      out(store.listFiles());
      break;
    case "segments": {
      const report = getReportOrFail(store, Number(args[0]));
      out(report.segments);
      break;
    }
    case "tags": {
      const report = getReportOrFail(store, Number(args[0]));
      out((report.exif?.tags ?? []).map(tagView));
      break;
    }
    case "explain": {
      const report = getReportOrFail(store, Number(args[0]));
      const q = args[1];
      const tags = report.exif?.tags ?? [];
      const entry = q?.startsWith("0x")
        ? tags.find((t) => t.tagHex.toLowerCase() === q.toLowerCase())
        : tags[Number(q)];
      if (!entry) { console.error(`错误 NOT_FOUND: 没有标签 ${q}`); process.exit(1); }
      out(explainTagOffset(report, entry));
      break;
    }
    case "report": {
      out(getReportOrFail(store, Number(args[0])));
      break;
    }
    case "export": {
      const report = getReportOrFail(store, Number(args[0]));
      const target = args[1];
      const json = JSON.stringify(report, null, 2);
      if (target) { fs.writeFileSync(target, json); console.log(`已导出 ${target}`); }
      else console.log(json);
      break;
    }
    case "serve": {
      const portIdx = args.indexOf("--port");
      const port = portIdx >= 0 ? Number(args[portIdx + 1]) : Number(process.env.PORT ?? 0); // 0 = 自动选空闲端口
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        console.error("错误 BAD_REQUEST: 端口必须是 0-65535 的整数");
        process.exit(2);
      }
      await startServer(store, port);
      return; // keep running
    }
    case "demo": {
      const demoDir = path.join(DATA_DIR, "demo");
      fs.mkdirSync(demoDir, { recursive: true });
      const cases: [string, Parameters<typeof buildFixture>[0]][] = [
        ["demo-ii.jpg", { byteOrder: "II" }],
        ["demo-mm.jpg", { byteOrder: "MM" }],
        ["demo-no-exif.jpg", { skipExif: true }],
        ["demo-zero-denominator.jpg", { exposureDen: 0 }],
        ["demo-bad-offset.jpg", { makeOffsetOverride: 0x00ffffff }],
        ["demo-bad-magic.jpg", { badMagic: true }],
      ];
      for (const [name, opts] of cases) {
        const f = buildFixture(opts);
        const p = path.join(demoDir, name);
        fs.writeFileSync(p, f.buf);
        const { row, report, duplicate } = store.importFile(p);
        console.log(`${name}: id=${row.id} status=${report.status}${duplicate ? " (重复)" : ""}` +
          (report.errors.length ? ` 错误=${report.errors.map((e) => `${e.code}@${e.fileOffset ?? "?"}`).join(",")}` : ""));
      }
      console.log(`演示文件位于 ${demoDir}，可用 list/tags/explain/report 查看`);
      break;
    }
    default:
      console.log(`用法: node dist/src/cli.js <命令>
  import <路径>        导入本地 JPEG（只读复制到数据目录）
  list                列出已导入文件
  segments <id>       段清单
  tags <id>           标签查询（含解释）
  explain <id> <标签> 逐条偏移解释（标签可用序号或 0xXXXX）
  report <id>         解析报告
  export <id> [文件]  JSON 导出
  serve [--port N]    启动 API（默认自动选空闲端口）
  demo                生成并导入合成演示文件`);
      process.exit(cmd ? 2 : 0);
  }
  store.close();
}

main().catch((e) => {
  console.error(`错误 INTERNAL: ${e.message ?? e}`);
  process.exit(1);
});
