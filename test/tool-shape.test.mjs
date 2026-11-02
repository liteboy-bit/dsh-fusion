import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldMapToJsonSchema, jsonOutput, TEXT_OUTPUT_SCHEMA } from "../lib/tool-shape.mjs";
import { defineTools } from "../lib/tools.mjs";

test("字段表编译成 JSON Schema：required 单独成数组，不是字段里的布尔", () => {
  const schema = fieldMapToJsonSchema({
    task_id: { type: "string", required: true, description: "任务 id" },
    changed_paths: { type: "array", items: { type: "string" }, description: "改动路径" },
  });
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["task_id"]);
  assert.equal(schema.properties.task_id.required, undefined, "required 不该留在字段里");
  assert.equal(schema.properties.changed_paths.items.type, "string");
  assert.equal(schema.properties.task_id.description, "任务 id");
});

test("没有必填字段时不出 required 键（空数组会让某些校验器以为是「全不填」）", () => {
  assert.equal("required" in fieldMapToJsonSchema({}), false);
  assert.deepEqual(fieldMapToJsonSchema(), { type: "object", properties: {}, additionalProperties: false });
});

test("怪输入不炸：null / 非对象 / 字段表里的怪值都退化成空 schema 节点", () => {
  assert.equal(fieldMapToJsonSchema(null).type, "object");
  assert.equal(fieldMapToJsonSchema("abc").properties.x, undefined);
  const s = fieldMapToJsonSchema({ x: "not-an-object", y: null });
  assert.deepEqual(s.properties.x, {});
  assert.deepEqual(s.properties.y, {});
});

test("output 声明：必须有 schema 和 render，render 把值原样 JSON 化（不截断）", () => {
  const out = jsonOutput();
  assert.equal(out.schema, TEXT_OUTPUT_SCHEMA);
  const long = { text: "很长".repeat(500) };
  const parts = out.render({}, long);
  assert.deepEqual(parts, [{ type: "text", text: JSON.stringify(long) }]);
  assert.equal(JSON.parse(parts[0].text).text.length, 1000, "一个字都不许丢");
});

test("红线：四个工具都必须带 output.schema + output.render，且参数是 object 根", () => {
  // 这条是回归测试：dsh-tools 的 register() 会因缺 output 直接抛
  // `tool "X" must declare output { schema, render }`，症状只是「1 entry did not activate」。
  const noop = () => [];
  const tools = defineTools({ allTasks: noop, allMembers: noop, roleOf: () => undefined });
  assert.equal(tools.length, 4);
  for (const t of tools) {
    assert.equal(typeof t.name, "string");
    assert.equal(typeof t.execute, "function");
    assert.equal(t.parameters.type, "object", `${t.name} 的参数根必须是 object`);
    assert.equal(t.parameters.additionalProperties, false, `${t.name} 不该接受未声明参数`);
    assert.equal(typeof t.output?.schema, "object", `${t.name} 缺 output.schema`);
    assert.equal(typeof t.output?.render, "function", `${t.name} 缺 output.render`);
    assert.equal(t.output.schema.type, "object", `${t.name} 的输出根必须是 object`);
  }
});

test("输出 schema 只用了 dsh 支持的子集关键字（type/oneOf/properties/required/additionalProperties/items/enum/const）", () => {
  const allowed = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title"]);
  const walk = (node, path) => {
    if (node === null || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      assert.ok(allowed.has(key), `${path}.${key} 不在支持子集里`);
      if (key === "properties") for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.properties.${k}`);
      else if (key === "items") walk(node.items, `${path}.items`);
    }
  };
  walk(jsonOutput().schema, "output.schema");
  for (const t of defineTools({ allTasks: () => [], allMembers: () => [], roleOf: () => undefined })) {
    walk(t.parameters, `${t.name}.parameters`);
  }
});
