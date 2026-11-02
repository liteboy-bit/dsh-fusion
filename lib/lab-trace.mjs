/**
 * 探索期的「热重载见证器」。
 *
 * 为什么需要它：dsh-hmr 重载模块时不一定在 stderr 留下痕迹，而 ctx.logger 的去向取决于宿主。
 * 要回答「改一行源码到底有没有立刻生效」，唯一可靠的证据是**进程外的、可 diff 的痕迹**。
 * 所以：设了环境变量 DSH_FUSION_TRACE=<文件路径> 时，每次 apply() 都往那个文件追加一行；
 * 没设就什么都不做（默认零副作用、零 IO）。
 *
 * 这一层是给实验台用的，不是产品行为：正式环境不设这个变量即可完全关闭。
 */

import { appendFileSync } from "node:fs";

/** @param {Record<string, unknown>} facts */
export function trace(facts, env = process.env) {
  const target = env.DSH_FUSION_TRACE;
  if (!target) return false;
  try {
    appendFileSync(target, `${new Date().toISOString()} ${JSON.stringify(facts)}\n`, "utf8");
    return true;
  } catch {
    // 见证器坏了不影响插件：静默。
    return false;
  }
}

