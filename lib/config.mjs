/**
 * 插件配置：以 standard-schema 表达（cordis 4 的契约）。
 *
 * 源码依据：`@deepseek-ai/cordis@4.0.5-alpha.1` lib/index.js resolveConfig()：
 *   if (!runtime.Config) return config;
 *   const result = runtime.Config["~standard"].validate(config);   // L958
 *   if (result.issues) throw new ValidationError(result.issues);
 *   else return result.value;
 * 也就是说 Config 不是一个普通对象，必须带 `~standard.validate`。
 * 之前写成普通对象，后果是 boot 时 `Cannot read properties of undefined (reading 'validate')`
 * → 整个 entry 不激活（dsh 只报一句 "1 entry did not activate"）。
 *
 * 本文件的两条取舍：
 *  1. validate **永不返回 issues**。配置写错不该让整张板子从会话里消失——
 *     队伍里谁手抖写了个负数，正确反应是夹紧到合法区间并继续工作，不是让插件死掉。
 *     越权硬拦、格式软提醒，这条规矩对配置自己也一样。
 *  2. 夹紧而不是加字段。窗口不够长不许下结论，所以 windowMs 有下界；
 *     采样太密会变成轮询，所以 sampleMs 有下界。
 */

/** 默认值：与 cordis.patch.yml 里写的一致，改一处就够。 */
export const DEFAULTS = Object.freeze({
  /** 观察窗（毫秒）。短于它不下结论。 */
  windowMs: 360_000,
  /** 采样间隔（毫秒）。 */
  sampleMs: 30_000,
  /** 是否把判定写进一行提示。关掉就只剩审计。 */
  advise: true,
  /** 是否注册 fusion_board / fusion_can / fusion_plan 四个只读工具。 */
  tools: true,
});

const BOUNDS = Object.freeze({
  windowMs: { min: 10_000, max: 3_600_000 },
  sampleMs: { min: 1_000, max: 600_000 },
});

/** 数字就取数字，字符串数字也认（YAML 里常写成 "30000"），其余一律回默认值。 */
function boundedInt(value, key) {
  const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return DEFAULTS[key];
  const { min, max } = BOUNDS[key];
  return Math.min(max, Math.max(min, Math.round(raw)));
}

function boundedBool(value, key) {
  return typeof value === "boolean" ? value : DEFAULTS[key];
}

/**
 * 把任意输入收敛成合法配置。幂等：normalize(normalize(x)) === normalize(x)。
 * @param {unknown} raw
 * @returns {{windowMs:number, sampleMs:number, advise:boolean, tools:boolean}}
 */
export function normalizeConfig(raw) {
  const src = raw !== null && typeof raw === "object" ? raw : {};
  return {
    windowMs: boundedInt(src.windowMs, "windowMs"),
    sampleMs: boundedInt(src.sampleMs, "sampleMs"),
    advise: boundedBool(src.advise, "advise"),
    tools: boundedBool(src.tools, "tools"),
  };
}

/** cordis 认的 Config：只靠 `~standard`，不引入任何依赖。 */
export const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-fusion",
    validate(value) {
      return { value: normalizeConfig(value) };
    },
  },
};
