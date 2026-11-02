/**
 * 工具声明的形状适配层。
 *
 * 为什么需要它——两次真实踩坑，都是「文档没写但源码在抛」：
 *
 * 1. `@deepseek-ai/dsh-tools` lib/index.js L2876 `register(definition)`：
 *      const output = definition.output;
 *      if (output === void 0 || typeof output !== "object" || typeof output.render !== "function")
 *        throw new TypeError(`tool "X" must declare output { schema, render, presentationMeta? }`);
 *    也就是说只给 name/description/parameters/execute 是不够的，**必须给 output**。
 *    症状很隐蔽：cordis 只报一句 "1 entry did not activate"。
 *
 * 2. 同一个包里 `defineTool()` L838 收的是**字段表**（`{name: {type, required, description}}`），
 *    它会用 parameterSchemaSpecToJsonSchema 编译成 JSON Schema 再交给 register。
 *    register 自身不编译。所以直接给字段表 = 模型收到一份不是 JSON Schema 的参数定义。
 *    这里补上编译这一步，让两边的形状对齐。
 *
 * 3. `assertSupportedJsonSchema` L323 + checkSchemaNode L163 只认
 *    type / oneOf / properties / required / additionalProperties / items / enum / const + 注解。
 *    所以输出 schema 刻意写得很朴素：object + additionalProperties。
 */

/** 输出一律「一个对象，里面自带 text」。loud 但不花哨：模型读 text，前端读 JSON。 */
export const TEXT_OUTPUT_SCHEMA = Object.freeze({ type: "object", additionalProperties: true });

/**
 * register 认的 output 声明。与 dsh-experimental-tool-agent-team 里的 jsonOutput() 同款：
 * render 返回 content parts 数组，把值原样 JSON 化——不截断、不改写。
 * @param {Record<string, unknown>} [schema]
 */
export function jsonOutput(schema = TEXT_OUTPUT_SCHEMA) {
  return {
    schema,
    render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
  };
}

/** 把 items 里的字段表继续编译下去（数组元素的形状）。 */
function compileValueSpec(spec) {
  if (spec === null || typeof spec !== "object") return {};
  const node = {};
  if (typeof spec.type === "string") node.type = spec.type;
  if (Array.isArray(spec.enum)) node.enum = [...spec.enum];
  if (spec.const !== undefined) node.const = spec.const;
  if (typeof spec.description === "string") node.description = spec.description;
  if (spec.items !== undefined) node.items = compileValueSpec(spec.items);
  return node;
}

/**
 * 字段表 → JSON Schema（object 根）。`required: true` 的字段进 required 数组。
 * 未知键忽略，不猜。
 * @param {Record<string, any>} [fields]
 * @returns {{type:"object", properties:Record<string,unknown>, additionalProperties:false, required?:string[]}}
 */
export function fieldMapToJsonSchema(fields = {}) {
  const properties = {};
  const required = [];
  const source = fields !== null && typeof fields === "object" ? fields : {};
  for (const [name, spec] of Object.entries(source)) {
    properties[name] = compileValueSpec(spec);
    if (spec?.required === true) required.push(name);
  }
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}
