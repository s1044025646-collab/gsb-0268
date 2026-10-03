import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildExifJpeg, buildNoExifJpeg } from "../test/fixtures";

const demoDir = path.join(process.cwd(), "data", "demo");
fs.mkdirSync(demoDir, { recursive: true });

const le = path.join(demoDir, "demo-le.jpg");
const be = path.join(demoDir, "demo-be.jpg");
const noexif = path.join(demoDir, "demo-noexif.jpg");
const broken = path.join(demoDir, "demo-broken.jpg");

fs.writeFileSync(le, buildExifJpeg("LE").buf);
fs.writeFileSync(be, buildExifJpeg("BE").buf);
fs.writeFileSync(noexif, buildNoExifJpeg());
const brokenFx = buildExifJpeg("LE");
const brokenBuf = Buffer.from(brokenFx.buf);
// 精确破坏 Make 条目的值偏移字段，使其越界
brokenBuf.writeUInt32LE(0x7fffffff, brokenFx.positions.get(0x010f)!.entryOffset + 8);
fs.writeFileSync(broken, brokenBuf);

const cli = path.join(__dirname, "..", "src", "cli.js");
const run = (args: string[]) => {
  console.log(`\n$ cli ${args.join(" ")}`);
  try {
    process.stdout.write(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }));
  } catch (e: any) {
    process.stdout.write(String(e.stdout ?? "") + String(e.stderr ?? ""));
  }
};

console.log("== 导入四个演示文件（合成、可重建） ==");
run(["import", le]);
run(["import", be]);
run(["import", noexif]);
run(["import", broken]);
run(["list"]);
run(["tags", "1"]);
run(["offsets", "1"]);
console.log("\n提示：同一组标签在 LE(id=1) 与 BE(id=2) 下语义一致，可用 `report 1` / `report 2` 对比。");
