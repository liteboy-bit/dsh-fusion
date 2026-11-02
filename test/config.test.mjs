import { test } from "node:test";
import assert from "node:assert/strict";
import { Config, DEFAULTS, normalizeConfig } from "../lib/config.mjs";

const validate = (v) => Config["~standard"].validate(v);

test("形状：cordis 4 只认 `~standard.validate`，普通对象会让 entry 不激活", () => {
  assert.deepEqual(Object.keys(Config), ["~standard"]);
  assert.equal(Config["~standard"].version, 1);
  assert.equal(Config["~standard"].vendor, "dsh-fusion");
  const result = validate(undefined);
  assert.equal("then" in result, false, "异步校验 cordis 直接拒绝");
  assert.equal(result.issues, undefined, "永不返回 issues——配置错不该让板子消失");
  assert.deepEqual(result.value, { ...DEFAULTS });
});

test("空/怪输入全部回默认值，不抛", () => {
  for (const input of [undefined, null, 0, "", "abc", [], true, () => {}]) {
    assert.deepEqual(normalizeConfig(input), { ...DEFAULTS }, `输入 ${String(input)}`);
  }
});

test("数字夹紧到合法区间：窗口太短不行，采样太密等于轮询", () => {
  assert.equal(normalizeConfig({ windowMs: 1 }).windowMs, 10_000);
  assert.equal(normalizeConfig({ windowMs: 999_999_999 }).windowMs, 3_600_000);
  assert.equal(normalizeConfig({ sampleMs: 1 }).sampleMs, 1_000);
  assert.equal(normalizeConfig({ sampleMs: 10 ** 9 }).sampleMs, 600_000);
  // YAML 里写成字符串是常事
  assert.equal(normalizeConfig({ windowMs: "300000" }).windowMs, 300_000);
  assert.equal(normalizeConfig({ sampleMs: 3_500.7 }).sampleMs, 3_501, "取整而不是丢小数");
});

test("布尔只认真正的布尔：写错就回默认值，不猜", () => {
  assert.equal(normalizeConfig({ advise: false }).advise, false);
  assert.equal(normalizeConfig({ advise: "false" }).advise, true, "字符串不当真值解析");
  assert.equal(normalizeConfig({ tools: 0 }).tools, true);
});

test("未知字段被丢掉，且幂等", () => {
  const once = normalizeConfig({ windowMs: 600_000, 让谁当队长: "?" });
  assert.deepEqual(Object.keys(once).sort(), ["advise", "sampleMs", "tools", "windowMs"]);
  assert.deepEqual(normalizeConfig(once), once);
});
