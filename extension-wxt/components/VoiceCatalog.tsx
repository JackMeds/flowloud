import { Button } from 'react-aria-components';
import {
  Check,
  Download,
  Edit3,
  Globe2,
  MessageSquareText,
  Play,
  Search,
  Star,
  X,
} from 'lucide-react';
import type { ModelDownloadState, VoiceCatalogEntry } from './model';
import { providerLabel, type ProviderId } from './provider-registry';
import {
  bytesLabel,
  namespacedVoiceId,
  rawVoiceId,
  voiceInitial,
  voiceKey,
  type VoiceAssignment,
} from './voice-workbench-model';

interface VoiceCatalogProps {
  providerId: ProviderId;
  voices: VoiceCatalogEntry[];
  allFilteredVoices: VoiceCatalogEntry[];
  assignment: VoiceAssignment;
  selectedVoice: VoiceCatalogEntry | null;
  detectedLocaleLabel: string;
  languages: Array<[string, string]>;
  search: string;
  languageFilter: string;
  downloadFilter: 'all' | 'downloaded' | 'missing';
  genderFilter: 'all' | 'female' | 'male' | 'unknown';
  downloadQueue: Set<string>;
  modelState?: ModelDownloadState;
  busy: boolean;
  aliasDraft: string;
  noteDraft: string;
  onSearchChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onDownloadFilterChange: (value: 'all' | 'downloaded' | 'missing') => void;
  onGenderFilterChange: (value: 'all' | 'female' | 'male' | 'unknown') => void;
  onSelectVoice: (voice: VoiceCatalogEntry) => void;
  onSetNarrator: (voice: VoiceCatalogEntry) => void;
  onTogglePoolVoice: (voice: VoiceCatalogEntry) => void;
  onSelectAllPool: (voices: VoiceCatalogEntry[]) => void;
  onRemovePoolVoices: (voices: VoiceCatalogEntry[]) => void;
  onClearPool: () => void;
  onAudition: (voice: VoiceCatalogEntry) => void;
  onToggleDownload: (voice: VoiceCatalogEntry) => void;
  onLoadMore: () => void;
  onAliasChange: (value: string) => void;
  onNoteChange: (value: string) => void;
  onSaveMetadata: () => void;
}

export function VoiceCatalog(props: VoiceCatalogProps) {
  const {
    providerId,
    voices,
    allFilteredVoices,
    assignment,
    selectedVoice,
    detectedLocaleLabel,
    languages,
    search,
    languageFilter,
    downloadFilter,
    genderFilter,
    downloadQueue,
    modelState,
    busy,
    aliasDraft,
    noteDraft,
    onSearchChange,
    onLanguageChange,
    onDownloadFilterChange,
    onGenderFilterChange,
    onSelectVoice,
    onSetNarrator,
    onTogglePoolVoice,
    onSelectAllPool,
    onRemovePoolVoices,
    onClearPool,
    onAudition,
    onToggleDownload,
    onLoadMore,
    onAliasChange,
    onNoteChange,
    onSaveMetadata,
  } = props;
  const narratorKey = namespacedVoiceId(providerId, assignment.narratorVoiceId);
  const poolKeys = new Set((assignment.replyVoiceIds || []).map((voice) => namespacedVoiceId(providerId, voice)));
  const poolCandidates = allFilteredVoices.filter((voice) => voice.availability === 'available' && voiceKey(voice) !== narratorKey);
  const allPoolSelected = poolCandidates.length > 0 && poolCandidates.every((voice) => poolKeys.has(voiceKey(voice)));
  const hasMore = voices.length < allFilteredVoices.length;

  return (
    <section id="voice-select" className="fl-catalog-section" aria-labelledby="voice-catalog-heading">
      <header className="fl-section-heading">
        <div>
          <span className="fl-step-label">3</span>
          <div>
            <h2 id="voice-catalog-heading">选择默认旁白和人物声音池</h2>
            <p>当前只显示“{providerLabel(providerId)}”的声音，来源切换不会再藏在筛选下拉框里。</p>
          </div>
        </div>
        <div className="fl-pool-actions">
          <span><strong>{poolKeys.size}</strong> 个声音已加入人物声音池</span>
          <Button className="fl-text-button" isDisabled={!poolCandidates.length || allPoolSelected || busy} onPress={() => onSelectAllPool(poolCandidates)}>全选当前结果</Button>
          <Button className="fl-text-button" isDisabled={!poolKeys.size || busy} onPress={onClearPool}>清空声音池</Button>
        </div>
      </header>

      <div className="fl-catalog-filters" aria-label="声音筛选">
        <label className="fl-catalog-search"><Search aria-hidden={true} /><span className="sr-only">搜索声音</span><input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="搜索名称、备注、语言或原始 ID" /></label>
        <label><Globe2 aria-hidden={true} /><span className="sr-only">语言筛选</span><select value={languageFilter} onChange={(event) => onLanguageChange(event.target.value)}><option value="auto">自动：{detectedLocaleLabel}</option><option value="all">全部语言</option>{languages.map(([locale, label]) => <option key={locale} value={locale}>{label} · {locale}</option>)}</select></label>
        {providerId === 'browser-model' ? <label><span className="sr-only">下载状态</span><select value={downloadFilter} onChange={(event) => onDownloadFilterChange(event.target.value as 'all' | 'downloaded' | 'missing')}><option value="all">全部下载状态</option><option value="downloaded">已下载</option><option value="missing">未下载</option></select></label> : null}
        <label><span className="sr-only">性别信息</span><select value={genderFilter} onChange={(event) => onGenderFilterChange(event.target.value as 'all' | 'female' | 'male' | 'unknown')}><option value="all">全部性别</option><option value="female">官方标注女声</option><option value="male">官方标注男声</option><option value="unknown">未标注性别</option></select></label>
      </div>

      {providerId === 'browser-model' && downloadQueue.size ? (
        <div className="fl-download-queue-summary" role="status">
          <Download aria-hidden={true} />
          <span><strong>下载队列中有 {downloadQueue.size} 个音色</strong><small>回到上方“浏览器模型”来源设置，选择自定义安装或批量下载。</small></span>
        </div>
      ) : null}

      {selectedVoice ? (
        <section className="fl-voice-editor" aria-label={`${selectedVoice.label} 的名称与备注`}>
          <div><span className="fl-voice-avatar">{voiceInitial(selectedVoice.label)}</span><span><strong>{selectedVoice.label}</strong><small>原始 ID：{selectedVoice.rawId || rawVoiceId(selectedVoice.id)}</small></span></div>
          <label><span>我的名称</span><input maxLength={64} value={aliasDraft} onChange={(event) => onAliasChange(event.target.value)} placeholder={selectedVoice.rawLabel || selectedVoice.label} /></label>
          <label><span>备注</span><input maxLength={500} value={noteDraft} onChange={(event) => onNoteChange(event.target.value)} placeholder="例如：适合长文章、人物对白……" /></label>
          <Button className="fl-secondary-button" isDisabled={busy} onPress={onSaveMetadata}><Check aria-hidden={true} />保存名称与备注</Button>
        </section>
      ) : null}

      <div className="fl-voice-list-summary">
        <span>显示 {voices.length} / {allFilteredVoices.length} 个声音</span>
        <span>系统语言：{detectedLocaleLabel}</span>
      </div>

      <div className="fl-voice-table" role="table" aria-label={`${providerLabel(providerId)}声音列表`}>
        <div className="fl-voice-table-head" role="row">
          <span className="fl-pool-check-cell">
            <input
              type="checkbox"
              aria-label="全选当前筛选结果到人物声音池"
              checked={allPoolSelected}
              disabled={!poolCandidates.length || busy}
              onChange={(event) => event.target.checked ? onSelectAllPool(poolCandidates) : onRemovePoolVoices(poolCandidates)}
            />
            <small>声音池</small>
          </span>
          <span>声音</span><span>语言与能力</span><span>状态</span><span>操作</span>
        </div>

        {voices.map((voice) => {
          const key = voiceKey(voice);
          const narrator = key === narratorKey;
          const inPool = poolKeys.has(key);
          const detailSelected = selectedVoice ? voiceKey(selectedVoice) === key : false;
          const usable = voice.availability === 'available';
          const genderLabel = voice.gender === 'female' ? '女声' : voice.gender === 'male' ? '男声' : '性别未标注';
          const eventLabel = voice.eventTypes?.includes('word') ? '支持逐词同步' : voice.eventTypes?.includes('sentence') ? '支持句子同步' : voice.providerId === 'browser-model' ? '离线模型音色' : '事件能力未标注';
          const queued = downloadQueue.has(rawVoiceId(voice.id));
          return (
            <div
              className={`fl-voice-row ${narrator ? 'is-current' : ''} ${inPool ? 'is-in-pool' : ''} ${detailSelected ? 'is-detail-selected' : ''}`}
              role="row"
              aria-selected={detailSelected}
              tabIndex={0}
              key={voice.id}
              onClick={() => onSelectVoice(voice)}
              onKeyDown={(event) => {
                if ((event.target as HTMLElement).closest('button,input,select,textarea')) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectVoice(voice);
                }
              }}
            >
              <div className="fl-pool-check-cell">
                <input
                  type="checkbox"
                  aria-label={`将 ${voice.label} ${inPool ? '移出' : '加入'}人物声音池`}
                  checked={inPool}
                  disabled={!usable || narrator || busy}
                  title={narrator ? '默认旁白已单独使用' : !usable ? '先让这个声音可用' : '加入人物声音池'}
                  onChange={() => onTogglePoolVoice(voice)}
                  onClick={(event) => event.stopPropagation()}
                />
                {narrator ? <small>旁白</small> : inPool ? <small>已加入</small> : null}
              </div>
              <div className="fl-voice-name">
                <span className="fl-voice-avatar">{voiceInitial(voice.label)}</span>
                <span className="fl-voice-radio" aria-hidden="true">{narrator ? <Check /> : null}</span>
                <div><strong>{voice.label}</strong><small>{voice.rawLabel || voice.rawId || rawVoiceId(voice.id)}</small>{voice.note ? <em title={voice.note}><MessageSquareText aria-hidden={true} />{voice.note}</em> : null}{voice.recommendedReason ? <em className="fl-voice-recommendation"><Star aria-hidden={true} />{voice.recommendedReason}</em> : null}</div>
              </div>
              <div><span>{voice.languageLabel}{voice.gender || voice.providerId === 'browser-model' ? ` · ${genderLabel}` : ''}</span><small>{eventLabel}</small></div>
              <div><span className={`fl-provider-tag is-${voice.providerId}`}>{voice.vendor || providerLabel(voice.providerId)}</span>{voice.providerId === 'browser-model' ? <small>{voice.cached === true ? `已下载 · ${bytesLabel(Number(voice.sizeBytes || 522240))}` : `未下载 · ${bytesLabel(Number(voice.sizeBytes || 522240))}`}</small> : <small>{usable ? '可直接使用' : '暂不可用'}</small>}</div>
              <div className="fl-voice-actions">
                <Button aria-label={`试听 ${voice.label}`} className="fl-icon-button" isDisabled={busy || (voice.providerId === 'browser-model' && modelState?.ready !== true)} onClick={(event) => event.stopPropagation()} onPress={() => onAudition(voice)}><Play aria-hidden={true} /></Button>
                {usable ? <Button className={narrator ? 'fl-secondary-button' : 'fl-primary-button'} isDisabled={busy || narrator} onClick={(event) => event.stopPropagation()} onPress={() => onSetNarrator(voice)}>{narrator ? '默认旁白' : '设为旁白'}</Button> : null}
                {voice.providerId === 'browser-model' && voice.cached !== true ? <Button className={queued ? 'fl-secondary-button' : 'fl-primary-button'} isDisabled={busy} onClick={(event) => event.stopPropagation()} onPress={() => onToggleDownload(voice)}>{queued ? <><X aria-hidden={true} />移出下载</> : <><Download aria-hidden={true} />加入下载</>}</Button> : null}
                <Button aria-label={`编辑 ${voice.label}`} className="fl-icon-button" onClick={(event) => event.stopPropagation()} onPress={() => onSelectVoice(voice)}><Edit3 aria-hidden={true} /></Button>
              </div>
            </div>
          );
        })}

        {!voices.length ? <div className="fl-voice-empty"><Search aria-hidden={true} /><strong>没有匹配的声音</strong><span>清除筛选，或先完成这个来源的配置与连接。</span></div> : null}
      </div>
      {hasMore ? <Button className="fl-load-more" onPress={onLoadMore}>加载更多声音（还有 {allFilteredVoices.length - voices.length} 个）</Button> : null}
    </section>
  );
}
