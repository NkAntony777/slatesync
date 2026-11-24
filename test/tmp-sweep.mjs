/**
 * 独立清扫器：把「超过 N 小时的同类临时目录」删掉。
 *
 * 默认只扫项目内 <repo>/.tmp/；历史 C 盘（os.tmpdir()）那批残留要显式加 --legacy。
 * 每删一个目录记一行进 <repo>/.tmp/sweep-ledger.jsonl（append-only），便于与并行
 * 清理任务对账（避免两边删同一批目录却对不上账）。
 *
 * 用法：
 *   node test/tmp-sweep.mjs               # 只扫项目内 .tmp/
 *   node test/tmp-sweep.mjs --legacy      # 连系统 TEMP（C 盘）一起扫
 *   node test/tmp-sweep.mjs --hours 12    # 改阈值（默认 6 小时）
 */
import { sweepStaleTempDirs, TMP_ROOT } from "./tmp-store.mjs";

const args = process.argv.slice(2);
const legacy = args.includes("--legacy");
const hoursIdx = args.indexOf("--hours");
const hours = hoursIdx >= 0 ? Number(args[hoursIdx + 1]) : undefined;

const result = sweepStaleTempDirs({ legacy, hours });
process.stdout.write(JSON.stringify({ tmpRoot: TMP_ROOT, ...result }, null, 2) + "\n");
