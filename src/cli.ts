import fs from "node:fs";
import { Store } from "./db";
import { loadConfig } from "./config";
import { explainTagOffset } from "./report";
import { ExifError } from "./errors";
import { startServer } from "./server";

const USAGE = `用法：node dist/src/cli.js <命令> [参数]

命令：
  import <路径>            导入 JPEG 文件并解析（重复导入返回既有记录）
  list                     列出已导入文件
  segments <id>            显示 JPEG 段清单
  tags <id>                显示 EXIF 标签
  offsets <id>             逐条偏移解释
  report <id>              显示解析报告
  export <id> [输出路径]   导出 JSON 报告（默认输出到 stdout）
  serve [--port N]         启动 HTTP 服务（默认自动选择空闲端口）
`;

function fail(msg: string): never {
  console.error(`错误：${msg}`);
  process.exit(2);
}

function parseId(arg: string | undefined): number {
  const id = Number(arg);
  if (!arg || !Number.isInteger(id) || id <= 0) fail(`非法文件 id：${arg ?? "(缺失)"}`);
  return id;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(USAGE);
    return;
  }
  if (cmd === "serve") {
    const portIdx = args.indexOf("--port");
    const port = portIdx >= 0 ? Number(args[portIdx + 1]) : undefined;
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      fail(`非法端口：${args[portIdx + 1]}`);
    }
    const { port: actual } = await startServer(port);
    console.log(`EXIF 检查服务已启动：http://127.0.0.1:${actual}`);
    return;
  }

  const store = new Store(loadConfig());
  try {
    switch (cmd) {
      case "import": {
        const p = args[0];
        if (!p) fail("缺少文件路径");
        const { row, report, duplicate } = store.importFile(p);
        console.log(
          `${duplicate ? "已存在（重复导入，返回既有记录）" : "已导入"}：id=${row.id} sha256=${row.sha256}`
        );
        console.log(`状态：${report.status}，标签数：${report.tags.length}`);
        if (report.errors.length > 0) {
          console.log(`错误：${JSON.stringify(report.errors, null, 2)}`);
        }
        break;
      }
      case "list": {
        for (const f of store.list()) {
          console.log(`#${f.id} ${f.name} status=${f.status} size=${f.size} ${f.imported_at}`);
        }
        break;
      }
      case "segments": {
        const report = mustReport(store, parseId(args[0]));
        for (const s of report.segments) {
          console.log(
            `[${s.index}] ${s.name} 偏移=${s.offset} 数据=${s.dataStart}..${s.dataEnd} 长度=${s.dataLength}${s.isExif ? " [EXIF]" : ""}`
          );
        }
        break;
      }
      case "tags": {
        const report = mustReport(store, parseId(args[0]));
        if (report.status === "no_metadata") {
          console.log("该文件没有 EXIF 元数据（文件未损坏）。");
          break;
        }
        for (const t of report.tags) {
          const diag = t.diagnostics.length > 0 ? `  [诊断: ${t.diagnostics.join("；")}]` : "";
          console.log(
            `${t.ifd} 0x${t.tag.toString(16).padStart(4, "0")} ${t.name} ${t.typeName ?? `类型${t.type}`}x${t.count} = ${t.display ?? "(无)"}${diag}`
          );
        }
        break;
      }
      case "offsets": {
        const report = mustReport(store, parseId(args[0]));
        for (const t of report.tags) {
          console.log(explainTagOffset(t, report.tiffStart));
          console.log("");
        }
        break;
      }
      case "report": {
        const report = mustReport(store, parseId(args[0]));
        console.log(JSON.stringify(report, null, 2));
        break;
      }
      case "export": {
        const report = mustReport(store, parseId(args[0]));
        const json = JSON.stringify(report, null, 2);
        const out = args[1];
        if (out) {
          fs.writeFileSync(out, json, "utf8");
          console.log(`已导出：${out}`);
        } else {
          console.log(json);
        }
        break;
      }
      default:
        fail(`未知命令：${cmd}\n${USAGE}`);
    }
  } catch (e) {
    if (e instanceof ExifError) {
      console.error(`错误 [${e.code}] ${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    store.close();
  }
}

function mustReport(store: Store, id: number) {
  const report = store.getReport(id);
  if (!report) throw new ExifError("E_NOT_FOUND", `文件记录 ${id} 不存在`);
  return report;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
