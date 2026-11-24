// Runs the in-app assistant on Google's Gemini API instead of Claude's, for the free tier.
// assistant.js speaks in Anthropic Messages shapes; this turns a request into Gemini's generateContent shape and the
// answer back, so the same loop and tools work with either. No network in here: `post` is passed in (tests fake it).
'use strict';

// Gemini takes an OpenAPI-style subset of JSON Schema: keep types, descriptions, enums, properties, required, items.
function schema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const k of ['type', 'description', 'enum', 'required', 'format']) if (s[k] !== undefined) out[k] = s[k];
  if (s.properties) { out.properties = {}; for (const [n, v] of Object.entries(s.properties)) out.properties[n] = schema(v); }
  if (s.items) out.items = schema(s.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

function toolsFor(tools) {
  return [{ functionDeclarations: tools.map(t => {
    const p = schema(t.input_schema);
    const d = { name: t.name, description: t.description };
    if (p && Object.keys(p.properties || {}).length) d.parameters = p;
    return d;
  }) }];
}

// Anthropic-shaped { system, messages, tools } → Gemini generateContent body.
function toRequest({ system, messages, tools }) {
  const names = {}; // tool_use id → tool name (Gemini's functionResponse is matched by name)
  const contents = messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
    const parts = [];
    for (const b of m.content) {
      if (b.type === 'text') parts.push({ text: b.text, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      else if (b.type === 'tool_use') {
        names[b.id] = b.name;
        parts.push({ functionCall: { name: b.name, args: b.input || {} }, ...(b._sig ? { thoughtSignature: b._sig } : {}) });
      } else if (b.type === 'tool_result') {
        parts.push({ functionResponse: { name: names[b.tool_use_id] || 'tool', response: b.is_error ? { error: b.content } : { result: b.content } } });
      }
    }
    return { role, parts };
  });
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    tools: toolsFor(tools),
    generationConfig: { maxOutputTokens: 1024 }
  };
}

// Gemini response → Anthropic-shaped { stop_reason, content }. Thought signatures ride along as _sig so they go back
// exactly as received on the next call (Gemini 3 and later refuse a function-call history without them).
function fromResponse(r) {
  const cand = (r && r.candidates && r.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  let n = 0;
  const content = [];
  for (const p of parts) {
    if (p.thought) continue; // a thinking summary, not part of the answer
    const sig = p.thoughtSignature ? { _sig: p.thoughtSignature } : {};
    if (p.functionCall) content.push({ type: 'tool_use', id: `call_${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...sig });
    else if (typeof p.text === 'string') content.push({ type: 'text', text: p.text, ...sig });
    else if (sig._sig) content.push({ type: 'text', text: '', ...sig });
  }
  const blocked = !parts.length && (cand.finishReason === 'SAFETY' || (r && r.promptFeedback && r.promptFeedback.blockReason));
  if (blocked) content.push({ type: 'text', text: 'I can’t help with that one.' });
  return { stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content };
}

// A callModel for assistant.run. post(url, headers, body) → { ok, status, json }.
function caller({ key, model, post }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  return async req => {
    const res = await post(url, { 'content-type': 'application/json', 'x-goog-api-key': key }, toRequest(req));
    if (!res.ok) { const e = new Error(`Gemini ${res.status}`); e.status = res.status; e.body = res.json; throw e; }
    return fromResponse(res.json);
  };
}

module.exports = { toRequest, fromResponse, caller, schema };
