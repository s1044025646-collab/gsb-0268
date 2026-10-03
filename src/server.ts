// HTTP API (node:http, no external deps). Configurable port; 0 = pick a free port.
import http from "node:http";
import fs from "node:fs";
import { Store } from "./db";
import { FileReport, TagEntry } from "./exif";
import { interpretTag } from "./interpret";

export interface ApiError { error: { code: string; message: string } }

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}
function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  send(res, status, { error: { code, message } } satisfies ApiError);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 1 << 20) reject(new Error("body too large"));
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function explainTagOffset(report: FileReport, entry: TagEntry): unknown {
  const tiffStart = report.exif?.tiffStart ?? 0;
  return {
    tag: entry.tagHex,
    ifd: entry.ifd,
    entryOffset: entry.entryOffset,
    fields: {
      tag: { offset: entry.entryOffset, length: 2 },
      type: { offset: entry.entryOffset + 2, length: 2, value: entry.typeName },
      count: { offset: entry.entryOffset + 4, length: 4, value: entry.count, note: "元素数量，不是字节数" },
      valueOrOffset: { offset: entry.entryOffset + 8, length: 4 },
    },
    value: {
      inline: entry.inline,
      offset: entry.valueOffset,
      length: entry.valueLength,
      basis: entry.inline
        ? "值不超过 4 字节，直接存放在条目内偏移字段处"
        : `条目内为相对 TIFF 起点（文件偏移 ${tiffStart}）的偏移，实际值位于 ${entry.valueOffset}`,
    },
    error: entry.error ?? null,
  };
}

export function tagView(entry: TagEntry): unknown {
  const it = interpretTag(entry);
  return {
    tag: entry.tagHex,
    name: it.name,
    known: it.known,
    ifd: entry.ifd,
    type: entry.typeName,
    count: entry.count,
    inline: entry.inline,
    valueOffset: entry.valueOffset,
    valueLength: entry.valueLength,
    entryOffset: entry.entryOffset,
    raw: entry.raw,
    display: it.display,
    note: it.note ?? null,
    error: it.error ?? null,
  };
}

export function createServer(store: Store): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/files") {
        return send(res, 200, store.listFiles());
      }
      if (method === "POST" && url.pathname === "/api/files/import") {
        const body = JSON.parse(await readBody(req) || "{}");
        if (typeof body.path !== "string" || body.path.length === 0) {
          return fail(res, 400, "BAD_REQUEST", "需要 JSON 字段 path（本地文件路径）");
        }
        if (!fs.existsSync(body.path)) {
          return fail(res, 404, "FILE_NOT_FOUND", `文件不存在: ${body.path}`);
        }
        const { row, report, duplicate } = store.importFile(body.path);
        return send(res, duplicate ? 200 : 201, { file: row, duplicate, status: report.status, errors: report.errors });
      }
      if (parts[0] === "api" && parts[1] === "files" && parts.length >= 3) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) return fail(res, 400, "BAD_REQUEST", "文件 id 必须是整数");
        const row = store.getFile(id);
        if (!row) return fail(res, 404, "NOT_FOUND", `没有 id=${id} 的记录`);
        const report = store.getReport(id)!;
        const sub = parts[3];
        if (!sub) return send(res, 200, { file: row, status: report.status });
        if (sub === "segments") return send(res, 200, report.segments);
        if (sub === "tags") {
          const tags = report.exif?.tags ?? [];
          return send(res, 200, tags.map(tagView));
        }
        if (sub === "explain") {
          const tags = report.exif?.tags ?? [];
          const q = parts[4];
          const entry = q?.startsWith("0x")
            ? tags.find((t) => t.tagHex.toLowerCase() === q.toLowerCase())
            : tags[Number(q)];
          if (!entry) return fail(res, 404, "NOT_FOUND", `没有标签 ${q}`);
          return send(res, 200, explainTagOffset(report, entry));
        }
        if (sub === "report") return send(res, 200, report);
        if (sub === "export") {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Disposition": `attachment; filename="report-${id}.json"`,
          });
          return res.end(JSON.stringify(report, null, 2));
        }
      }
      return fail(res, 404, "NOT_FOUND", "未知路由");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(res, 500, "INTERNAL", msg);
    }
  });
  return server;
}

export function startServer(store: Store, port: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      console.log(`API 服务已启动: http://127.0.0.1:${actual}/api/files`);
      resolve(actual);
    });
  });
}
