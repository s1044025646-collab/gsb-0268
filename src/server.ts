import http from "node:http";
import { Store } from "./db";
import { loadConfig } from "./config";
import { ExifError } from "./errors";
import { explainTagOffset } from "./report";
import { PARSER_VERSION } from "./version";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, status: number, err: ExifError): void {
  sendJson(res, status, { error: err.toJSON() });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) throw new ExifError("E_VALIDATION", "请求体过大");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, parserVersion: PARSER_VERSION });
      }

      if (method === "POST" && url.pathname === "/files/import") {
        const body = await readBody(req);
        let parsed: { path?: unknown };
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new ExifError("E_VALIDATION", "请求体必须是 JSON：{\"path\": \"...\"}");
        }
        if (typeof parsed.path !== "string" || parsed.path.length === 0) {
          throw new ExifError("E_VALIDATION", "缺少字符串字段 path");
        }
        const { row, report, duplicate } = store.importFile(parsed.path);
        return sendJson(res, duplicate ? 200 : 201, { file: row, duplicate, report });
      }

      if (method === "GET" && url.pathname === "/files") {
        return sendJson(res, 200, { files: store.list() });
      }

      if (parts[0] === "files" && parts.length >= 2) {
        const id = Number(parts[1]);
        if (!Number.isInteger(id) || id <= 0) {
          throw new ExifError("E_VALIDATION", `非法文件 id：${parts[1]}`);
        }
        const row = store.getById(id);
        if (!row) throw new ExifError("E_NOT_FOUND", `文件记录 ${id} 不存在`);
        const report = store.getReport(id);
        const sub = parts[2];

        if (method === "GET" && parts.length === 2) {
          return sendJson(res, 200, { file: row });
        }
        if (method === "GET" && sub === "segments") {
          return sendJson(res, 200, { segments: report?.segments ?? [] });
        }
        if (method === "GET" && sub === "tags" && parts.length === 3) {
          return sendJson(res, 200, { tags: report?.tags ?? [] });
        }
        if (method === "GET" && sub === "tags" && parts.length === 4) {
          const tagNum = Number(parts[3]);
          if (!Number.isInteger(tagNum)) {
            throw new ExifError("E_VALIDATION", `非法标签编号：${parts[3]}`);
          }
          const tag = (report?.tags ?? []).find((t) => t.tag === tagNum);
          if (!tag) throw new ExifError("E_NOT_FOUND", `标签 ${tagNum} 不存在`);
          return sendJson(res, 200, { tag });
        }
        if (method === "GET" && sub === "offsets") {
          const explanations = (report?.tags ?? []).map((t) => ({
            tag: t.tag,
            name: t.name,
            explanation: explainTagOffset(t, report?.tiffStart ?? null),
          }));
          return sendJson(res, 200, { offsets: explanations });
        }
        if (method === "GET" && sub === "report") {
          if (url.searchParams.get("format") === "json" || parts[3] === "json") {
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-disposition": `attachment; filename="report-${id}.json"`,
            });
            return res.end(JSON.stringify(report, null, 2));
          }
          return sendJson(res, 200, { report });
        }
      }

      throw new ExifError("E_NOT_FOUND", `未知路由：${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ExifError) {
        const status =
          e.code === "E_NOT_FOUND"
            ? 404
            : e.code === "E_VALIDATION"
              ? 400
              : e.code === "E_IO"
                ? 400
                : 422;
        return sendError(res, status, e);
      }
      return sendError(res, 500, new ExifError("E_IO", String(e)));
    }
  });
}

export async function startServer(port?: number): Promise<{ server: http.Server; port: number }> {
  const config = loadConfig();
  const store = new Store(config);
  const server = createServer(store);
  const wanted = port ?? config.port;
  await new Promise<void>((resolve) => server.listen(wanted, "127.0.0.1", resolve));
  const addr = server.address();
  const actual = typeof addr === "object" && addr ? addr.port : wanted;
  return { server, port: actual };
}

if (require.main === module) {
  startServer().then(({ port }) => {
    console.log(`EXIF 检查服务已启动：http://127.0.0.1:${port}`);
    console.log(`数据目录：${loadConfig().dataDir}`);
  });
}
