/**
 * 测试临时目录清理钩子装配（被各测试文件 import 即生效）。
 *
 * ⚠ 临时目录纪律（2026-11-24 修，见 docs/测试临时目录泄漏修复.md）
 * ============================================================================
 * 泄漏根因：test/write-backup.test.mjs 曾往 **os.tmpdir()（C 盘系统 TEMP）** 丢
 * `mkdtempSync(..., "slatesync-backup-")` 目录，而且**从来没有删除逻辑**——
 * 不是「异常路径没走 finally」，是压根没写清理。于是每跑一次全量测试就再攒一批
 * （实测历史累积 195 个目录 / 2.130 GB）。
 *
 * 三条修法（缺一不可）：
 *   ① **测试结束必删**（正常结束 / 断言失败 / 异常抛出 / 进程提前退出都要删）：
 *      目录登记在册，四道钩子覆盖全部退出路径 ——
 *      afterEach（用例级）/ after（文件级）/ process 'exit' /
 *      SIGINT·SIGTERM·SIGHUP。
 *   ② **临时工作目录不落 C 盘系统 TEMP**：改到**项目内** <repo>/.tmp/（D 盘）。
 *      这是根本修法——即使清理失败也不会撑爆系统盘。
 *   ③ **进程启动时清扫过期残留**：删掉超过 N 小时（默认 6h）的同类旧目录，
 *      防止「上次跑崩了」的残留永久占盘，并落 append-only 台账。
 *
 * 目录/文件的实际存取逻辑在 test/tmp-store.mjs（纯逻辑，无副作用），
 * 本文件只负责：装钩子 + 进程启动清扫。
 */
import { after, afterEach } from "node:test";

import {
  STALE_TMP_HOURS,
  TMP_ROOT,
  bootstrapTempDirs,
  cleanupTempDirs,
  installProcessHooks,
  makeTempDir,
  makeTempFile,
  removeTree,
  sweepStaleTempDirs,
} from "./tmp-store.mjs";

export {
  STALE_TMP_HOURS,
  TMP_ROOT,
  bootstrapTempDirs,
  cleanupTempDirs,
  installProcessHooks,
  makeTempDir,
  makeTempFile,
  removeTree,
  sweepStaleTempDirs,
};

// ① 兜底 A：exit + 三个信号（覆盖进程提前退出 / Ctrl+C / 被 kill）。
// ③ 兜底：启动时清扫超过 N 小时的旧同类临时目录（默认只扫项目内 .tmp/）。
bootstrapTempDirs();

// ① 兜底 B：node:test 用例级 + 文件级钩子（覆盖正常结束 / 断言失败 / 异常抛出）。
// 钩子装在被 import 的测试文件上 ⇒ 那里每个用例跑完就删本用例建的临时目录；
// 文件级 "file" 作用域夹具由 after 钩子删（afterEach 不动，避免中途被删掉）。
try {
  afterEach(() => {
    cleanupTempDirs("test");
  });
  after(() => {
    cleanupTempDirs("all");
  });
} catch {
  /* 不在 node:test 上下文里（当作普通脚本跑）→ 只靠 exit + 信号钩子兜底 */
}
