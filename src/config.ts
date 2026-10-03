import path from "node:path";

export interface Config {
  /** 项目内数据目录（只写这里） */
  dataDir: string;
  filesDir: string;
  dbPath: string;
  /** 0 表示自动选择空闲端口 */
  port: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.EXIF_DATA_DIR ?? path.join(process.cwd(), "data"));
  return {
    dataDir,
    filesDir: path.join(dataDir, "files"),
    dbPath: path.join(dataDir, "exif.db"),
    port: env.PORT ? Number(env.PORT) : 0,
  };
}
