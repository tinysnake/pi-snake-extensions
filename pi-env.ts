import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (_pi: ExtensionAPI) {
  // 1. 读取 user / project 两级 pi-env.json
  const userPath = join(homedir(), ".pi", "agent", "pi-env.json");
  const projectPath = join(process.cwd(), ".pi", "pi-env.json");

  const userEnv = readEnvFile(userPath);
  const projectEnv = readEnvFile(projectPath);

  if (Object.keys(userEnv).length === 0 && Object.keys(projectEnv).length === 0) {
    return; // 无配置，不做任何事
  }

  // 2. 合并：project 覆盖 user
  const merged: Record<string, string | null> = { ...userEnv };
  for (const [key, value] of Object.entries(projectEnv)) {
    merged[key] = value;
  }

  // 3. 统一展开 ${VAR}（多轮，直到稳定）
  const expanded = expandEnvVars(merged);

  // 4. 写入 process.env
  for (const [key, value] of Object.entries(expanded)) {
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readEnvFile(path: string): Record<string, string | null> {
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // 文件不存在 / 解析失败 → 静默忽略
  }
  return {};
}

function expandEnvVars(
  merged: Record<string, string | null>,
): Record<string, string | null> {
  const result: Record<string, string | null> = { ...merged };

  // 标记被删除的 key（null / ""）
  const deleted = new Set<string>();
  for (const [key, value] of Object.entries(result)) {
    if (value === null || value === "") {
      deleted.add(key);
    }
  }

  // 多轮展开，解决交叉引用
  for (let pass = 0; pass < 10; pass++) {
    let changed = false;

    for (const [key, value] of Object.entries(result)) {
      if (value === null || value === "") continue;
      if (typeof value !== "string") continue;

      const expanded = value.replace(
        /\$\{([^}]+)\}/g,
        (_match: string, varName: string) => {
          if (deleted.has(varName)) return "";
          if (
            result[varName] !== undefined &&
            result[varName] !== null
          ) {
            return result[varName] as string;
          }
          if (process.env[varName] !== undefined) {
            return process.env[varName] as string;
          }
          return _match; // 保留原样
        },
      );

      if (expanded !== value) {
        result[key] = expanded;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // 被删除的 key 最终输出 null
  for (const key of deleted) {
    result[key] = null;
  }

  return result;
}
