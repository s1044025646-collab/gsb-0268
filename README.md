# JPEG EXIF 标签解析与偏移诊断后端

本地可运行的 JPEG 照片元数据检查服务（TypeScript + Node.js + SQLite），只提供 API 与 CLI，无前端。
**只读**文件并解释 EXIF：不解码像素、不旋转图片、不修改标签、不访问网络照片。

## 运行要求

- Windows 本地，Node.js >= 22（使用内置 `node:sqlite`，无原生依赖、无 Docker/WSL/外部服务）
- `npm install` 一次即可（仅开发依赖 typescript / @types/node）

## 命令

```bat
npm run build        :: 编译 TypeScript 到 dist/
npm test             :: 构建并运行全部测试（node:test）
npm start            :: 构建并启动 API（默认自动选择空闲端口）
npm run demo         :: 生成可重建合成演示文件并导入（data/demo/）
node dist/src/cli.js <命令>   :: CLI（也可用 npm run cli -- <命令>）
```

CLI 命令：`import <路径>`、`list`、`segments <id>`、`tags <id>`、`explain <id> <标签>`、
`report <id>`、`export <id> [文件]`、`serve [--port N]`、`demo`。

## API（默认端口 0 = 自动选空闲端口，可用 `--port` 或环境变量 `PORT` 指定）

- `POST /api/files/import`  body: `{"path": "本地文件路径"}` → 导入（只读复制到数据目录）
- `GET  /api/files` → 已导入文件列表
- `GET  /api/files/:id/segments` → JPEG 段清单
- `GET  /api/files/:id/tags` → 标签查询（编号、类型、数量、原始值、字节区间、解释）
- `GET  /api/files/:id/explain/<序号|0xXXXX>` → 逐条偏移解释
- `GET  /api/files/:id/report` → 完整解析报告
- `GET  /api/files/:id/export` → JSON 导出（attachment）

错误统一为 `{"error": {"code": "...", "message": "..."}}`，解析错误附带
`segmentOffset` / `fileOffset` 定位。主要错误码：`NOT_JPEG`、`TRUNCATED`、
`BAD_BYTE_ORDER`、`BAD_TIFF_HEADER`、`OFFSET_OUT_OF_RANGE`、`ENTRY_OUT_OF_RANGE`、
`VALUE_OUT_OF_RANGE`、`COUNT_TOO_LARGE`、`UNKNOWN_TYPE`、`POINTER_CYCLE`、
`LIMIT_EXCEEDED`、`ZERO_DENOMINATOR`、`ORIENTATION_INVALID`、`FILE_NOT_FOUND`、
`BAD_REQUEST`、`NOT_FOUND`。

## 支持的子集（明确边界）

- JPEG 标记扫描：识别以 `Exif\0\0` 开头的 APP1；非 EXIF 的 APP1（如 XMP）跳过；
  遇到 SOS 即停止，不会把压缩扫描数据中的 `0xFF` 字节误认为标记。
- TIFF 头：两种字节序（II/MM）、魔数 42、IFD0 偏移。
- 目录：IFD0 + 由 ExifIFD 指针（0x8769）指向的**一个**子目录。
  **不展开** GPS、MakerNote、缩略图 IFD；不宣称支持完整 TIFF 或全部 EXIF。
- 字段类型：BYTE、ASCII、SHORT、LONG、RATIONAL 五类；未知类型明确标注为 `UNKNOWN(n)`。
- 值读取：`类型长度 × 数量` ≤ 4 字节时取条目内联值，否则按**相对 TIFF 起点**的偏移读取
  （绝不按 JPEG 文件起点解引用；数量是元素个数，不是字节数）。
- 安全上限：段数、每条目数量、单值字节数、每目录条目数均有限制；
  非法大数量、截断、越界只产生诊断，不引发无界分配；IFD 指针循环被拒绝。

## 标签解释边界

- 解释 `Orientation`、`Make`、`Model`、`DateTime`、`DateTimeOriginal`、
  `PixelXDimension`、`PixelYDimension`、`ExposureTime`。
- `Orientation` 限定 1–8，显示其变换含义（如“顺时针旋转 90° 显示”），**不实际变换图片**。
- 日期保留原始文本，**不擅自当作 UTC 或任何时区**解析。
- `ExposureTime` 保留分子/分母并给出显示值（如 `1/125 s`）；分母为零给出 `ZERO_DENOMINATOR` 诊断。

## 存储与数据目录

- 数据目录默认为项目内 `data/`（可用环境变量 `EXIF_DATA_DIR` 覆盖），只写该目录。
- SQLite（`data/exif.db`）保存：文件 SHA-256 摘要、只读副本位置（`data/files/<sha256>.jpg`）、
  解析器版本、状态与完整报告；服务重启后既有记录可查询。
- 同一文件重复导入行为固定：按内容摘要去重，返回既有记录并标记 `duplicate: true`，
  不产生新记录；解析失败的文件状态为 `error`，绝不会产生正常（ok）报告。
- 无 EXIF 的正常 JPEG 返回 `no_exif` 状态，不算文件损坏。

## 测试与演示

- 测试夹具（`src/fixtures.ts`）逐字节构造合成 JPEG，布局确定；
  测试中的预期标签与字节位置为**预先写定的常量**，不是用序列化器互相验证。
- 覆盖：两种字节序（同一组标签语义一致）、内联 SHORT、外置 ASCII、RATIONAL、
  非 EXIF APP1、无 EXIF、缺少 TIFF 头、错误长度（截断）、偏移越界、坏指针（循环）、
  零分母、非法大数量、未知类型、非 JPEG 输入。
- `npm run demo` 生成 6 个演示文件（正常 II/MM、无 EXIF、零分母、坏偏移、坏魔数）并导入，
  可直接用 CLI/API 查看损坏文件的具体错误位置。

## 限制

- 仅 EXIF APP1 子集；不支持 GPS/MakerNote/缩略图、IPTC、XMP 内容解析。
- 不验证 JPEG 压缩数据本身的完整性（SOS 之后不解析）。
- `node:sqlite` 在 Node 25 仍为实验特性（启动时有 ExperimentalWarning，不影响功能）。
