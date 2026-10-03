import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeBuffer } from "../src/report";
import { buildExifJpeg, buildNoExifJpeg } from "./fixtures";

// 手工计算的锚点：SOI(2) + APP0(4+14) + XMP-APP1(4+29) = 53 → Exif APP1 数据起于 57，TIFF 起于 63
const EXPECTED_TIFF_START = 63;

test("LE：解析出全部 9 个标签且位置与夹具一致", () => {
  const fx = buildExifJpeg("LE");
  assert.equal(fx.tiffStart, EXPECTED_TIFF_START);
  const r = analyzeBuffer(fx.buf, "le.jpg");
  assert.equal(r.status, "ok");
  assert.equal(r.endian, "LE");
  assert.equal(r.tiffStart, EXPECTED_TIFF_START);
  assert.equal(r.tags.length, 9);
  for (const t of r.tags) {
    const pos = fx.positions.get(t.tag)!;
    assert.equal(t.entryOffset, pos.entryOffset, `tag ${t.tag} entryOffset`);
    assert.equal(t.valueOffset, pos.valueOffset, `tag ${t.tag} valueOffset`);
    assert.equal(t.valueLength, pos.valueLength, `tag ${t.tag} valueLength`);
  }
});

test("BE 与 LE 语义一致", () => {
  const le = analyzeBuffer(buildExifJpeg("LE").buf);
  const be = analyzeBuffer(buildExifJpeg("BE").buf);
  assert.equal(be.status, "ok");
  assert.equal(be.endian, "BE");
  const pick = (r: typeof le) =>
    Object.fromEntries(r.tags.map((t) => [t.tag, t.display]));
  assert.deepEqual(pick(be), pick(le));
});

test("内联 SHORT：Orientation=6 且值在条目内", () => {
  const fx = buildExifJpeg("LE");
  const r = analyzeBuffer(fx.buf);
  const o = r.tags.find((t) => t.tag === 0x0112)!;
  assert.equal(o.inline, true);
  assert.equal(o.valueOffset, o.entryOffset + 8);
  assert.equal(o.display, "6");
  assert.match(o.interpretation!, /顺时针旋转 90°/);
});

test("外置 ASCII：Make/Model 保留原文", () => {
  const fx = buildExifJpeg("LE");
  const r = analyzeBuffer(fx.buf);
  const make = r.tags.find((t) => t.tag === 0x010f)!;
  assert.equal(make.inline, false);
  assert.equal(make.display, "TestCam");
  assert.equal(r.tags.find((t) => t.tag === 0x0110)!.display, "Model X");
  const dt = r.tags.find((t) => t.tag === 0x9003)!;
  assert.equal(dt.display, "2024:01:02 03:04:06");
  assert.match(dt.interpretation!, /不按 UTC/);
});

test("RATIONAL：ExposureTime 保留分子分母并给出显示值", () => {
  const r = analyzeBuffer(buildExifJpeg("LE").buf);
  const e = r.tags.find((t) => t.tag === 0x829a)!;
  assert.deepEqual(e.value, [{ num: 1, den: 125 }]);
  assert.match(e.display!, /1\/125/);
});

test("非 EXIF 的 APP1 被跳过", () => {
  const fx = buildExifJpeg("LE");
  const r = analyzeBuffer(fx.buf);
  const app1s = r.segments.filter((s) => s.name === "APP1");
  assert.equal(app1s.length, 2);
  assert.equal(app1s.filter((s) => s.isExif).length, 1);
});

test("无 EXIF 的正常 JPEG 返回 no_metadata 而非损坏", () => {
  const r = analyzeBuffer(buildNoExifJpeg());
  assert.equal(r.status, "no_metadata");
  assert.equal(r.errors.length, 0);
});

test("缺少必需 TIFF 头（段过短）报 E_TRUNCATED", () => {
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe1, 0x00, 0x09]), // 数据 7 字节：Exif\0\0 + 1
    Buffer.from("Exif\0\0X", "latin1"),
    Buffer.from([0xff, 0xd9]),
  ]);
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_TRUNCATED");
});

test("段声明长度超出文件报 E_TRUNCATED", () => {
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0, 0x10, 0x00]),
    Buffer.alloc(4),
  ]);
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_TRUNCATED");
});

test("值偏移越界报 E_BAD_OFFSET 并给出偏移", () => {
  const fx = buildExifJpeg("LE");
  const buf = Buffer.from(fx.buf);
  // Make 条目值偏移字段（条目+8）改为巨大值
  const makePos = fx.positions.get(0x010f)!;
  buf.writeUInt16LE(0x7fff, makePos.entryOffset + 8);
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_BAD_OFFSET");
  assert.equal(r.errors[0].offset, makePos.entryOffset + 8);
});

test("坏 ExifIFD 指针（指向自身 IFD0）报 E_CYCLE", () => {
  const fx = buildExifJpeg("LE");
  const buf = Buffer.from(fx.buf);
  const ptr = fx.positions.get(0x8769)!;
  buf.writeUInt32LE(8, ptr.valueOffset); // 指回 IFD0（rel 8）
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_CYCLE");
});

test("零分母产生标签级诊断而非崩溃", () => {
  const r = analyzeBuffer(buildExifJpeg("LE", { zeroDenominator: true }).buf);
  assert.equal(r.status, "ok");
  const e = r.tags.find((t) => t.tag === 0x829a)!;
  assert.deepEqual(e.value, [{ num: 1, den: 0 }]);
  assert.ok(e.diagnostics.some((d) => d.includes("分母为零")));
  assert.match(e.display!, /无效/);
});

test("非法字节序标识报 E_BAD_ENDIAN", () => {
  const fx = buildExifJpeg("LE");
  const buf = Buffer.from(fx.buf);
  buf[fx.tiffStart] = 0x5a;
  buf[fx.tiffStart + 1] = 0x5a;
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_BAD_ENDIAN");
  assert.equal(r.errors[0].offset, fx.tiffStart);
});

test("非法大数量报 E_BAD_COUNT，不做无界分配", () => {
  const fx = buildExifJpeg("LE");
  const buf = Buffer.from(fx.buf);
  const makePos = fx.positions.get(0x010f)!;
  buf.writeUInt32LE(0xffffffff, makePos.entryOffset + 4);
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_BAD_COUNT");
});

test("未知字段类型被标注且不影响其他标签", () => {
  const fx = buildExifJpeg("LE");
  const buf = Buffer.from(fx.buf);
  const makePos = fx.positions.get(0x010f)!;
  buf.writeUInt16LE(99, makePos.entryOffset + 2); // 类型 99
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "ok");
  const make = r.tags.find((t) => t.tag === 0x010f)!;
  assert.equal(make.typeName, null);
  assert.ok(make.diagnostics.some((d) => d.includes("未知字段类型")));
  assert.equal(r.tags.find((t) => t.tag === 0x0110)!.display, "Model X");
});

test("非 JPEG 文件报 E_NOT_JPEG", () => {
  const r = analyzeBuffer(Buffer.from("not a jpeg at all"));
  assert.equal(r.status, "error");
  assert.equal(r.errors[0].code, "E_NOT_JPEG");
});

test("SOS 之后停止扫描，压缩数据中的 0xFF 字节不被误认为标记", () => {
  const buf = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xda, 0x00, 0x02]),
    Buffer.from([0xff, 0xe1, 0x00, 0x10]), // 像素数据里的假 APP1
    Buffer.from([0xff, 0xd9]),
  ]);
  const r = analyzeBuffer(buf);
  assert.equal(r.status, "no_metadata");
  assert.equal(r.segments[r.segments.length - 1].name, "SOS");
});
