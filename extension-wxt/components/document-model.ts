export type AiProtocol = 'openai-chat' | 'openai-responses' | 'ollama-chat' | 'flowloud-document-v1';

export interface AiCapabilities {
  textTranslation: boolean;
  visionOcr: boolean;
  pdfInput: boolean;
  structuredOutput: boolean;
  streaming: boolean;
}

export interface AiProfile {
  id: string;
  label: string;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  authHeader: string;
  authScheme: string;
  timeoutMs: number;
  customHeaders: Record<string, string>;
  rememberSecret: boolean;
  capabilities: AiCapabilities;
}

export interface DocumentBlock {
  id: string;
  kind: string;
  text: string;
  page?: number;
  bbox?: unknown;
  confidence?: number;
}

export interface DocumentArtifact {
  version: 1;
  id: string;
  title: string;
  sourceType: string;
  blocks: DocumentBlock[];
  warnings: string[];
}

export interface TranslationBlock {
  id: string;
  sourceText: string;
  translatedText: string;
  status: 'translated' | 'failed';
  warnings: string[];
}

export interface TranslationArtifact {
  version: 1;
  id: string;
  sourceLanguage: string;
  targetLanguage: string;
  blocks: TranslationBlock[];
  warnings: string[];
}

type Preset = Omit<AiProfile, 'id' | 'model' | 'rememberSecret' | 'timeoutMs' | 'customHeaders'> & { suggestedModel: string };

const defaultCapabilities: AiCapabilities = {
  textTranslation: true, visionOcr: true, pdfInput: false, structuredOutput: true, streaming: false,
};

export const aiProfilePresets: Record<string, Preset> = {
  openai: { label: 'OpenAI', protocol: 'openai-responses', baseUrl: 'https://api.openai.com', suggestedModel: 'gpt-4.1-mini', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
  ark: { label: '火山方舟 / 豆包', protocol: 'openai-responses', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', suggestedModel: '', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
  dashscope: { label: '阿里百炼 / 通义', protocol: 'openai-chat', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode', suggestedModel: 'qwen-vl-max', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
  zhipu: { label: '智谱 BigModel', protocol: 'openai-chat', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', suggestedModel: 'glm-4.5v', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
  deepseek: { label: 'DeepSeek（翻译）', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com', suggestedModel: 'deepseek-chat', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: { ...defaultCapabilities, visionOcr: false } },
  openrouter: { label: 'OpenRouter', protocol: 'openai-chat', baseUrl: 'https://openrouter.ai/api', suggestedModel: '', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
  ollama: { label: 'Ollama 本机服务', protocol: 'ollama-chat', baseUrl: 'http://127.0.0.1:11434', suggestedModel: 'qwen2.5vl:3b', authHeader: '', authScheme: '', capabilities: defaultCapabilities },
  flowloud: { label: 'Flowloud 本地文档服务', protocol: 'flowloud-document-v1', baseUrl: 'http://127.0.0.1:7812', suggestedModel: '', authHeader: 'Authorization', authScheme: 'Bearer', capabilities: defaultCapabilities },
};

export function profileFromPreset(presetId: string, existingIds: string[]): AiProfile {
  const preset = aiProfilePresets[presetId] || aiProfilePresets.openai!;
  const baseId = presetId.replace(/[^a-z0-9_-]/gi, '-') || 'ai';
  let id = baseId;
  let suffix = 2;
  while (existingIds.includes(id)) { id = `${baseId}-${suffix}`; suffix += 1; }
  return {
    id, label: preset.label, protocol: preset.protocol, baseUrl: preset.baseUrl,
    model: preset.suggestedModel, authHeader: preset.authHeader, authScheme: preset.authScheme,
    timeoutMs: 120000, customHeaders: {}, rememberSecret: false, capabilities: { ...preset.capabilities },
  };
}

export function isLoopbackUrl(value: string) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
  catch { return false; }
}
