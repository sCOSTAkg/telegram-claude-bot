'use strict';

const MODEL_MAP = {
  // Anthropic
  'claude-opus': 'claude-opus-4-6',
  'claude-sonnet': 'claude-sonnet-4-6-20250514',
  'claude-haiku': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
  'claude-opus-4': 'claude-opus-4-20250514',
  'claude-sonnet-4': 'claude-sonnet-4-20250514',
  'claude-3-7-sonnet': 'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet': 'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku': 'claude-3-5-haiku-20241022',
  // Google CLI
  'gemini-cli': 'gemini-cli',
  // Codex CLI
  'codex-cli': 'codex-cli',
  'codex-cli-o3': 'codex-cli-o3',
  'codex-cli-o4': 'codex-cli-o4',
  // OpenAI
  'gpt-5.2': 'gpt-5.2',
  'gpt-4.1': 'gpt-4.1',
  'gpt-4.1-mini': 'gpt-4.1-mini',
  'gpt-4.1-nano': 'gpt-4.1-nano',
  'o3': 'o3',
  'o4-mini': 'o4-mini',
  'o1': 'o1',
  'o3-mini': 'o3-mini',
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'codex': 'codex-mini-latest',
  'codex-latest': 'codex-mini-latest',
  'codex-mini': 'codex-mini-latest',
  'codex-mini-latest': 'codex-mini-latest',
  'gpt-5-codex': 'gpt-5-codex',
  'gpt-5.3-codex': 'gpt-5.3-codex',
  // Google Gemini (актуальные модели, март 2026)
  'gemini-3.1-pro-preview': 'gemini-3.1-pro-preview',
  'gemini-3.1-pro-preview-customtools': 'gemini-3.1-pro-preview-customtools',
  'gemini-3.1-flash-lite-preview': 'gemini-3.1-flash-lite-preview',
  'gemini-3-flash-preview': 'gemini-3-flash-preview',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'gemini-2.5-flash-lite': 'gemini-2.5-flash-lite',
  // Groq (проверенные на март 2026)
  'llama-3.3-70b-versatile': 'llama-3.3-70b-versatile',
  'llama-3.1-70b': 'llama-3.1-70b-versatile',
  'llama-3.1-8b': 'llama-3.1-8b-instant',
  'llama-3.2-1b': 'llama-3.2-1b-preview',
  'llama-3.2-3b': 'llama-3.2-3b-preview',
  'mixtral-8x7b': 'mixtral-8x7b-32768',
  'gemma2-9b': 'gemma2-9b-it',
  'deepseek-r1-distill-llama-70b': 'deepseek-r1-distill-llama-70b',
  'deepseek-r1-distill-qwen-32b': 'deepseek-r1-distill-qwen-32b',
  // OpenRouter (включая GPT-OSS и Kimi)
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'kimi-k2': 'moonshotai/kimi-k2-instruct',
  'kimi-k2-0905': 'moonshotai/kimi-k2-instruct-0905',
  'llama-4-maverick': 'meta-llama/llama-4-maverick-17b-128e-instruct',
  'llama-4-scout': 'meta-llama/llama-4-scout-17b-16e-instruct',
  'qwen3-32b': 'qwen/qwen3-32b',
  'groq-compound': 'groq/compound',
  'allam-7b': 'allam-2-7b',
  // DeepSeek (V3.2)
  'deepseek-chat': 'deepseek-chat',
  'deepseek-reasoner': 'deepseek-reasoner',
  // Ollama (local)
  'ollama-llama3.2': 'llama3.2',
  'ollama-qwen2.5': 'qwen2.5',
};
const PROVIDER_MODELS = {
  anthropic: [
    { id: 'claude-opus', label: 'Opus 4.6 ✨' },
    { id: 'claude-sonnet', label: 'Sonnet 4.6' },
    { id: 'claude-haiku', label: 'Haiku 4.5 ⚡' },
    { id: 'claude-3-7-sonnet', label: 'Claude 3.7 Sonnet' },
    { id: 'claude-3-5-sonnet', label: 'Claude 3.5 Sonnet' },
  ],
  'google-cli': [
    { id: 'gemini-cli', label: 'Gemini CLI ✨' },
  ],
  'codex-cli': [
    { id: 'codex-cli', label: 'Codex CLI (auto) ✨' },
    { id: 'codex-cli-o3', label: 'Codex CLI o3 ⚡' },
  ],
  openai: [
    { id: 'gpt-5.2', label: 'GPT-5.2 ✨' },
    { id: 'gpt-4.1', label: 'GPT-4.1' },
    { id: 'o3', label: 'o3 Reasoning ✨' },
    { id: 'o4-mini', label: 'o4-mini Reasoning ⚡' },
    { id: 'o1', label: 'o1 Reasoning' },
  ],
  google: [
    { id: 'gemini-3.1-pro-preview', label: '3.1 Pro Preview' },
    { id: 'gemini-3.1-flash-lite-preview', label: '3.1 Flash Lite ⚡' },
    { id: 'gemini-2.5-pro', label: '2.5 Pro ✨' },
    { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  ],
  deepseek: [
    { id: 'deepseek-chat', label: 'DeepSeek V3.2 🐳' },
    { id: 'deepseek-reasoner', label: 'DeepSeek R1 V3.2 🧠' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B' },
    { id: 'llama-3.1-70b', label: 'Llama 3.1 70B' },
    { id: 'llama-3.1-8b', label: 'Llama 3.1 8B ⚡' },
    { id: 'llama-3.2-3b', label: 'Llama 3.2 3B' },
    { id: 'llama-3.2-1b', label: 'Llama 3.2 1B' },
    { id: 'deepseek-r1-distill-llama-70b', label: 'DeepSeek R1 70B' },
    { id: 'deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 Qwen 32B' },
    { id: 'mixtral-8x7b', label: 'Mixtral 8x7B' },
    { id: 'gemma2-9b', label: 'Gemma2 9B' },
  ],
  openrouter: [
    { id: 'gpt-oss-120b', label: 'GPT-OSS 120B 🌌' },
    { id: 'kimi-k2', label: 'Kimi K2 🌙' },
    { id: 'llama-4-maverick', label: 'Llama 4 Maverick ✨' },
    { id: 'qwen3-32b', label: 'Qwen3 32B' },
    { id: 'allam-7b', label: 'Allam 7B' },
  ],
  ollama: [
    { id: 'ollama-llama3.2', label: 'Llama 3.2 (local) 🦙' },
    { id: 'ollama-qwen2.5', label: 'Qwen 2.5 (local) 🦙' },
  ],
};
const PROVIDER_LABELS = { anthropic: '🟣 Anthropic', 'google-cli': '🔵 Google (CLI)', 'codex-cli': '🛠️ Codex CLI', openai: '🟢 OpenAI', google: '🔵 Google', groq: '⚡ Groq', openrouter: '🌌 OpenRouter', deepseek: '🐳 DeepSeek', ollama: '🦙 Ollama' };
const IMAGE_MODELS = {
  'nano-banana': { id: 'gemini-2.5-flash-preview-image-generation', label: 'Nano Banana', desc: 'Быстрая генерация' },
  'nano-banana-2': { id: 'gemini-3.1-flash-image-preview', label: 'Nano Banana 2', desc: 'Самая быстрая, ~500мс' },
  'nano-banana-pro': { id: 'gemini-3-pro-image-preview', label: 'Nano Banana Pro', desc: '4K, мульти-фото' },
  'imagen-3': { id: 'imagen-3.0-generate-002', label: 'Imagen 3', desc: 'Фотореалистичные' },
  'imagen-3-fast': { id: 'imagen-3.0-fast-generate-001', label: 'Imagen 3 Fast', desc: 'Быстрая фотореалистичная' },
  'imagen-4-fast': { id: 'imagen-4.0-fast-generate-001', label: 'Imagen 4 Fast', desc: 'Новое поколение, быстрая' },
  'imagen-4': { id: 'imagen-4.0-generate-001', label: 'Imagen 4', desc: 'Новое поколение, максимум деталей' },
};
const VIDEO_MODELS = {
  'veo-3.1': { id: 'veo-3.1-generate-preview', label: 'Veo 3.1', desc: 'Лучшее качество, до 4K' },
  'veo-3.1-fast': { id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast', desc: 'Быстрая генерация' },
  'veo-2': { id: 'veo-2.0-generate-001', label: 'Veo 2', desc: 'Стабильная генерация видео' },
};

module.exports = { MODEL_MAP, PROVIDER_MODELS, PROVIDER_LABELS, IMAGE_MODELS, VIDEO_MODELS };
