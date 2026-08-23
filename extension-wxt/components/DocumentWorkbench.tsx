import { useEffect, useRef, useState } from 'react';
import { Button } from 'react-aria-components';
import {
  BookOpen, Camera, Check, Clipboard, Copy, FileImage, FileText, Languages,
  LoaderCircle, Play, RefreshCw, ScanText, Settings2, Upload, X,
} from 'lucide-react';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import type { AiProfile, DocumentArtifact, DocumentBlock, TranslationArtifact } from './document-model';
import { isLoopbackUrl } from './document-model';
import { createRuntimeBridge } from './runtime-bridge';

type SourceKind = 'page' | 'text' | 'screenshot' | 'image' | 'pdf';
type Workflow = 'ocr' | 'translate' | 'ocr-translate';
interface PdfPageState { page: number; text: string; selected: boolean; }
interface PdfDocumentLike {
  numPages: number;
  getPage: (page: number) => Promise<{
    getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
    getViewport: (options: { scale: number }) => { width: number; height: number };
    render: (options: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void> };
  }>;
  destroy?: () => Promise<void>;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('无法读取所选文件。'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function artifactFromBlocks(title: string, sourceType: string, blocks: DocumentBlock[]): DocumentArtifact {
  return { version: 1, id: `workbench-${Date.now().toString(36)}`, title, sourceType, blocks, warnings: [] };
}

function uniqueBlocks(blocks: DocumentBlock[]) {
  const seen = new Set<string>();
  return blocks.map((block, index) => ({ ...block, id: block.id || `block-${index + 1}` }))
    .filter((block) => block.text.trim() && !seen.has(block.id) && seen.add(block.id));
}

function translationBatches(blocks: DocumentBlock[], maxBlocks = 24, maxCharacters = 12000) {
  const batches: DocumentBlock[][] = [];
  let current: DocumentBlock[] = [];
  let characters = 0;
  for (const block of blocks) {
    if (current.length && (current.length >= maxBlocks || characters + block.text.length > maxCharacters)) {
      batches.push(current); current = []; characters = 0;
    }
    current.push(block); characters += block.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export function DocumentWorkbench() {
  const [bridge] = useState(() => createRuntimeBridge());
  const [sourceKind, setSourceKind] = useState<SourceKind>('page');
  const [workflow, setWorkflow] = useState<Workflow>('ocr-translate');
  const [sourceLanguage, setSourceLanguage] = useState('auto');
  const [targetLanguage, setTargetLanguage] = useState('zh-CN');
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [ocrProfileId, setOcrProfileId] = useState('');
  const [translationProfileId, setTranslationProfileId] = useState('');
  const [inputText, setInputText] = useState('');
  const [imageDataUrl, setImageDataUrl] = useState('');
  const [imageTitle, setImageTitle] = useState('');
  const [sourceTabId, setSourceTabId] = useState<number | null>(() => {
    const value = Number(new URLSearchParams(window.location.search).get('sourceTabId'));
    return Number.isInteger(value) && value >= 0 ? value : null;
  });
  const [pdfPages, setPdfPages] = useState<PdfPageState[]>([]);
  const [pdfTitle, setPdfTitle] = useState('');
  const [document, setDocument] = useState<DocumentArtifact | null>(null);
  const [translation, setTranslation] = useState<TranslationArtifact | null>(null);
  const [status, setStatus] = useState('正在载入工作台…');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const activeRequestId = useRef('');
  const pdfDocument = useRef<PdfDocumentLike | null>(null);
  const confirmedCloudProfiles = useRef(new Set<string>());
  const settingsRef = useRef<Record<string, unknown>>({});
  const settingsLoaded = useRef(false);

  useEffect(() => {
    let disposed = false;
    if (!bridge.available) { setStatus('当前是界面预览，尚未连接扩展运行时。'); return undefined; }
    void Promise.all([bridge.send({ type: 'settings:get' }), bridge.documentWorkspaceSeed()]).then(([response, seed]) => {
      if (disposed) return;
      const settings = response.settings || {};
      settingsRef.current = settings;
      const nextProfiles = Array.isArray(settings.aiProfiles) ? settings.aiProfiles as unknown as AiProfile[] : [];
      const selections = settings.aiProfileSelections && typeof settings.aiProfileSelections === 'object' ? settings.aiProfileSelections as Record<string, unknown> : {};
      const workbench = settings.documentWorkbench && typeof settings.documentWorkbench === 'object' ? settings.documentWorkbench as Record<string, unknown> : {};
      setProfiles(nextProfiles); setOcrProfileId(String(selections.ocr || '')); setTranslationProfileId(String(selections.translation || ''));
      setSourceLanguage(String(workbench.sourceLanguage || 'auto')); setTargetLanguage(String(workbench.targetLanguage || 'zh-CN'));
      setWorkflow(['ocr', 'translate', 'ocr-translate'].includes(String(workbench.workflow)) ? String(workbench.workflow) as Workflow : 'ocr-translate');
      settingsLoaded.current = true;
      const seededTabId = Number(seed.sourceTabId);
      if (Number.isInteger(seededTabId) && seededTabId >= 0) setSourceTabId(seededTabId);
      if (seed.screenshotDataUrl) { setImageDataUrl(String(seed.screenshotDataUrl)); setImageTitle(`${String(seed.sourceTitle || '网页')} · 可见区域`); }
      setStatus(nextProfiles.length ? '选择输入后即可开始。' : '请先在设置中添加 OCR/翻译服务。');
    }).catch((error) => setStatus(errorMessage(error)));
    return () => { disposed = true; void pdfDocument.current?.destroy?.(); };
  }, [bridge]);

  useEffect(() => {
    if (!settingsLoaded.current || !bridge.available) return undefined;
    const timer = window.setTimeout(() => {
      const next = { ...settingsRef.current, documentWorkbench: { sourceLanguage, targetLanguage, workflow } };
      void bridge.saveSettings(next).then((response) => { settingsRef.current = response.settings || next; }).catch(() => undefined);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [bridge, sourceLanguage, targetLanguage, workflow]);

  const ocrProfile = profiles.find((profile) => profile.id === ocrProfileId) || null;
  const translationProfile = profiles.find((profile) => profile.id === translationProfileId) || null;

  const ensureProfile = async (profile: AiProfile | null, purpose: string, uploadSummary = '文本或图片') => {
    if (!profile) throw new Error(`请先为${purpose}选择 AI Profile。`);
    const granted = await bridge.requestAiOrigin(profile.baseUrl);
    if (!granted) throw new Error(`没有获得${purpose}服务的访问权限。`);
    if (!isLoopbackUrl(profile.baseUrl) && !confirmedCloudProfiles.current.has(profile.id)) {
      const confirmed = window.confirm(`${purpose}将把本次选择的数据发送到“${profile.label}”（${new URL(profile.baseUrl).origin}）。\n\n本次将上传：${uploadSummary}。继续吗？`);
      if (!confirmed) throw new Error('已取消云端处理。');
      confirmedCloudProfiles.current.add(profile.id);
    }
    return profile;
  };

  const loadCurrentPage = async () => {
    if (sourceTabId == null) throw new Error('没有可用的来源网页，请从扩展 Popup 打开工作台。');
    const { snapshot, document: pageDocument } = await bridge.sourceDocument(sourceTabId);
    const rawBlocks = Array.isArray(pageDocument.blocks) ? pageDocument.blocks : (Array.isArray(snapshot.segments) ? snapshot.segments : []);
    const blocks = uniqueBlocks(rawBlocks.map((value, index) => {
      const block = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      return { id: String(block.id || block.blockId || `page-block-${index + 1}`), kind: String(block.kind || block.role || 'paragraph'), text: String(block.text || block.speechText || ''), page: undefined };
    }));
    if (!blocks.length) throw new Error('当前网页没有识别到可处理正文。');
    setDocument(artifactFromBlocks(String(pageDocument.title || snapshot.title || '当前网页'), 'webpage', blocks)); setTranslation(null);
    setStatus(`已载入当前网页 · ${blocks.length} 个文本块。`);
  };

  const loadPdf = async (file: File) => {
    setBusy(true); setStatus('正在本地解析 PDF 文字层…'); setDocument(null); setTranslation(null);
    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      await pdfDocument.current?.destroy?.();
      const bytes = new Uint8Array(await file.arrayBuffer());
      const loaded = await pdfjs.getDocument({ data: bytes }).promise as unknown as PdfDocumentLike;
      pdfDocument.current = loaded;
      const pages: PdfPageState[] = [];
      for (let pageNumber = 1; pageNumber <= loaded.numPages; pageNumber += 1) {
        const page = await loaded.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items.map((item) => String(item.str || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
        pages.push({ page: pageNumber, text, selected: pageNumber <= Math.min(5, loaded.numPages) });
        setProgress({ current: pageNumber, total: loaded.numPages });
      }
      setPdfPages(pages); setPdfTitle(file.name); setSourceKind('pdf');
      setStatus(`PDF 已本地解析 · ${pages.length} 页 · ${pages.filter((page) => page.text).length} 页有文字层。`);
    } finally { setBusy(false); setProgress({ current: 0, total: 0 }); }
  };

  const renderPdfPage = async (pageNumber: number) => {
    const page = await pdfDocument.current?.getPage(pageNumber);
    if (!page) throw new Error(`PDF 第 ${pageNumber} 页已不可用。`);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = globalThis.document.createElement('canvas'); canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d'); if (!context) throw new Error('无法渲染 PDF 页面。');
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.9);
  };

  const extractInputs = async (): Promise<DocumentArtifact> => {
    if (sourceKind === 'page') {
      if (!document?.blocks.length) await loadCurrentPage();
      const { snapshot, document: pageDocument } = sourceTabId == null ? { snapshot: {}, document: {} } : await bridge.sourceDocument(sourceTabId);
      const existing = document?.blocks.length ? document : null;
      if (existing) return existing;
      const blocks = Array.isArray((pageDocument as Record<string, unknown>).blocks) ? (pageDocument as Record<string, unknown>).blocks as Record<string, unknown>[] : Array.isArray((snapshot as Record<string, unknown>).segments) ? (snapshot as Record<string, unknown>).segments as Record<string, unknown>[] : [];
      return artifactFromBlocks(String((pageDocument as Record<string, unknown>).title || '当前网页'), 'webpage', uniqueBlocks(blocks.map((block, index) => ({ id: String(block.id || `page-block-${index + 1}`), kind: String(block.kind || 'paragraph'), text: String(block.text || block.speechText || '') }))));
    }
    if (sourceKind === 'text') {
      const text = inputText.trim(); if (!text) throw new Error('请先粘贴需要处理的文本。');
      return artifactFromBlocks('粘贴文本', 'text', text.split(/\n{2,}/u).map((value, index) => ({ id: `text-block-${index + 1}`, kind: 'paragraph', text: value.trim() })).filter((block) => block.text));
    }
    if (sourceKind === 'image' || sourceKind === 'screenshot') {
      if (!imageDataUrl) throw new Error(sourceKind === 'screenshot' ? '没有可用截图，请从网页 Popup 重新打开工作台。' : '请先上传图片。');
      const profile = await ensureProfile(ocrProfile, 'OCR', sourceKind === 'screenshot' ? '网页可见区域截图 1 张' : '图片 1 张');
      const requestId = `ocr-${Date.now()}-${Math.random().toString(36).slice(2)}`; activeRequestId.current = requestId;
      const result = await bridge.extractDocument(profile.id, { kind: sourceKind, title: imageTitle, dataUrl: imageDataUrl, mimeType: imageDataUrl.slice(5, imageDataUrl.indexOf(';')), page: 1 }, requestId);
      return result.document;
    }
    const selectedPages = pdfPages.filter((page) => page.selected);
    if (!selectedPages.length) throw new Error('请至少选择一个 PDF 页面。');
    const blocks: DocumentBlock[] = [];
    for (let index = 0; index < selectedPages.length; index += 1) {
      const page = selectedPages[index]!; setProgress({ current: index + 1, total: selectedPages.length });
      if (page.text) blocks.push({ id: `page-${page.page}-text`, kind: 'paragraph', text: page.text, page: page.page });
      else {
        const profile = await ensureProfile(ocrProfile, '扫描 PDF OCR', `扫描 PDF 第 ${page.page} 页的渲染图片`);
        const dataUrl = await renderPdfPage(page.page); const requestId = `pdf-ocr-${page.page}-${Date.now()}`; activeRequestId.current = requestId;
        const result = await bridge.extractDocument(profile.id, { kind: 'pdf-page', title: pdfTitle, dataUrl, mimeType: 'image/jpeg', page: page.page }, requestId);
        blocks.push(...result.document.blocks.map((block) => ({ ...block, page: block.page || page.page })));
      }
    }
    return artifactFromBlocks(pdfTitle || 'PDF 文档', 'pdf', uniqueBlocks(blocks));
  };

  const run = async () => {
    if (busy) return;
    setBusy(true); setTranslation(null); setProgress({ current: 0, total: 0 }); setStatus('正在准备输入…');
    try {
      let nextDocument = document;
      if (workflow !== 'translate' || !nextDocument?.blocks.length) nextDocument = await extractInputs();
      if (!nextDocument.blocks.length) throw new Error('没有识别到可处理文本。');
      setDocument(nextDocument);
      if (workflow === 'ocr') { setStatus(`识别完成 · ${nextDocument.blocks.length} 个文本块。`); return; }
      const profile = await ensureProfile(translationProfile, '翻译', `${nextDocument.blocks.length} 个文本块，不包含原始文件`);
      setStatus('正在翻译文本块…');
      const batches = translationBatches(nextDocument.blocks); const translatedBlocks: TranslationArtifact['blocks'] = []; const warnings: string[] = [];
      for (let index = 0; index < batches.length; index += 1) {
        const blocks = batches[index]!; setProgress({ current: index, total: batches.length });
        const requestId = `translate-${index + 1}-${Date.now()}-${Math.random().toString(36).slice(2)}`; activeRequestId.current = requestId;
        try {
          const response = await bridge.translateDocument(profile.id, { documentId: nextDocument.id, blocks, sourceLanguage, targetLanguage }, requestId);
          translatedBlocks.push(...response.translation.blocks); warnings.push(...response.translation.warnings);
        } catch (error) {
          if ((error as Error & { code?: string }).code === 'cancelled') throw error;
          translatedBlocks.push(...blocks.map((block) => ({ id: block.id, sourceText: block.text, translatedText: '', status: 'failed' as const, warnings: [errorMessage(error)] })));
          warnings.push(`第 ${index + 1} 批翻译失败：${errorMessage(error)}`);
        }
        setProgress({ current: index + 1, total: batches.length });
      }
      const nextTranslation: TranslationArtifact = { version: 1, id: `translation-${Date.now().toString(36)}`, sourceLanguage, targetLanguage, blocks: translatedBlocks, warnings };
      setTranslation(nextTranslation); setStatus(`翻译完成 · ${translatedBlocks.filter((block) => block.status === 'translated').length}/${nextDocument.blocks.length} 个文本块。`);
    } catch (error) { setStatus(errorMessage(error)); }
    finally { activeRequestId.current = ''; setBusy(false); setProgress({ current: 0, total: 0 }); }
  };

  const cancel = async () => {
    const requestId = activeRequestId.current; if (!requestId) return;
    await bridge.cancelDocument(requestId).catch(() => undefined); setStatus('已请求取消当前任务。');
  };

  const retryTranslation = async (block: DocumentBlock) => {
    const profile = await ensureProfile(translationProfile, '翻译');
    setBusy(true); setStatus(`正在重试“${block.text.slice(0, 20)}”…`);
    try {
      const response = await bridge.translateDocument(profile.id, { blocks: [block], sourceLanguage, targetLanguage });
      const translated = response.translation.blocks[0];
      if (!translated) throw new Error('服务没有返回该文本块的译文。');
      setTranslation((current) => current ? { ...current, blocks: current.blocks.map((item) => item.id === block.id ? translated : item) } : response.translation);
      setStatus('单块翻译已更新。');
    } catch (error) { setStatus(errorMessage(error)); }
    finally { setBusy(false); }
  };

  const translatedById = new Map((translation?.blocks || []).map((block) => [block.id, block]));
  const readAllText = (document?.blocks || []).map((block) => translatedById.get(block.id)?.translatedText || block.text).filter(Boolean).join('\n');

  return (
    <main className="fl-document-workbench" aria-label="文档与翻译工作台">
      <header className="fl-document-header"><div className="fl-workspace-brand"><img src="/assets/flowloud-mark.svg" alt="" /><div><strong>文档与翻译工作台</strong><span>网页、截图、图片和 PDF · 识别、翻译并朗读</span></div></div><Button className="fl-secondary-button" onPress={() => bridge.openOptions()}><Settings2 aria-hidden="true" />配置 AI 服务</Button></header>
      <div className="fl-document-layout">
        <aside className="fl-document-inputs">
          <section><h2>1. 选择输入</h2><div className="fl-source-buttons">
            <Button className={sourceKind === 'page' ? 'is-active' : ''} onPress={() => setSourceKind('page')}><BookOpen aria-hidden="true" />当前网页</Button>
            <Button className={sourceKind === 'text' ? 'is-active' : ''} onPress={() => setSourceKind('text')}><Clipboard aria-hidden="true" />粘贴文本</Button>
            <Button className={sourceKind === 'screenshot' ? 'is-active' : ''} onPress={() => setSourceKind('screenshot')}><Camera aria-hidden="true" />网页截图</Button>
            <Button className={sourceKind === 'image' ? 'is-active' : ''} onPress={() => setSourceKind('image')}><FileImage aria-hidden="true" />上传图片</Button>
            <Button className={sourceKind === 'pdf' ? 'is-active' : ''} onPress={() => setSourceKind('pdf')}><FileText aria-hidden="true" />上传 PDF</Button>
          </div></section>
          {sourceKind === 'page' ? <section className="fl-input-card"><BookOpen aria-hidden="true" /><strong>当前网页正文</strong><span>在来源标签页本地提取结构化正文，不会上传网页 HTML。</span><Button className="fl-secondary-button" onPress={() => { void loadCurrentPage().catch((error) => setStatus(errorMessage(error))); }}>提取网页正文</Button></section> : null}
          {sourceKind === 'text' ? <textarea className="fl-document-textarea" value={inputText} onChange={(event) => setInputText(event.target.value)} placeholder="粘贴需要翻译或朗读的文本…" /> : null}
          {sourceKind === 'screenshot' ? <section className="fl-input-card"><Camera aria-hidden="true" /><strong>{imageDataUrl ? imageTitle || '打开工作台时的可见区域' : '没有可用截图'}</strong><span>截图只在当前会话内存中保留；开始 OCR 前会再次确认云端发送。</span>{imageDataUrl ? <img src={imageDataUrl} alt="网页可见区域截图预览" /> : null}</section> : null}
          {sourceKind === 'image' ? <label className="fl-upload-drop"><Upload aria-hidden="true" /><strong>选择 PNG、JPEG 或 WebP</strong><span>图片不会写入扩展存储。</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; if (file) void fileDataUrl(file).then((url) => { setImageDataUrl(url); setImageTitle(file.name); setStatus(`已载入图片：${file.name}`); }); }} /></label> : null}
          {sourceKind === 'pdf' ? <><label className="fl-upload-drop"><FileText aria-hidden="true" /><strong>选择 PDF</strong><span>文字层在浏览器本地提取；仅扫描页需要 OCR。</span><input type="file" accept="application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadPdf(file).catch((error) => setStatus(errorMessage(error))); }} /></label>{pdfPages.length ? <div className="fl-pdf-pages"><div><strong>{pdfTitle}</strong><span>选择本次处理页码</span></div>{pdfPages.map((page) => <label key={page.page}><input type="checkbox" checked={page.selected} onChange={(event) => setPdfPages((current) => current.map((item) => item.page === page.page ? { ...item, selected: event.target.checked } : item))} /><span>第 {page.page} 页</span><em>{page.text ? '本地文字层' : '需要 OCR'}</em></label>)}</div> : null}</> : null}
          <section><h2>2. 选择流程</h2><div className="fl-workflow-buttons"><Button className={workflow === 'ocr' ? 'is-active' : ''} onPress={() => setWorkflow('ocr')}><ScanText aria-hidden="true" />仅识别</Button><Button className={workflow === 'translate' ? 'is-active' : ''} onPress={() => setWorkflow('translate')}><Languages aria-hidden="true" />仅翻译</Button><Button className={workflow === 'ocr-translate' ? 'is-active' : ''} onPress={() => setWorkflow('ocr-translate')}><Check aria-hidden="true" />识别并翻译</Button></div></section>
          <div className="fl-document-profile-grid"><label><span>OCR 服务</span><select value={ocrProfileId} onChange={(event) => setOcrProfileId(event.target.value)}><option value="">未选择</option>{profiles.filter((profile) => profile.capabilities.visionOcr).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label><label><span>翻译服务</span><select value={translationProfileId} onChange={(event) => setTranslationProfileId(event.target.value)}><option value="">未选择</option>{profiles.filter((profile) => profile.capabilities.textTranslation).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label><label><span>源语言</span><input value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value)} /></label><label><span>目标语言</span><input value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value)} /></label></div>
          <div className="fl-document-run"><Button isDisabled={busy} className="fl-primary-button" onPress={run}>{busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Play aria-hidden="true" />}{busy ? '处理中…' : '开始处理'}</Button>{busy ? <Button className="fl-danger-button" onPress={cancel}><X aria-hidden="true" />取消</Button> : null}</div>
          <div className="fl-document-status" role="status" aria-live="polite"><span>{status}</span>{progress.total ? <progress max={progress.total} value={progress.current} /> : null}</div>
        </aside>

        <section className="fl-document-results" aria-label="识别与翻译结果">
          <header><div><p>3. 校对与朗读</p><h1>{document?.title || '处理结果会显示在这里'}</h1><span>{document ? `${document.blocks.length} 个文本块 · 仅保留在当前会话` : '原文与译文按块对应，支持单块重试。'}</span></div><div><Button isDisabled={!readAllText} className="fl-secondary-button" onPress={() => navigator.clipboard.writeText(readAllText)}><Copy aria-hidden="true" />复制全部</Button><Button isDisabled={!readAllText} className="fl-primary-button" onPress={() => bridge.speakText(readAllText)}><Play aria-hidden="true" />朗读全部</Button></div></header>
          {!document?.blocks.length ? <div className="fl-document-empty"><Languages aria-hidden="true" /><strong>尚未生成结果</strong><span>数字 PDF 会先本地提取文字；图片和扫描页按所选 OCR Profile 处理。</span></div> : <div className="fl-document-block-list">{document.blocks.map((block, index) => {
            const translated = translatedById.get(block.id);
            return <article key={block.id} className="fl-document-block"><div className="fl-block-meta"><span>{block.page ? `第 ${block.page} 页 · ` : ''}块 {index + 1}</span><div><Button aria-label="复制本段" onPress={() => navigator.clipboard.writeText(translated?.translatedText || block.text)}><Copy aria-hidden="true" /></Button><Button aria-label="朗读本段" onPress={() => bridge.speakText(translated?.translatedText || block.text)}><Play aria-hidden="true" /></Button>{workflow !== 'ocr' ? <Button aria-label="重试本段翻译" isDisabled={busy} onPress={() => retryTranslation(block)}><RefreshCw aria-hidden="true" /></Button> : null}</div></div><div className="fl-block-columns"><label><span>原文</span><textarea value={block.text} onChange={(event) => setDocument((current) => current ? { ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, text: event.target.value } : item) } : current)} /></label><label><span>译文</span><textarea value={translated?.translatedText || ''} placeholder={workflow === 'ocr' ? '当前流程不生成译文' : translated?.status === 'failed' ? '翻译失败，可重试本块' : '等待翻译…'} onChange={(event) => setTranslation((current) => current ? { ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, translatedText: event.target.value, status: 'translated' } : item) } : current)} /></label></div></article>;
          })}</div>}
        </section>
      </div>
    </main>
  );
}
