import Anthropic from '@anthropic-ai/sdk';
import { all, getSettings } from '../db.js';
import { config } from '../config.js';

// AI auto-replies with Google Gemini (Free) or Claude.
// API keys come from Automations & AI (or GEMINI_API_KEY / ANTHROPIC_API_KEY).

let cachedAnthropic = { key: null, client: null };
function getAnthropicClient(apiKey) {
  if (cachedAnthropic.key !== apiKey) {
    cachedAnthropic = { key: apiKey, client: new Anthropic({ apiKey, maxRetries: 2, timeout: 60000 }) };
  }
  return cachedAnthropic.client;
}

export function detectProvider(s = {}) {
  if (s.provider === 'gemini' || s.provider === 'anthropic') return s.provider;
  if (s.apiKey?.startsWith('AIza') || s.model?.startsWith('gemini')) return 'gemini';
  if (s.apiKey?.startsWith('sk-ant-') || s.model?.startsWith('claude')) return 'anthropic';
  return 'gemini'; // Default to free Google Gemini
}

export function aiConfig() {
  const s = getSettings('ai');
  const provider = detectProvider(s);
  const defaultKey = provider === 'gemini' ? (config.geminiKey || config.anthropicKey) : (config.anthropicKey || config.geminiKey);
  return { ...s, provider, apiKey: s.apiKey || defaultKey };
}

function buildSystem(s, businessName) {
  const parts = [
    s.persona,
    `Business name: ${businessName}.`,
    'You are replying inside WhatsApp. Use plain text (WhatsApp supports *bold* and _italic_), no markdown headings or tables.',
    'Never invent prices, order numbers, dates or policies that are not in the knowledge base. If the customer asks for something you cannot answer or wants a human, reply that a team member will get back to them shortly.',
  ];
  if (s.knowledge?.trim()) parts.push(`Knowledge base:\n${s.knowledge.trim()}`);
  return parts.join('\n\n');
}

// Turn the stored conversation into alternating user/assistant turns (the API needs the first to be user).
function historyFor(conversationId, limit = 16) {
  const rows = all(
    `SELECT direction, type, body FROM messages
      WHERE conversation_id = ? AND status != 'failed'
      ORDER BY id DESC LIMIT ?`,
    conversationId,
    limit,
  ).reverse();
  const turns = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const text = (r.body && r.body.trim()) || `[${r.type}]`;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += `\n${text}`;
    else turns.push({ role, content: text });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns;
}

async function generateGeminiReply(s, general, messages) {
  const model = s.model && s.model.startsWith('gemini') ? s.model : 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.apiKey)}`;

  const systemText = buildSystem(s, general.businessName);
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content || '' }],
  }));

  const payload = {
    system_instruction: {
      parts: [{ text: systemText }],
    },
    contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    },
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(60000),
    });

    const data = await res.json();
    if (!res.ok) {
      const msg = data?.error?.message || `Gemini API error (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const candidate = data.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') return null;
    const text = candidate?.content?.parts?.map((p) => p.text).join('').trim();
    return text || null;
  } catch (e) {
    let reason = e?.message || 'Gemini request failed';
    if (reason.includes('API_KEY_INVALID') || reason.includes('API key not valid')) {
      reason = 'Google Gemini API key is invalid. Get a free key at aistudio.google.com.';
    } else if (reason.includes('RESOURCE_EXHAUSTED')) {
      reason = 'Gemini free rate limit reached — please try again in a few moments.';
    }
    throw Object.assign(new Error(reason), { status: 502 });
  }
}

async function generateClaudeReply(s, general, messages) {
  try {
    const response = await getAnthropicClient(s.apiKey).beta.messages.create({
      model: s.model && s.model.startsWith('claude') ? s.model : 'claude-sonnet-5-5',
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: s.effort || 'low' },
      system: buildSystem(s, general.businessName),
      messages,
    });
    if (response.stop_reason === 'refusal') return null;
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return text || null;
  } catch (e) {
    let reason = e?.message || 'AI request failed';
    if (e instanceof Anthropic.AuthenticationError) reason = 'Anthropic API key is invalid.';
    else if (e instanceof Anthropic.RateLimitError) reason = 'Anthropic rate limit reached — try again shortly.';
    else if (e instanceof Anthropic.BadRequestError) reason = `AI request rejected: ${e.message}`;
    else if (e instanceof Anthropic.APIConnectionError) reason = 'Could not reach the Anthropic API.';
    throw Object.assign(new Error(reason), { status: e?.status || 502 });
  }
}

export async function generateReply({ conversationId, messages: directMessages, overrides = {} }) {
  const s = { ...aiConfig(), ...overrides };
  const provider = detectProvider(s);
  if (!s.apiKey) {
    const name = provider === 'gemini' ? 'Google Gemini (free at aistudio.google.com)' : 'Anthropic Claude';
    throw Object.assign(new Error(`Add your ${name} API key in Automations & AI.`), { status: 400 });
  }
  const general = getSettings('general');
  const messages = directMessages || historyFor(conversationId);
  if (!messages.length || messages[messages.length - 1].role !== 'user') return null;

  if (provider === 'gemini') {
    return await generateGeminiReply(s, general, messages);
  }
  return await generateClaudeReply(s, general, messages);
}
