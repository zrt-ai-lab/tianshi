/**
 * 从 profile 的 cordis.patch.yml 读取默认对话模型
 *
 * 只读 `agent-default-model` 那一段的 provider / model，避免误读到其他段落。
 * 模型 id 可能带斜杠（如 anthropic/claude-opus-5.5-cpr、deepseek/deepseek-v4.1-flash），
 * 必须整段读取，不能在斜杠处截断。
 */
export function parseDefaultModel(yml) {
  const text = String(yml ?? '');
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*-\s*id:\s*["']?agent-default-model["']?\s*$/.test(l));
  if (start < 0) return null;
  let provider = null;
  let model = null;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s*id:/.test(lines[i])) break; // 下一段
    const pm = lines[i].match(/^\s*provider:\s*["']?([^"'#\s]+)["']?/);
    const mm = lines[i].match(/^\s*model:\s*["']?([^"'#\s]+)["']?/);
    if (pm && !provider) provider = pm[1];
    if (mm && !model) model = mm[1];
  }
  return provider && model ? { provider, model } : null;
}
