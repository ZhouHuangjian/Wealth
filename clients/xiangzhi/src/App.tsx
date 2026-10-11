import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity as ActivityIcon, ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check,
  CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Cloud, Copy, FileText, HeartHandshake,
  Leaf, LoaderCircle, MessageCircle, MoreHorizontal, Pause, Plus, Search, Send,
  Settings2, ShieldCheck, Sparkles, Trash2, UserRound, Users, X, Zap,
} from 'lucide-react';
import type { Conversation, Draft, ImportInput, ImportPreview, Message, ProfileClaim, PublicState, Settings } from '../shared/types';
import { api } from './api';

type Page = 'conversations' | 'profile' | 'knowledge' | 'settings' | 'activity' | 'drafts';
type Toast = { message: string; error?: boolean };
const navigation: { id: Page; label: string; icon: typeof MessageCircle }[] = [
  { id: 'conversations', label: '对话', icon: MessageCircle },
  { id: 'drafts', label: '云端草稿箱', icon: Cloud },
  { id: 'profile', label: '我的档案', icon: UserRound },
  { id: 'knowledge', label: '沟通知识', icon: BookOpen },
  { id: 'activity', label: '活动记录', icon: ActivityIcon },
];
const categoryLabels = { preference: '兴趣偏好', style: '表达习惯', fact: '个人事实', boundary: '相处边界' };
const timeLabel = (value: string | null) => value && !Number.isNaN(new Date(value).getTime())
  ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '时间未知';
const checkedTimeLabel = (value: string) => Number.isNaN(new Date(value).getTime()) ? '时间未知'
  : new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateLabel = (value: string | null) => value && !Number.isNaN(new Date(value).getTime())
  ? new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '未记录日期';
const jobLabels = { queued: '等待处理', generating: '正在组织回复', drafted: '草稿已生成 · 待你确认', sent: '已发送', cancelled: '已取消', failed: '处理失败', blocked: '已暂停' };
const messageKindLabels = { text: '文字', image: '图片', voice: '语音', video: '视频', emoji: '表情', file: '文件', link: '链接', system: '系统消息', unknown: '未知消息' };
const messageDisplayText = (message: Message) => message.mediaStatus === 'reviewed'
  ? message.text.replace(/^\[[^\]\n]+，待人工查看\]\n?/, '').trim() || '已由你查看，媒体内容未自动解析。'
  : message.mediaStatus === 'pending' ? message.text.replace(/^\[([^\]\n]+)，待人工查看\]/, '[$1，未解析]') : message.text;

function Toggle({ checked, onChange, label, disabled = false, small = false }: {
  checked: boolean; onChange: () => void; label: string; disabled?: boolean; small?: boolean;
}) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
    className={`toggle ${checked ? 'on' : ''} ${small ? 'small' : ''}`} onClick={onChange}><span /></button>;
}
function Button({ children, onClick, disabled, kind = 'primary', type = 'button', className = '' }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  type?: 'button' | 'submit'; className?: string;
}) {
  return <button type={type} className={`button ${kind} ${className}`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Empty({ icon: Icon = MessageCircle, title, children }: { icon?: typeof MessageCircle; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon size={25} /></div><h3>{title}</h3><p>{children}</p></div>;
}
function Modal({ title, description, onClose, children, wide = false }: {
  title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} className={`modal ${wide ? 'wide' : ''}`} onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }} aria-label={title}>
    <div className="modal-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>
      <button className="icon-button" onClick={onClose} aria-label="关闭窗口"><X size={20} /></button></div>
    {children}
  </dialog>;
}

export default function App() {
  const [state, setState] = useState<PublicState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [page, setPage] = useState<Page>('conversations');
  const [selectedId, setSelectedId] = useState('');
  const [search, setSearch] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [busy, setBusy] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [mobileConversation, setMobileConversation] = useState(false);
  const [textById, setTextById] = useState<Record<string, string>>({});
  const [role, setRole] = useState<'self' | 'peer'>('self');
  const [intent, setIntent] = useState('');
  const [adoptedDrafts, setAdoptedDrafts] = useState<Record<string, string>>({});
  const [feedbackReasonById, setFeedbackReasonById] = useState<Record<string, string>>({});
  const sendRequests = useRef(new Map<string, string>());
  const feedbackRequests = useRef(new Map<string, string>());
  const [now, setNow] = useState(Date.now());
  const messageList = useRef<HTMLDivElement>(null);
  const messageListNearBottom = useRef(true);
  const scrolledConversation = useRef<string | null>(null);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    try {
      const next = await api<PublicState>('/state');
      if (!mounted.current) return;
      setState(next); setLoadError('');
      setSelectedId(previous => next.conversations.some(c => c.id === previous) ? previous : next.conversations[0]?.id || '');
    } catch (error) {
      if (mounted.current) setLoadError(error instanceof Error ? error.message : '暂时无法连接本地服务');
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const poll = setInterval(() => void refresh(), 2000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(poll); clearInterval(clock); };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  const run = async <T,>(key: string, action: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(key);
    try {
      const result = await action();
      await refresh();
      if (success) notify(success);
      return result;
    } catch (error) { notify(error instanceof Error ? error.message : '操作未完成，请重试', true); }
    finally { setBusy(''); }
  };
  const conversation = state?.conversations.find(c => c.id === selectedId);
  const messages = state?.messages.filter(m => m.conversationId === selectedId).sort((a, b) => a.sequence - b.sequence) || [];
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (page !== 'conversations') { scrolledConversation.current = null; return; }
    const list = messageList.current;
    if (!list || !list.clientHeight) return;
    const changedConversation = scrolledConversation.current !== selectedId;
    if (changedConversation || messageListNearBottom.current) {
      list.scrollTo({ top: list.scrollHeight, behavior: changedConversation ? 'instant' : 'smooth' });
      if (changedConversation) messageListNearBottom.current = true;
    }
    scrolledConversation.current = selectedId;
  }, [lastMessageId, selectedId, page, mobileConversation, adoptedDrafts[selectedId], role]);
  const drafts = state?.drafts.filter(d => d.conversationId === selectedId && d.basedOnMessageId === lastMessageId).slice(-3) ?? [];
  const currentJob = state?.jobs.filter(j => j.conversationId === selectedId && ['queued', 'generating'].includes(j.status)).at(-1);
  const currentUpload = state?.draftUploads?.filter(upload => upload.conversationId === selectedId && upload.destinationId === state.runtime.draftSyncConnection?.bindingId).at(-1);
  const uploadMatchesCurrentDrafts = !!currentUpload && drafts.length > 0
    && drafts.length === currentUpload.draftIds.length && drafts.every(draft => currentUpload.draftIds.includes(draft.id));
  const currentDraftsUploaded = currentUpload?.status === 'uploaded' && uploadMatchesCurrentDrafts;
  const text = textById[selectedId] || '';
  const setText = (value: string) => {
    setTextById(previous => ({ ...previous, [selectedId]: value }));
    if (!value.trim()) setAdoptedDrafts(previous => ({ ...previous, [selectedId]: '' }));
  };
  const staleDraft = !!adoptedDrafts[selectedId] && !drafts.some(d => d.id === adoptedDrafts[selectedId]);
  const isDemo = conversation?.channel === 'simulator';
  const isWechat = conversation?.channel === 'wechat';
  const canSend = isDemo || (conversation?.channel === 'webhook' && !!state?.runtime.bridgeSendConfigured);
  const pendingMedia = messages.slice(-20).filter(message => message.mediaStatus === 'pending');
  const modelIsDemo = state?.settings.provider === 'demo';
  const evidence = new Map(state?.messages.map(message => [message.id, message]) || []);
  const approved = state?.claims.filter(claim => claim.status === 'approved'
    && (claim.scope === null || claim.scope === selectedId)
    && claim.evidenceIds.every(id => {
      const message = evidence.get(id);
      return message?.role === 'self' && !message.aiAssisted && message.source !== 'auto'
        && (!message.kind || message.kind === 'text');
    })).slice(-40).length || 0;
  const pending = state?.claims.filter(c => c.status === 'pending').length || 0;
  const globalOn = !!state?.settings.autoReplyEnabled;
  const autoMode = state?.settings.autoReplyMode ?? 'draft';
  const autoLabel = autoMode === 'draft' ? '自动草稿' : '自动发送';
  const mediaBlocksGeneration = autoMode === 'send' && pendingMedia.length > 0;
  const generate = async () => {
    if (mediaBlocksGeneration) { notify('自动发送模式下，请先查看待处理媒体；草稿模式可先生成供你参考', true); return; }
    await run('suggest', () => api<{ drafts: Draft[] }>(`/conversations/${selectedId}/suggest`, 'POST', { intent }));
  };
  const sendText = async (value: string, explicitDraftId?: string) => {
    if (!value.trim()) return;
    const id = selectedId;
    const sendingPeer = role === 'peer' && isDemo && !explicitDraftId;
    if (!sendingPeer && !canSend) { notify('当前对话仅接收消息，请复制回复后到微信手动发送', true); return; }
    const draftId = explicitDraftId || (!sendingPeer ? adoptedDrafts[id] || undefined : undefined);
    if (draftId && !drafts.some(d => d.id === draftId)) { notify('这条建议已过期，请重新生成回复建议', true); return; }
    const requestKey = `${id}:${sendingPeer ? 'peer' : 'self'}:${draftId || 'manual'}:${value.trim()}`;
    let requestId = sendRequests.current.get(requestKey);
    if (!requestId) { requestId = crypto.randomUUID(); sendRequests.current.set(requestKey, requestId); }
    await run('send', async () => {
      if (sendingPeer) await api(`/conversations/${id}/messages`, 'POST', { text: value.trim(), role: 'peer' });
      else await api(`/conversations/${id}/send`, 'POST', { text: value.trim(), requestId, ...(draftId ? { draftId, reason: draftId === adoptedDrafts[id] ? feedbackReasonById[id]?.trim() || '' : '' } : {}) });
      sendRequests.current.delete(requestKey);
      setTextById(previous => ({ ...previous, [id]: '' }));
      setAdoptedDrafts(previous => ({ ...previous, [id]: '' }));
      setFeedbackReasonById(previous => ({ ...previous, [id]: '' }));
    }, sendingPeer ? '已加入一条演练来信' : isDemo ? '回复已加入本机对话' : '回复已提交至连接的消息通道');
  };
  const saveFeedback = async () => {
    const id = selectedId;
    const draftId = adoptedDrafts[id];
    if (!draftId || staleDraft || !text.trim()) return;
    const reason = feedbackReasonById[id]?.trim() || '';
    const requestKey = JSON.stringify([id, draftId, text.trim(), reason]);
    let requestId = feedbackRequests.current.get(requestKey);
    if (!requestId) { requestId = crypto.randomUUID(); feedbackRequests.current.set(requestKey, requestId); }
    await run('feedback', () => api(`/conversations/${id}/feedback`, 'POST', { draftId, text: text.trim(), reason, requestId }), '反馈已保存在本机，回复未发送');
  };
  const copyReply = async (value: string) => {
    try { await navigator.clipboard.writeText(value); notify('回复已复制，可到微信粘贴发送'); }
    catch { notify('复制未完成，请选中回复文字后手动复制', true); }
  };
  const syncDrafts = () => void run('sync-drafts', () => api(`/conversations/${selectedId}/sync-drafts`, 'POST'), '草稿已同步至服务器，没有发送微信消息');
  const pause = () => void run('pause', () => api('/auto/pause', 'POST'), '已暂停全部自动回复，微信读取由各会话的读取开关控制');
  const readWechatOnce = (target: Conversation) => void run(`wechat-poll-${target.id}`, async () => {
    try { return await api(`/conversations/${target.id}/wechat/poll`, 'POST'); }
    catch (error) { throw new Error(`${target.name}：${error instanceof Error ? error.message : '读取未完成'}`); }
  }, `${target.name}：本次读取已完成`);

  if (!state) return <div className="startup"><div className="brand-symbol"><Leaf size={27} /></div><h1>相知</h1>
    {loadError ? <><p className="error-text">{loadError}</p><Button onClick={() => void refresh()}>重新连接</Button></>
      : <><LoaderCircle className="spin" size={23} /><p>正在打开你的沟通工作台…</p></>}
  </div>;

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" aria-label="相知首页" onClick={event => { event.preventDefault(); setPage('conversations'); }}>
        <span className="brand-symbol"><Leaf size={26} strokeWidth={1.7} /></span><span>相知<small>让了解，自然发生</small></span>
      </a>
      <div className="workspace-label">个人工作台 <span>LOCAL</span></div>
      <nav aria-label="主导航">{navigation.map(item => <button key={item.id} aria-label={item.label} className={`nav-item ${page === item.id ? 'active' : ''}`}
        onClick={() => setPage(item.id)}><item.icon size={19} /><span>{item.label}</span>
        {item.id === 'profile' && pending > 0 && <span className="nav-count">{pending}</span>}
        {item.id === 'conversations' && <span className="nav-count">{state.conversations.length}</span>}
        {item.id === 'drafts' && !!state.cloudDrafts?.length && <span className="nav-count">{state.cloudDrafts.length}</span>}
      </button>)}</nav>
      <div className="sidebar-note"><div className="note-leaf"><HeartHandshake size={23} strokeWidth={1.5} /></div>
        <p>好的关系，<br />从好好说话开始。</p><span>理解自己，也尊重彼此。</span></div>
      <div className="sidebar-bottom"><button aria-label="设置" className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={19} /><span>设置</span></button>
        <div className="local-status"><span className="status-dot" />本地工作空间<ShieldCheck size={14} /></div>
        <div className="user-block"><div className="avatar owner-avatar">我</div><div><strong>我的空间</strong><small>个人沟通助手</small></div><span className="version">v0.1</span></div>
      </div>
    </aside>

    <main className="main-workspace">
      <header className="topbar"><div className="breadcrumb">我的工作台<ChevronRight size={14} /><strong>{page === 'settings' ? '设置' : navigation.find(n => n.id === page)?.label}</strong></div>
        <div className="topbar-actions"><span className={`runtime-badge ${state.runtime.channel === 'webhook' ? 'real' : ''}`}><span className="status-dot" />{state.runtime.bridgeSendConfigured ? '消息桥 · 可发送' : state.runtime.bridgeReceiveConfigured ? '消息桥 · 仅接收' : state.conversations.some(item => item.channel === 'wechat') ? '微信 · 仅读取' : '本机演练'}</span>
          <div className="global-switch"><span>{autoLabel}</span><Toggle checked={globalOn} disabled={!!busy} label={`全局${autoLabel}`} onChange={() => void run('global', () => api('/settings', 'PATCH', { autoReplyEnabled: !globalOn }), !globalOn ? `${autoLabel}已开启，仅作用于已开启的联系人${autoMode === 'draft' ? '；草稿不会自动发送' : ''}` : `${autoLabel}已关闭`)} /></div>
          <button className="pause-button" onClick={pause} disabled={!!busy} title="暂停全部自动草稿与自动发送"><Pause size={14} /><span>暂停回复</span></button>
        </div>
      </header>
      {loadError && <div className="connection-error" role="alert">连接暂时中断：{loadError}。正在尝试重新连接。</div>}
      {page === 'conversations' ? <>
        <div className="page-heading"><div><div className="eyebrow">A LITTLE CLOSER, EVERY DAY</div><h1>每一次对话，都多一点了解<span className="heading-dot">。</span></h1>
          <p>保留你的表达方式，让沟通更自然、更有回应。</p></div><Button kind="secondary" onClick={() => setShowImport(true)}><ArrowDownToLine size={16} />导入聊天记录</Button></div>
        <div className={`conversation-layout ${mobileConversation ? 'mobile-open' : ''}`}>
          <section className="contacts-panel" aria-label="对话列表"><div className="panel-heading"><h2>我的对话 <span>{state.conversations.length}</span></h2><button className="icon-button" onClick={() => setShowNew(true)} aria-label="添加联系人或演练对话" title="添加联系人或演练对话"><Plus size={18} /></button></div>
            <label className="search-field"><Search size={16} /><input placeholder="搜索联系人" value={search} onChange={event => setSearch(event.target.value)} aria-label="搜索联系人" /><span>⌕</span></label>
            <div className="contact-list">{state.conversations.filter(c => c.name.toLowerCase().includes(search.toLowerCase())).map(c => {
              const last = state.messages.filter(m => m.conversationId === c.id).at(-1);
              return <button key={c.id} className={`contact ${selectedId === c.id ? 'selected' : ''}`} onClick={() => { setSelectedId(c.id); setMobileConversation(true); setRole('self'); setIntent(''); }}>
                <span className="avatar" style={{ background: c.color || '#e9e6dc' }}>{c.avatar || c.name.slice(0, 1)}</span><span className="contact-copy"><span className="contact-title"><strong>{c.name}</strong><small>{timeLabel(last?.sentAt || c.updatedAt)}</small></span>
                  <span className="contact-preview">{last?.text || (c.channel === 'wechat' ? '等待读取微信消息' : '从一句问候开始')}</span><span className="contact-meta"><span className={`tiny-dot ${c.autoReplyEnabled && globalOn ? 'on' : ''}`} />{c.channel === 'wechat' ? `微信 · ${c.wechat?.enabled ? '读取已开启' : '读取已暂停'}` : c.autoReplyEnabled && globalOn ? `${autoLabel}中` : c.channel === 'simulator' ? '本机演练' : '手动回复'}</span></span>
              </button>;
            })}{state.conversations.filter(c => c.name.toLowerCase().includes(search.toLowerCase())).length === 0 && <div className="empty-conversation-list"><Empty title={search ? '没有匹配的对话' : '还没有对话'}>{search ? '换个关键词，或添加新的联系人。' : '添加微信联系人，也可以先创建本机演练。'}</Empty><Button kind="secondary" onClick={() => setShowNew(true)}><Plus size={14} />添加联系人</Button></div>}</div>
            <div className="contacts-foot"><ShieldCheck size={14} />原始聊天记录保存在本机</div>
          </section>

          <section className="chat-panel" aria-label="聊天区">
            {conversation ? <>
              <div className="chat-header"><button className="icon-button mobile-back" onClick={() => setMobileConversation(false)} aria-label="返回联系人"><ArrowLeft size={18} /></button>
                <div className="avatar" style={{ background: conversation.color || '#e8ecdf' }}>{conversation.avatar || conversation.name.slice(0, 1)}</div><div className="chat-person"><h2>{conversation.name}</h2><span>{isDemo ? '本机演练 · 不会发送到微信' : isWechat ? '微信仅读取 · 回复需复制到微信发送' : canSend ? '已连接消息通道 · 发送后会实际送出' : '消息桥仅接收 · 回复需复制到微信发送'}</span></div>
                <button className="icon-button" onClick={() => setShowDetails(true)} aria-label="对话详情"><MoreHorizontal size={21} /></button>
              </div>
              <ConversationProcessing key={conversation.id} conversation={conversation} state={state} busy={busy} run={run} onRead={() => readWechatOnce(conversation)} />
              <div className="messages" ref={messageList} onScroll={event => {
                const list = event.currentTarget;
                messageListNearBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 96;
              }} aria-live="polite" aria-relevant="additions text">
                <div className="conversation-start"><span />{messages.length ? dateLabel(messages[0].sentAt) : '从这里开始'}<span /></div>
                {messages.map((message, index) => <div key={message.id} className={`message-row ${message.role}`}>
                  {message.role === 'peer' && <span className="avatar message-avatar" style={{ background: conversation.color || '#e8ecdf' }}>{conversation.avatar || conversation.name.slice(0, 1)}</span>}
                  <div className="message-content"><div className={`bubble ${message.mediaStatus === 'pending' ? 'media-pending' : ''}`}>{message.mediaStatus && <span className={`media-label ${message.mediaStatus}`}><FileText size={12} />{messageKindLabels[message.kind ?? 'unknown']} · {message.mediaStatus === 'pending' ? '未解析' : '已人工查看'}</span>}{messageDisplayText(message)}</div>{message.mediaStatus === 'pending' && <MediaReview message={message} busy={busy} run={run} />}<div className="message-meta">{timeLabel(message.sentAt)}{message.source === 'wechat' && <span>微信读取</span>}{message.source === 'auto' && <span><Sparkles size={10} />自动回复</span>}{message.aiAssisted && message.source !== 'auto' && <span>辅助表达</span>}{message.role === 'self' && index === messages.length - 1 && <CheckCheck size={12} />}</div></div>
                </div>)}
                {!messages.length && <div className="empty-chat-start"><Empty title={isWechat ? '等待读取微信消息' : '给这段对话一个开始'}>{isWechat ? '点击下方读取上下文，或在上方“信息处理”开启持续读取。' : isDemo ? '可以发送一句话，或用下方「模拟来信」体验自动回复。' : '消息通道收到来信后，会显示在这里。'}</Empty>{isWechat && <Button kind="secondary" disabled={!!busy || !state.runtime.wechatAvailable || conversation.wechat?.status === 'reading'} onClick={() => readWechatOnce(conversation)}>{busy === `wechat-poll-${conversation.id}` || conversation.wechat?.status === 'reading' ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}读取微信上下文</Button>}</div>}
                {currentJob && <div className="job-indicator"><LoaderCircle size={14} className="spin" /><span>{currentJob.status === 'generating' ? '正在组织回复…' : `${Math.max(0, Math.ceil((new Date(currentJob.dueAt).getTime() - now) / 1000))} 秒后${(currentJob.mode ?? autoMode) === 'draft' ? '生成草稿' : '自动发送'}`}</span><button onClick={pause}>暂停</button></div>}
              </div>
              <div className="composer"><div className="composer-toolbar"><div className="segmented"><button className={role === 'self' ? 'active' : ''} onClick={() => setRole('self')}>我的回复</button>{isDemo && <button className={role === 'peer' ? 'active' : ''} onClick={() => setRole('peer')}>模拟来信</button>}</div><span>{role === 'peer' ? '以对方身份加入一条演练消息' : '用你的方式，好好说话'}</span></div>
                <textarea value={text} placeholder={role === 'peer' ? '输入一条对方的消息，体验自动草稿或回复…' : '写下你的回复，或先看看右侧的表达建议…'} aria-label={role === 'peer' ? '模拟对方消息' : '回复内容'} onChange={event => setText(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void sendText(text); } }} />
                {role === 'self' && staleDraft && <div className="stale-draft" role="status">对话或档案已变化，请重新生成建议后再保存反馈或发送。<button onClick={() => setText('')}>清空并重新编辑</button></div>}
                {role === 'self' && adoptedDrafts[selectedId] && !staleDraft && <div className="feedback-composer"><label htmlFor="feedback-reason">调整原因（可选）</label><input id="feedback-reason" value={feedbackReasonById[selectedId] || ''} maxLength={500} onChange={event => setFeedbackReasonById(previous => ({ ...previous, [selectedId]: event.target.value }))} placeholder="例如：这里先确认情况，不急着安慰" /><div><small>仅保存反馈会保留输入；发送采用的草稿成功后也会记录反馈。</small><Button kind="secondary" disabled={!text.trim() || !!busy} onClick={() => void saveFeedback()}>{busy === 'feedback' ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}仅保存反馈</Button></div></div>}
                {role === 'self' && !canSend && <p className="receive-only-note">当前仅读取消息。可保存反馈，再复制回复到微信手动发送。</p>}
                <div className="composer-bottom"><span><ShieldCheck size={12} />{isDemo ? '消息仅保存在本机' : canSend ? '消息将通过已配置通道发送' : isWechat ? '微信采集仅读取消息' : '发送通道未配置'}{canSend && <kbd>⌘ ↵</kbd>}</span><div className="composer-actions">{role === 'self' && <Button kind="secondary" disabled={!text.trim() || !!busy} onClick={() => void copyReply(text)}><Copy size={14} />复制</Button>}{canSend && <Button disabled={!text.trim() || !!busy || (role === 'self' && staleDraft)} onClick={() => void sendText(text)}>{busy === 'send' ? <LoaderCircle size={15} className="spin" /> : role === 'peer' ? <Plus size={15} /> : <Send size={15} />}{role === 'peer' ? '加入来信' : isDemo ? '发送到演练' : '发送消息'}</Button>}</div></div>
              </div>
            </> : <Empty title="选择一段对话">从左侧添加微信联系人，或新建演练对话。</Empty>}
          </section>

          <aside className="suggestions-panel" aria-label="表达建议"><div className="panel-heading"><h2><Sparkles size={17} />表达建议</h2><span className="label-pill">{modelIsDemo ? '规则演示' : state.settings.provider === 'codex' ? 'Codex' : 'AI 辅助'}</span></div>
            <p className="panel-description">多一种表达，仍然是你。</p>
            <div className="context-card"><div className="context-icon"><UserRound size={17} /></div><div><strong>{state.runtime.learnedProfileError ? '习惯档案加载异常' : state.learnedProfile ? `习惯档案 v${state.learnedProfile.version} 已加载` : '个人信息档案'}</strong><p>{approved} 条已确认信息 · <button onClick={() => setPage('profile')}>查看档案 <ChevronRight size={12} /></button></p></div></div>
            <label className="intent-label" htmlFor="intent">这一次，你想表达什么？</label><textarea id="intent" className="intent-input" rows={2} placeholder="例如：关心一下，顺便聊聊周末安排" value={intent} onChange={event => setIntent(event.target.value)} />
            <div className="intent-chips">{['自然接话', '表达关心', '轻松邀约'].map(chip => <button key={chip} className={intent === chip ? 'selected' : ''} onClick={() => setIntent(chip)}>{chip}</button>)}</div>
            <Button className="generate-button" onClick={() => void generate()} disabled={!!busy || !conversation || messages.at(-1)?.role !== 'peer' || mediaBlocksGeneration}>{busy === 'suggest' ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{busy === 'suggest' ? '正在整理表达…' : '生成回复建议'}</Button>
            {pendingMedia.length > 0 && <p className="pending-media-notice" role="status"><CircleHelp size={14} /><span>最近 20 条消息中有 {pendingMedia.length} 条媒体未解析。{mediaBlocksGeneration ? '自动发送模式下需先查看，或切回草稿模式继续生成。' : '可直接生成草稿；模型只参考已有文字，不会假装理解图片或语音。'}也可在对应消息下补充内容。</span></p>}
            {modelIsDemo && <p className="demo-disclosure">当前为本地规则演示，未调用 AI 模型。<button onClick={() => setPage('settings')}>配置模型</button></p>}
            {conversation && <div className="draft-sync-panel"><Button kind="secondary" disabled={!state.runtime.draftSyncConfigured || !drafts.length || !!busy || currentUpload?.status === 'uploading' || currentDraftsUploaded} onClick={syncDrafts}>{busy === 'sync-drafts' || currentUpload?.status === 'uploading' ? <LoaderCircle size={14} className="spin" /> : <Cloud size={14} />}{currentDraftsUploaded ? '当前草稿已同步' : currentUpload?.status === 'failed' && uploadMatchesCurrentDrafts ? '重试同步草稿至服务器' : '同步草稿至服务器'}</Button><p>{state.runtime.draftSyncConfigured ? '仅上传候选回复、联系人显示名和档案版本。' : '先在设置中查看草稿同步配置。'}</p>{currentUpload && <p className={`draft-upload-status ${currentUpload.status}`} role="status"><strong>最近同步：{currentUpload.status === 'uploaded' ? '服务器已确认' : currentUpload.status === 'uploading' ? '正在同步' : '结果未确认'}</strong> · {timeLabel(currentUpload.finishedAt || currentUpload.createdAt)}<span>{currentUpload.detail}</span></p>}</div>}
            <div className="draft-list">{drafts.length ? drafts.map((draft, index) => <article className="draft-card" key={draft.id}><div className="draft-top"><span className="draft-number">0{index + 1}</span><h3>{draft.label}</h3></div><p className="draft-text">{draft.text}</p><p className="draft-reason">{draft.reason}{draft.provider === 'codex' && <span className="draft-profile">由 Codex 生成</span>}{draft.profileVersion && <span className="draft-profile">参考习惯档案 v{draft.profileVersion}</span>}</p><div className="draft-actions"><button onClick={() => { setRole('self'); setText(draft.text); if (adoptedDrafts[selectedId] !== draft.id) setFeedbackReasonById(previous => ({ ...previous, [selectedId]: '' })); setAdoptedDrafts(previous => ({ ...previous, [selectedId]: draft.id })); notify('已放入回复框，可以继续修改'); }}>采用并编辑 <ArrowRight size={13} /></button>{canSend ? <button className="draft-send" disabled={!!busy} title="发送这条建议" onClick={() => void sendText(draft.text, draft.id)} aria-label={isDemo ? '将建议发送到演练' : '发送这条建议'}><Send size={14} /></button> : <button className="draft-send" title="复制这条建议" onClick={() => void copyReply(draft.text)} aria-label="复制这条建议"><Copy size={14} /></button>}</div></article>) : <div className="suggestion-empty"><span><MessageCircle size={26} strokeWidth={1.4} /></span><p>听懂对方，再认真回应。</p><small>有了对方的消息，就可以生成表达建议。</small></div>}</div>
            {conversation && <FeedbackHistory state={state} conversationId={selectedId} busy={busy} run={run} compact />}
            <div className="gentle-tip"><Leaf size={15} /><p>建议是灵感，真实的感受由你决定。<br />不要把聊天热度当作对方的承诺。</p></div>
          </aside>
        </div>
        <footer className="workspace-footer"><span>相知 · 每段关系，都有自己的节奏</span><span><span className="status-dot" />{globalOn ? `${autoLabel}已开启 · ${state.conversations.filter(c => c.autoReplyEnabled).length} 个对话` : `${autoLabel}已暂停`}<span className="footer-divider" />{state.runtime.modelLabel}</span></footer>
      </> : <div className="other-page">
        {page === 'profile' && <ProfilePage state={state} selectedId={selectedId} busy={busy} run={run} />}
        {page === 'knowledge' && <KnowledgePage state={state} />}
        {page === 'settings' && <SettingsPage state={state} notify={notify} refresh={refresh} />}
        {page === 'drafts' && <CloudDraftsPage state={state} busy={busy} run={run} copyReply={copyReply} />}
        {page === 'activity' && <ActivityPage state={state} now={now} />}
      </div>}
    </main>
    {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <CircleHelp size={17} /> : <Check size={17} />}<span>{toast.message}</span><button onClick={() => setToast(null)} aria-label="关闭提示"><X size={15} /></button></div>}
    {showImport && <ImportDialog onClose={() => setShowImport(false)} notify={notify} onDone={async id => { await refresh(); setSelectedId(id); setShowImport(false); setPage('conversations'); setMobileConversation(true); }} />}
    {showNew && <AddConversationDialog state={state} notify={notify} onClose={() => setShowNew(false)} onAdded={async id => { await refresh(); setSelectedId(id); setSearch(''); setPage('conversations'); setMobileConversation(true); setRole('self'); setIntent(''); setShowNew(false); }} />}
    {showDetails && conversation && <ConversationDetails conversation={conversation} onClose={() => setShowDetails(false)} busy={busy} run={run} />}
  </div>;
}

type Run = <T>(key: string, action: () => Promise<T>, success?: string) => Promise<T | undefined>;

function ConversationProcessing({ conversation, state, busy, run, onRead }: {
  conversation: Conversation; state: PublicState; busy: string; run: Run; onRead: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isWechat = conversation.channel === 'wechat';
  const autoMode = state.settings.autoReplyMode ?? 'draft';
  const autoLabel = isWechat || autoMode === 'draft' ? '自动草稿' : '自动发送';
  const autoStatus = isWechat && autoMode === 'send' ? '需切回草稿模式'
    : conversation.autoReplyEnabled ? state.settings.autoReplyEnabled ? '已开启' : '等待全局开启' : '已关闭';
  const reading = conversation.wechat?.status === 'reading' || busy === `wechat-poll-${conversation.id}`;
  const readStatus = reading ? '读取中' : conversation.wechat?.status === 'error' ? '读取异常'
    : conversation.wechat?.enabled ? '持续读取已开启' : '读取已暂停';
  const lastJob = state.jobs.filter(job => job.conversationId === conversation.id).at(-1);
  const processingError = lastJob && ['failed', 'blocked'].includes(lastJob.status) ? lastJob.detail || jobLabels[lastJob.status] : '';
  const readError = isWechat && conversation.wechat?.status === 'error' ? conversation.wechat.detail : '';
  return <section className={`conversation-processing ${expanded ? 'expanded' : ''}`} aria-label={`${conversation.name}的信息处理`}>
    <div className="processing-summary"><button className="processing-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Settings2 size={13} />信息处理<ChevronDown size={12} /></button><span className="processing-overview">{isWechat && `${readStatus} · `}{autoLabel}{autoStatus}</span>{isWechat && <Button kind="ghost" disabled={!!busy || !state.runtime.wechatAvailable || reading} onClick={onRead}>{reading ? <LoaderCircle size={12} className="spin" /> : <ArrowDownToLine size={12} />}读取一次</Button>}</div>
    {!expanded && (readError || processingError) && <p className="processing-error" role="status">{readError ? `读取：${readError}` : `最近处理：${processingError}`}</p>}
    {expanded && <div className="processing-body"><div className="processing-controls">{isWechat && <div><span>持续读取<small>每 15 秒检查新消息</small></span><Toggle small checked={!!conversation.wechat?.enabled} disabled={!!busy || (!state.runtime.wechatAvailable && !conversation.wechat?.enabled)} label={`读取${conversation.name}的微信消息`} onChange={() => void run(`wechat-toggle-${conversation.id}`, () => api(`/conversations/${conversation.id}/wechat`, 'PATCH', { enabled: !conversation.wechat?.enabled }), `${conversation.name}：${conversation.wechat?.enabled ? '持续读取已暂停' : '持续读取已开启'}`)} /></div>}<div><span>{autoLabel}<small>{autoStatus}</small></span><Toggle small checked={conversation.autoReplyEnabled} disabled={!!busy || (isWechat && autoMode === 'send' && !conversation.autoReplyEnabled)} label={`${conversation.name}的${autoLabel}`} onChange={() => void run(`contact-toggle-${conversation.id}`, () => api(`/conversations/${conversation.id}`, 'PATCH', { autoReplyEnabled: !conversation.autoReplyEnabled }))} /></div></div>
      {isWechat && <div className={`processing-read-status ${readError ? 'error' : ''}`} role="status"><p>{!state.runtime.wechatAvailable ? state.runtime.wechatStatus : conversation.wechat?.detail || '尚未读取。点击“读取一次”载入上下文，或开启持续读取。'}</p><small>{conversation.wechat?.lastCheckedAt ? `上次检查 ${dateLabel(conversation.wechat.lastCheckedAt)} ${checkedTimeLabel(conversation.wechat.lastCheckedAt)}` : '尚未检查消息'}</small></div>}
      {lastJob ? <div className={`processing-result ${processingError ? 'error' : ''}`}><span>最近处理 · {jobLabels[lastJob.status]}<time>{timeLabel(lastJob.finishedAt || lastJob.createdAt)}</time></span>{lastJob.detail && <p>{lastJob.detail}</p>}</div> : <p className="processing-no-result">还没有自动处理记录。{conversation.autoReplyEnabled && !state.settings.autoReplyEnabled ? '开启顶部全局开关后，才会处理新的来信。' : '已有消息只作上下文，开启后处理新来信。'}</p>}
    </div>}
  </section>;
}

function MediaReview({ message, busy, run }: { message: Message; busy: string; run: Run }) {
  const [summary, setSummary] = useState('');
  const key = `review-media-${message.id}`;
  return <details className="media-review"><summary>查看或补充内容（可选）<ChevronDown size={12} /></summary>
    <p>本机尚未解析这条{messageKindLabels[message.kind ?? 'unknown']}。请查看原内容，可补充对回复有帮助的信息。</p>
    <label className="field-label" htmlFor={`media-summary-${message.id}`}>内容说明（可选）<textarea id={`media-summary-${message.id}`} rows={2} maxLength={1000} value={summary} onChange={event => setSummary(event.target.value)} placeholder="例如：语音说周六下午有空，想一起吃饭" /></label>
    <small>留空仅记录你已查看，模型仍不知道媒体的具体内容。</small>
    <Button kind="secondary" disabled={!!busy} onClick={() => void run(key, () => api(`/messages/${message.id}/review-media`, 'POST', { ...(summary.trim() ? { summary: summary.trim() } : {}) }), summary.trim() ? '已保存内容说明，可重新生成建议' : '已标记人工查看，未识别媒体内容')}>{busy === key ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}{summary.trim() ? '保存说明并确认已查看' : '我已在微信查看'}</Button>
  </details>;
}

function FeedbackHistory({ state, conversationId, busy, run, compact = false }: { state: PublicState; conversationId: string; busy: string; run: Run; compact?: boolean }) {
  const feedback = (state.feedback || []).filter(item => item.conversationId === conversationId).slice(-5).reverse();
  const name = state.conversations.find(item => item.id === conversationId)?.name;
  return <details className={`feedback-history ${compact ? 'compact' : ''}`}><summary><span>{compact ? '本对话最近反馈' : `${name || '当前对话'} · 最近反馈`}</span><span>{feedback.length} 条<ChevronDown size={13} /></span></summary>
    <p className="feedback-explanation">反馈保存在本机，作为后续回复的参考；不会直接训练模型参数。</p>
    {feedback.length ? feedback.map(item => <article className="feedback-item" key={item.id}><div className="feedback-item-top"><strong>{item.kind === 'edited' ? '已改写' : '保留原样'}</strong><span>{item.source === 'send' ? '发送反馈' : '仅保存反馈'} · {dateLabel(item.createdAt)}</span><button className="icon-button" aria-label="删除这条反馈" disabled={!!busy} onClick={() => void run('delete-feedback', () => api(`/feedback/${item.id}`, 'DELETE'), '反馈已删除')}><Trash2 size={13} /></button></div>{item.kind === 'edited' && <p className="feedback-original">原建议：{item.originalText}</p>}<p>{item.revisedText}</p>{item.reason && <small>调整原因：{item.reason}</small>}{item.profileVersion && <small>参考档案 v{item.profileVersion}</small>}</article>) : <p className="feedback-explanation">采用一条建议后，可以修改并保存反馈。</p>}
  </details>;
}

function ConversationDetails({ conversation, onClose, busy, run }: { conversation: Conversation; onClose: () => void; busy: string; run: Run }) {
  const [name, setName] = useState(conversation.name);
  const [note, setNote] = useState(conversation.note);
  const [confirmDelete, setConfirmDelete] = useState(false);
  return <Modal title="对话详情" description="记录背景，帮助自己更好地理解这段对话。" onClose={onClose}><form onSubmit={event => { event.preventDefault(); void run('details', async () => { await api(`/conversations/${conversation.id}`, 'PATCH', { name, note }); onClose(); }, '对话信息已更新'); }}><label className="field-label">称呼<input required value={name} onChange={event => setName(event.target.value)} /></label><label className="field-label">备注<textarea rows={4} value={note} onChange={event => setNote(event.target.value)} placeholder="例如：朋友介绍认识，喜欢徒步。" /></label><div className="info-box"><ShieldCheck size={16} />{conversation.channel === 'simulator' ? '本机演练，不会发送到微信。' : conversation.channel === 'wechat' ? '微信仅读取。删除这里的对话不会删除微信原始聊天记录。' : '此对话已连接外部消息通道。'}</div><div className="modal-footer split"><Button kind="danger" onClick={() => setConfirmDelete(true)} disabled={!!busy}><Trash2 size={14} />删除对话</Button><Button type="submit" disabled={!!busy || !name.trim()}>保存信息</Button></div>{confirmDelete && <div className="delete-confirm"><p>删除这段对话及关联数据？此操作无法撤销。</p><Button kind="danger" disabled={!!busy} onClick={() => void run('delete', async () => { await api(`/conversations/${conversation.id}`, 'DELETE'); onClose(); }, '对话已删除')}>确认删除</Button><Button kind="ghost" onClick={() => setConfirmDelete(false)}>保留对话</Button></div>}</form></Modal>;
}

function ProfilePage({ state, selectedId, busy, run }: { state: PublicState; selectedId: string; busy: string; run: Run }) {
  const [filter, setFilter] = useState<'approved' | 'pending' | 'all'>('approved');
  const [adding, setAdding] = useState(false);
  const [statement, setStatement] = useState('');
  const [category, setCategory] = useState<ProfileClaim['category']>('preference');
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [extractId, setExtractId] = useState(selectedId || state.conversations[0]?.id || '');
  const claims = state.claims.filter(c => filter === 'all' || c.status === filter);
  return <><div className="section-heading"><div className="eyebrow">GET TO KNOW YOURSELF</div><h1>更了解你，才能更像你。</h1><p>由你确认的事实与偏好，才会成为回复的参考。</p></div>
    <div className="profile-overview"><div><span className="large-avatar"><UserRound size={27} /></span><div><h2>我的沟通档案</h2><p>随时修正，不给自己贴固定标签。</p></div></div><div className="profile-stats"><span><strong>{state.claims.filter(c => c.status === 'approved').length}</strong>已确认</span><span><strong>{state.claims.filter(c => c.status === 'pending').length}</strong>待你确认</span></div></div>
    <section className="learned-profile-card"><div className="learned-profile-heading"><div><h2>{state.learnedProfile ? `习惯档案 v${state.learnedProfile.version}` : '习惯档案尚未加载'}</h2><p>{state.learnedProfile ? `${state.learnedProfile.rules.length} 条表达规则 · ${state.learnedProfile.examples.length} 个校准例子` : '加载本机已有的习惯档案，让新回复参考你的校准结果。'}</p></div><Button kind="secondary" disabled={!!busy} onClick={() => void run('reload-profile', () => api('/profile/reload', 'POST'), '习惯档案已重新加载')}><ArrowDownToLine size={14} />{busy === 'reload-profile' ? '加载中…' : '重新加载'}</Button></div>
      {state.runtime.learnedProfileError && <div className="inline-error" role="alert">加载未完成：{state.runtime.learnedProfileError}</div>}
      {state.learnedProfile && <><p className="learned-profile-caption">{state.learnedProfile.title} · {dateLabel(state.learnedProfile.loadedAt)} {timeLabel(state.learnedProfile.loadedAt)} 加载{state.settings.provider === 'demo' ? '。当前规则演示不会调用模型学习这些规则。' : '。新生成的回复会参考这些规则，并记录档案版本。'}</p><details className="learned-profile-details"><summary>查看表达规则与校准例子<ChevronDown size={14} /></summary><div className="learned-rule-list">{state.learnedProfile.rules.map(rule => <article key={rule.id}><strong>{rule.rule}</strong>{rule.limitation && <p>适用限制：{rule.limitation}</p>}{rule.evidenceIds.length > 0 && <small>校准来源：{rule.evidenceIds.join('、')}</small>}</article>)}</div><h3>校准例子</h3>{state.learnedProfile.examples.slice(0, 5).map(example => <article className="learned-example" key={example.id}><p>{example.situation}</p><blockquote>{example.reply}</blockquote></article>)}{state.learnedProfile.examples.length > 5 && <p className="learned-profile-caption">这里展示前 5 个例子，生成时会按当前对话选择参考。</p>}{state.learnedProfile.limitations.length > 0 && <div className="learned-limitations">{state.learnedProfile.limitations.map((limitation, index) => <p key={index}>{limitation}</p>)}</div>}</details></>}
    </section>
    {selectedId && <FeedbackHistory state={state} conversationId={selectedId} busy={busy} run={run} />}
    <div className="profile-tools"><div className="tabs">{(['approved', 'pending', 'all'] as const).map(f => <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f === 'approved' ? '已确认档案' : f === 'pending' ? '待确认线索' : '全部信息'}{f === 'pending' && <span>{state.claims.filter(c => c.status === 'pending').length}</span>}</button>)}</div><Button kind="secondary" onClick={() => setAdding(true)}><Plus size={15} />补充一条</Button></div>
    <div className="extract-bar"><Sparkles size={18} /><span>从对话中发现关于你的线索</span><select value={extractId} onChange={event => setExtractId(event.target.value)} aria-label="选择提取档案的对话">{state.conversations.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Button kind="secondary" disabled={!!busy || !extractId} onClick={() => void run('extract', async () => { const result = await api(`/conversations/${extractId}/extract`, 'POST'); setFilter('pending'); return result; }, '已整理线索，请逐条确认')}><Sparkles size={14} />{busy === 'extract' ? '整理中…' : '提取线索'}</Button></div>
    <div className="claim-grid">{claims.map(claim => <article className="claim-card" key={claim.id}><div className="claim-header"><span className={`category-tag ${claim.category}`}>{categoryLabels[claim.category]}</span><span className={`claim-status ${claim.status}`}>{claim.status === 'approved' ? '已确认' : claim.status === 'pending' ? '待确认' : '已忽略'}</span></div>
      {editing === claim.id ? <textarea className="edit-claim" rows={3} value={editText} onChange={event => setEditText(event.target.value)} /> : <h3>{claim.statement}</h3>}
      <p className="claim-evidence">{claim.evidenceIds.length > 0 ? `${claim.evidenceIds.length} 条对话证据` : '手动补充'} · {claim.scope ? state.conversations.find(c => c.id === claim.scope)?.name || '特定对话' : '用于我的整体档案'}</p>
      {claim.evidenceIds.length > 0 && <details className="evidence-details"><summary>查看来源<ChevronDown size={12} /></summary>{claim.evidenceIds.map(id => { const msg = state.messages.find(m => m.id === id); return <blockquote key={id}>{msg ? msg.text : '来源消息已不可用'}</blockquote>; })}</details>}
      <div className="claim-actions">{editing === claim.id ? <><button disabled={!!busy || !editText.trim()} onClick={() => void run('claim-edit', async () => { await api(`/claims/${claim.id}`, 'PATCH', { statement: editText }); setEditing(null); })}><Check size={13} />保存</button><button onClick={() => setEditing(null)}>取消</button></> : <>
        {claim.status !== 'approved' && <button disabled={!!busy} onClick={() => void run('claim-approve', () => api(`/claims/${claim.id}`, 'PATCH', { status: 'approved' }))}><Check size={13} />确认符合</button>}<button onClick={() => { setEditing(claim.id); setEditText(claim.statement); }}>修改</button>{claim.status === 'pending' && <button disabled={!!busy} onClick={() => void run('claim-reject', () => api(`/claims/${claim.id}`, 'PATCH', { status: 'rejected' }))}>不符合</button>}<button className="claim-delete" aria-label="删除档案信息" disabled={!!busy} onClick={() => void run('claim-delete', () => api(`/claims/${claim.id}`, 'DELETE'))}><Trash2 size={13} /></button></>}</div></article>)}</div>
    {!claims.length && <Empty icon={UserRound} title={filter === 'pending' ? '暂时没有待确认的线索' : '从一条真实的信息开始'}>可以手动补充，或从选择的对话中提取线索。</Empty>}
    {adding && <Modal title="补充我的档案" description="告诉相知，你希望它记住的真实信息。" onClose={() => setAdding(false)}><form onSubmit={event => { event.preventDefault(); void run('claim-add', async () => { await api('/claims', 'POST', { category, statement }); setAdding(false); setStatement(''); }, '已补充到档案'); }}><label className="field-label">信息类型<select value={category} onChange={event => setCategory(event.target.value as ProfileClaim['category'])}>{Object.entries(categoryLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><label className="field-label">我想让你记住<textarea autoFocus required rows={4} value={statement} onChange={event => setStatement(event.target.value)} placeholder="例如：我更习惯直接、简短的表达，不太喜欢用很多表情。" /></label><div className="modal-footer"><Button kind="secondary" onClick={() => setAdding(false)}>取消</Button><Button type="submit" disabled={!!busy || !statement.trim()}>保存档案</Button></div></form></Modal>}
  </>;
}

function KnowledgePage({ state }: { state: PublicState }) {
  const [query, setQuery] = useState('');
  return <><div className="section-heading"><div className="eyebrow">THOUGHTFUL COMMUNICATION</div><h1>理解关系，也理解分寸。</h1><p>有出处的沟通知识，为表达提供参考。每一段关系，都需要具体理解。</p></div><div className="knowledge-intro"><BookOpen size={26} strokeWidth={1.5} /><div><h2>带着理解去沟通</h2><p>研究提供线索，不能预测某个人的感受，也不能保证关系的结果。</p></div><span>{state.knowledge.length} 篇参考</span></div>
    <label className="search-field knowledge-search"><Search size={17} /><input aria-label="搜索沟通知识" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索倾听、表达、边界…" /></label>
    <div className="knowledge-grid">{state.knowledge.filter(k => `${k.title} ${k.summary} ${k.application}`.includes(query)).map((k, index) => <article className="knowledge-card" key={k.id}><div className="knowledge-card-top"><span className="knowledge-number">0{index + 1}</span><span className="label-pill">{k.kind === 'research' ? '研究参考' : '沟通原则'}</span></div><h2>{k.title}</h2><p>{k.summary}</p><div className="knowledge-application"><h3><Leaf size={14} />可以怎样用</h3><p>{k.application}</p></div><div className="knowledge-limit"><strong>适用边界</strong><p>{k.limitation}</p></div><div className="knowledge-source"><span>{k.author} · {k.year}</span><a href={k.url} target="_blank" rel="noreferrer">阅读来源<ArrowRight size={13} /></a></div></article>)}</div>
    {!state.knowledge.filter(k => `${k.title} ${k.summary} ${k.application}`.includes(query)).length && <Empty icon={BookOpen} title="没有找到相关内容">试试其他关键词。</Empty>}
  </>;
}

function CloudDraftsPage({ state, busy, run, copyReply }: {
  state: PublicState; busy: string; run: Run; copyReply: (text: string) => Promise<void>;
}) {
  const batches = [...(state.cloudDrafts ?? [])].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const providerNames: Record<Settings['provider'], string> = { demo: '本地规则演示', codex: 'Codex', ollama: 'Ollama', compatible: '兼容 API' };
  return <><div className="section-heading"><div className="eyebrow">YOUR REPLIES, READY TO REVIEW</div><h1>草稿在这里，决定仍由你。</h1><p>Mac 生成回复后同步到服务器，方便你查看和复制。此页面只管理草稿。</p></div>
    <div className="cloud-inbox-intro"><Cloud size={23} /><div><strong>{state.runtime.draftInboxConfigured ? '草稿接收已配置' : '草稿接收尚未配置'}</strong><p>{state.runtime.draftInboxConfigured ? '显示这台服务器收到的候选回复；复制后可到微信手动发送。' : '在腾讯云服务器配置草稿接收后，Mac 即可向这里同步回复。'}</p></div><span>{batches.length} 批草稿</span></div>
    <p className="cloud-history-note">这里保留的是上传时的候选回复；Mac 收到新消息后，已上传批次不会自动删除。使用前请以 Mac 的最新对话为准。</p>
    <div className="cloud-draft-list">{batches.map(batch => <section className="cloud-draft-batch" key={batch.id}><div className="cloud-draft-heading"><div><h2>{batch.conversationName}</h2><p>{providerNames[batch.provider]}{batch.profileVersion && ` · 习惯档案 v${batch.profileVersion}`}<span>生成于 {dateLabel(batch.createdAt)} {timeLabel(batch.createdAt)} · 收到于 {dateLabel(batch.receivedAt)} {timeLabel(batch.receivedAt)}</span></p></div><button className="icon-button" aria-label={`删除${batch.conversationName}的这批云端草稿`} title="删除这批云端草稿" disabled={!!busy} onClick={() => void run(`delete-cloud-${batch.id}`, () => api(`/sync/drafts/${batch.id}`, 'DELETE'), '已删除这批云端草稿，本机原稿不受影响')}>{busy === `delete-cloud-${batch.id}` ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}</button></div><div className="cloud-draft-grid">{batch.drafts.map((draft, index) => <article className="cloud-draft-candidate" key={index}><div className="cloud-candidate-title"><span>0{index + 1}</span><h3>{draft.label}</h3></div><p className="cloud-candidate-text">{draft.text}</p>{draft.reason && <p className="cloud-candidate-reason">{draft.reason}</p>}<Button kind="secondary" onClick={() => void copyReply(draft.text)}><Copy size={13} />复制回复</Button></article>)}</div></section>)}</div>
    {!batches.length && <Empty icon={Cloud} title="还没有同步的草稿">在 Mac 生成回复后，点击“同步草稿至服务器”，或在设置中开启生成后同步。</Empty>}
  </>;
}

function WechatContactPicker({ state, notify, onAdded }: {
  state: PublicState; notify: (message: string, error?: boolean) => void; onAdded: (id: string) => Promise<void>;
}) {
  const [selectionMode, setSelectionMode] = useState<'search' | 'manual'>('search');
  const [manualName, setManualName] = useState('');
  const [manualExternalId, setManualExternalId] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactResults, setContactResults] = useState<{ contacts: { externalId: string; name: string }[]; hasMore: boolean } | null>(null);
  const [selectedContact, setSelectedContact] = useState<{ externalId: string; name: string } | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [bindError, setBindError] = useState('');
  const contactSearchRequest = useRef(0);
  useEffect(() => () => { contactSearchRequest.current += 1; }, []);
  const name = selectionMode === 'manual' ? manualName.trim() : selectedContact?.name ?? '';
  const externalId = selectionMode === 'manual' ? manualExternalId.trim() : selectedContact?.externalId ?? '';
  const [busy, setBusy] = useState('');
  const conversations = state.conversations.filter(item => item.channel === 'wechat');
  const existingConversation = conversations.find(item => item.externalId === externalId.trim());
  const alreadyBound = !!existingConversation;
  const searchContacts = async () => {
    if (!contactQuery.trim() || !state.runtime.wechatAvailable) return;
    const request = ++contactSearchRequest.current;
    setSearching(true); setSearchError(''); setContactResults(null);
    try {
      const result = await api<{ contacts: { externalId: string; name: string }[]; hasMore: boolean }>(`/wechat/contacts?q=${encodeURIComponent(contactQuery.trim())}`);
      if (request === contactSearchRequest.current) setContactResults(result);
    } catch (error) {
      if (request === contactSearchRequest.current) setSearchError(error instanceof Error ? error.message : '联系人搜索未完成，请重试或手动填写 ID');
    } finally { if (request === contactSearchRequest.current) setSearching(false); }
  };
  const addConversation = async () => {
    if (existingConversation) { await onAdded(existingConversation.id); return; }
    if (!name || !externalId) return;
    setBusy('bind'); setBindError('');
    try {
      const result = await api<Conversation>('/wechat/conversations', 'POST', { name, externalId });
      await onAdded(result.id);
      notify('微信会话已添加，可在对话内开启读取和自动草稿');
    } catch (error) { setBindError(error instanceof Error ? error.message : '会话添加未完成，请重试'); }
    finally { setBusy(''); }
  };
  return <div className="wechat-contact-picker">
    {!state.runtime.wechatAvailable && <div className="wechat-reader-status unavailable" role="status"><span className="status-dot" /><div><strong>本机微信读取工具暂不可用</strong><p>{state.runtime.wechatStatus}</p></div></div>}
    <div className="tabs wechat-selection-tabs"><button type="button" aria-pressed={selectionMode === 'search'} className={selectionMode === 'search' ? 'active' : ''} onClick={() => setSelectionMode('search')}>按备注或昵称搜索</button><button type="button" aria-pressed={selectionMode === 'manual'} className={selectionMode === 'manual' ? 'active' : ''} onClick={() => setSelectionMode('manual')}>手动填写 ID</button></div>
    {selectionMode === 'search' && <div className="wechat-contact-search">
      <form className="wechat-contact-search-form" onSubmit={event => { event.preventDefault(); void searchContacts(); }}><label className="search-field"><Search size={16} /><input aria-label="搜索微信联系人" placeholder="输入备注或昵称" value={contactQuery} maxLength={100} onChange={event => { contactSearchRequest.current += 1; setContactQuery(event.target.value); setContactResults(null); setSelectedContact(null); setSearchError(''); setSearching(false); }} /></label><Button kind="secondary" type="submit" disabled={!!busy || searching || !state.runtime.wechatAvailable || !contactQuery.trim()}>{searching ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}搜索联系人</Button></form>
      <p className="wechat-search-hint">搜索只读取联系人名称与 ID，不读取聊天内容。</p>
      {searchError && <p className="inline-error" role="alert">{searchError}</p>}
      {contactResults && <div className="wechat-contact-results" aria-label="微信联系人搜索结果">{contactResults.contacts.length ? contactResults.contacts.map(contact => <button type="button" className={`wechat-contact-result ${selectedContact?.externalId === contact.externalId ? 'selected' : ''}`} aria-pressed={selectedContact?.externalId === contact.externalId} key={contact.externalId} onClick={() => setSelectedContact(contact)}><span className="avatar">{contact.name.slice(0, 1) || '微'}</span><span><strong>{contact.name}</strong><small>{contact.externalId}</small></span><span>{conversations.some(item => item.externalId === contact.externalId) ? '已添加' : selectedContact?.externalId === contact.externalId ? <Check size={15} /> : '选择'}</span></button>) : <p className="wechat-search-empty">未找到匹配联系人。试试其他备注或昵称，也可以手动填写会话 ID。</p>}{contactResults.hasMore && <p className="wechat-search-more">结果较多，当前最多显示 50 个。请用更完整的备注或昵称缩小范围。</p>}</div>}
    </div>}
    <form className="wechat-bind-form" onSubmit={event => { event.preventDefault(); void addConversation(); }}>
      {selectionMode === 'manual' ? <div className="form-grid"><label className="field-label">会话显示名称<input required maxLength={80} value={manualName} onChange={event => setManualName(event.target.value)} placeholder="例如：文件传输助手" /></label><label className="field-label">微信会话 ID<input required maxLength={200} value={manualExternalId} onChange={event => setManualExternalId(event.target.value)} placeholder="filehelper 或 wxid_…" autoComplete="off" spellCheck={false} /><small>使用读取工具提供的稳定 ID，不能填昵称或备注。</small></label></div> : selectedContact ? <div className="wechat-selected-contact"><Check size={16} /><div><strong>已选择：{selectedContact.name}</strong><small>{selectedContact.externalId}</small></div><span>{alreadyBound ? '已添加' : '等待添加'}</span></div> : <p className="wechat-no-selection">先搜索并选择一个会话，再添加到工作台。</p>}
      {bindError && <p className="inline-error" role="alert">{bindError}</p>}
      <div className="wechat-bind-action"><p>添加后打开对话，读取保持关闭。首次读取最近 50 条消息作为上下文，不触发自动草稿。</p><Button kind="secondary" type="submit" disabled={!!busy || !name || !externalId || (!alreadyBound && (!state.runtime.wechatAvailable || conversations.length >= 8))}>{busy === 'bind' ? <LoaderCircle size={14} className="spin" /> : alreadyBound ? <Check size={14} /> : <Plus size={14} />}{alreadyBound ? '打开已有对话' : conversations.length >= 8 ? '已达 8 个会话上限' : '添加并打开对话'}</Button></div>
    </form>
  </div>;
}

function AddConversationDialog({ state, notify, onClose, onAdded }: {
  state: PublicState; notify: (message: string, error?: boolean) => void; onClose: () => void; onAdded: (id: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'wechat' | 'simulator'>('wechat');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const addDemo = async () => {
    setBusy(true); setError('');
    try {
      const result = await api<Conversation>('/conversations', 'POST', { name: name.trim(), channel: 'simulator' });
      await onAdded(result.id); notify('演练对话已创建');
    } catch (error) { setError(error instanceof Error ? error.message : '演练对话创建未完成，请重试'); }
    finally { setBusy(false); }
  };
  return <Modal title="添加对话" description="选择微信联系人，或在本机演练新的表达。" onClose={onClose} wide>
    <div className="add-conversation-tabs"><button type="button" aria-pressed={mode === 'wechat'} className={mode === 'wechat' ? 'active' : ''} onClick={() => setMode('wechat')}><MessageCircle size={16} />微信联系人</button><button type="button" aria-pressed={mode === 'simulator'} className={mode === 'simulator' ? 'active' : ''} onClick={() => setMode('simulator')}><Sparkles size={15} />本机演练</button></div>
    {mode === 'wechat' ? <WechatContactPicker state={state} notify={notify} onAdded={onAdded} /> : <form onSubmit={event => { event.preventDefault(); void addDemo(); }}><label className="field-label">对方的称呼<input autoFocus required maxLength={50} placeholder="例如：小林" value={name} onChange={event => setName(event.target.value)} /></label><div className="info-box"><ShieldCheck size={16} />演练只保存在本机，不会绑定或发送到微信。</div>{error && <p className="inline-error" role="alert">{error}</p>}<div className="modal-footer"><Button kind="secondary" onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}创建演练对话</Button></div></form>}
  </Modal>;
}

function SettingsPage({ state, notify, refresh }: { state: PublicState; notify: (message: string, error?: boolean) => void; refresh: () => Promise<void> }) {
  const [form, setForm] = useState(() => ({ ...state.settings, autoReplyMode: state.settings.autoReplyMode ?? 'draft', apiKey: '' }));
  const [saving, setSaving] = useState('');
  const [connectionPackage, setConnectionPackage] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const connection = state.runtime.draftSyncConnection;
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const modelNames = useRef<Partial<Record<Settings['provider'], string>>>({ [state.settings.provider]: state.settings.modelName });
  const change = <K extends keyof Settings,>(key: K, value: Settings[K]) => setForm(previous => ({ ...previous, [key]: value }));
  const selectProvider = (provider: Settings['provider']) => {
    modelNames.current[form.provider] = form.modelName;
    setForm(previous => ({ ...previous, provider,
      modelName: modelNames.current[provider] ?? (provider === 'codex' ? '' : state.settings.modelName),
      modelUrl: provider === 'ollama' ? 'http://127.0.0.1:11434' : previous.modelUrl,
    }));
    setTestResult(null);
  };
  async function save(test = false) {
    if (test && form.provider === 'codex' && !form.allowRemoteModel) {
      notify('测试 Codex 前，请先允许向模型服务发送必要的对话片段', true);
      return;
    }
    setSaving(test ? 'test' : 'save'); setTestResult(null);
    try {
      const { hasApiKey: _hasApiKey, apiKey, autoReplyEnabled: _autoReply, ...values } = form;
      await api('/settings', 'PATCH', { ...values, ...(apiKey ? { apiKey } : {}) });
      if (test) { const result = await api<{ ok: boolean; message: string }>('/model/test', 'POST'); setTestResult(result); }
      else notify(form.autoReplyMode !== state.settings.autoReplyMode ? '模式已切换，全局开关已暂停；确认模式后可重新开启' : '设置已保存');
      setForm(previous => ({ ...previous, apiKey: '' }));
      await refresh();
    } catch (error) { notify(error instanceof Error ? error.message : '设置未保存', true); }
    finally { setSaving(''); }
  }
  async function updateConnection(action: 'save' | 'disable' | 'environment') {
    setSaving('connection'); setConnectionError('');
    try {
      if (action === 'save') {
        let parsed: unknown;
        try { parsed = JSON.parse(connectionPackage); } catch { throw new Error('配置包不是有效 JSON，请从 Wealth 重新复制完整配置包。'); }
        await api('/draft-sync/connection', 'PUT', parsed);
      } else if (action === 'disable') await api('/draft-sync/connection', 'DELETE');
      else await api('/draft-sync/connection/environment', 'POST');
      setConnectionPackage(''); setForm(previous => ({...previous, syncDraftsEnabled: false}));
      await refresh();
      notify(action === 'disable' ? '已清除并停用同步连接，不会恢复旧环境凭据' : '连接已保存，自动同步已暂停；保存未联网或上传草稿');
    } catch (error) { setConnectionError(error instanceof Error ? error.message : '连接未保存，请重新复制配置包。'); }
    finally { setSaving(''); }
  }
  async function checkCodex() {
    setSaving('check');
    try {
      const result = await api<PublicState>('/codex/check', 'POST');
      await refresh();
      notify(result.runtime.codexAvailable ? '已检测到 Codex CLI，未调用模型' : result.runtime.codexStatus, !result.runtime.codexAvailable);
    } catch (error) { notify(error instanceof Error ? error.message : '本机检测未完成', true); }
    finally { setSaving(''); }
  }
  return <><div className="section-heading"><div className="eyebrow">MAKE IT YOURS</div><h1>按照你的节奏工作。</h1><p>选择模型、控制回复节奏，明确每一次数据的去向。</p></div>
    <form className="settings-layout" onSubmit={event => { event.preventDefault(); void save(); }}>
      <section className="settings-card"><div className="settings-section-title"><span><FileText size={19} /></span><div><h2>收到消息后怎样处理</h2><p>全局开关和联系人开关都开启后，才会处理新的来信。</p></div></div><div className="provider-options reply-mode-options">{([{ id: 'draft', title: '自动生成草稿', detail: '生成后等待你修改、复制或手动发送' }, { id: 'send', title: '自动发送回复', detail: '生成后直接通过当前对话通道发送' }] as const).map(mode => <label className={`provider-option ${form.autoReplyMode === mode.id ? 'selected' : ''}`} key={mode.id}><input type="radio" name="autoReplyMode" checked={form.autoReplyMode === mode.id} onChange={() => change('autoReplyMode', mode.id)} /><span><strong>{mode.title}{mode.id === 'draft' && ' · 推荐'}</strong><small>{mode.detail}</small></span>{form.autoReplyMode === mode.id && <Check size={15} />}</label>)}</div><div className="info-box"><ShieldCheck size={17} /><span>{form.autoReplyMode === 'draft' ? '草稿模式不会自动发送消息。采用建议后，可以仅保存反馈，或由你决定是否发送。' : '自动发送会实际送出回复；本机演练对话只写入本机。'}切换模式并保存后，全局开关会暂停，需要你重新开启。</span></div></section>
      <section className="settings-card"><div className="settings-section-title"><span><Sparkles size={19} /></span><div><h2>回复模型</h2><p>先体验演练，也可以连接你自己的模型。</p></div></div>
        <div className="provider-options model-provider-options">{([{ id: 'demo', title: '本地规则演示', detail: '无需配置 · 不调用 AI' }, { id: 'codex', title: 'Codex', detail: '由服务端 Codex CLI 生成' }, { id: 'ollama', title: 'Ollama', detail: '连接本机模型服务' }, { id: 'compatible', title: '兼容 API', detail: '连接兼容模型服务' }] as const).map(provider => <label className={`provider-option ${form.provider === provider.id ? 'selected' : ''}`} key={provider.id}><input type="radio" name="provider" checked={form.provider === provider.id} onChange={() => selectProvider(provider.id)} /><span><strong>{provider.title}</strong><small>{provider.detail}</small></span>{form.provider === provider.id && <Check size={15} />}</label>)}</div>
        {form.provider === 'demo' ? <div className="info-box"><CircleHelp size={17} /><span>本地规则演示用于体验流程，回复由固定规则生成，不代表 AI 模型能力。所有演练消息只保存在本机。</span></div> : <>
          {form.provider === 'codex' ? <>
            <div className="codex-status" role="status"><span className={`status-dot ${state.runtime.codexAvailable ? '' : 'unavailable'}`} /><div><strong>{state.runtime.codexAvailable ? '已检测到 Codex CLI' : 'Codex CLI 暂不可用'}{state.runtime.codexVersion && <small>{state.runtime.codexVersion}</small>}</strong><p>{state.runtime.codexStatus}</p><p>此检测不联网，不代表已登录或模型可调用。</p></div><Button kind="secondary" disabled={!!saving} onClick={() => void checkCodex()}>{saving === 'check' ? <LoaderCircle size={13} className="spin" /> : <Search size={13} />}重新检测</Button></div>
            <label className="field-label">模型名称（可选）<input placeholder="留空使用 Codex 默认模型" value={form.modelName} onChange={event => change('modelName', event.target.value)} /><small>使用应用所在机器的 Codex 登录配置，无需在这里填写服务地址或 API 密钥。</small></label>
            <div className="info-box codex-context-note"><CircleHelp size={17} /><span>按 Mac 生成、腾讯云存放草稿的方式使用：在 Mac 上选择 Codex，并加载习惯档案和当前会话上下文。它不会自动继承我们在 Codex 中的聊天；腾讯云仅接收和展示已生成的草稿。</span></div>
          </> : <div className="form-grid"><label className="field-label">模型服务地址<input type="url" required placeholder={form.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://your-model-service/v1'} value={form.modelUrl} onChange={event => change('modelUrl', event.target.value)} /></label><label className="field-label">模型名称<input required placeholder={form.provider === 'ollama' ? 'qwen3:8b' : '模型服务提供的名称'} value={form.modelName} onChange={event => change('modelName', event.target.value)} /></label></div>}
          {form.provider === 'compatible' && <label className="field-label">API 密钥 <span className="field-hint">{state.settings.hasApiKey ? '已保存密钥；留空保留现有密钥' : '仅保存在本机，不会回显'}</span><input type="password" autoComplete="off" value={form.apiKey} onChange={event => change('apiKey', event.target.value)} placeholder={state.settings.hasApiKey ? '•••••••• 已配置' : '输入 API 密钥'} /></label>}
          <label className="checkbox-label"><input type="checkbox" checked={form.allowRemoteModel} onChange={event => change('allowRemoteModel', event.target.checked)} /><span><strong>允许向模型服务发送必要的对话片段</strong><small>{form.provider === 'codex' ? 'Codex CLI 虽在本机运行，仍会调用远端模型。开启后，生成所需的对话、习惯档案和反馈会交给模型服务。' : '使用非本机服务时需要开启；提供商会收到生成回复所需的内容与档案。'}</small></span></label></>}
        <div className="test-model"><Button kind="secondary" onClick={() => void save(true)} disabled={!!saving || (form.provider === 'codex' && (!form.allowRemoteModel || !state.runtime.codexAvailable))}>{saving === 'test' ? <LoaderCircle size={14} className="spin" /> : <Zap size={14} />}{form.provider === 'codex' ? '保存并测试生成' : '保存并测试连接'}</Button>{testResult && <span className={testResult.ok ? 'success-text' : 'error-text'} role="status">{testResult.message}</span>}</div>
        {form.provider === 'codex' && <p className="model-test-hint">{!form.allowRemoteModel ? '先勾选上方授权，再测试生成。' : '测试会发起一次真实模型调用，可能消耗额度。'}仅保存设置不会调用模型。</p>}
      </section>
      <section className="settings-card"><div className="settings-section-title"><span><Cloud size={19} /></span><div><h2>草稿同步 · Wealth</h2><p>Mac 负责生成，Wealth 使用原账号登录查看候选回复。</p></div></div>
        <div className="sync-connection-status" role="status"><strong>{connection?.source === 'disabled' ? '同步连接已停用' : state.runtime.draftSyncConfigured ? '同步连接已配置 · 令牌已隐藏' : '尚未配置可用连接'}</strong><small>{connection?.source === 'saved' ? '使用此工作空间保存的配置，优先于环境配置。' : connection?.source === 'environment' ? '当前使用本机服务环境配置。' : connection?.source === 'disabled' ? '已清除设备令牌，不会自动恢复环境配置。' : ''}</small>{connection?.uploadUrl && <code>{connection.uploadUrl}</code>}{connection?.error && <p className="inline-error">{connection.error}</p>}</div>
        <label className="field-label">Wealth 设备配置包<input type="password" autoComplete="off" spellCheck={false} maxLength={10000} value={connectionPackage} onChange={event => {setConnectionPackage(event.target.value);setConnectionError('');}} placeholder='粘贴 {"uploadUrl":"…","token":"…"}' /><small>在 Wealth 的“聊天助手 → 设备绑定”创建设备并复制配置包。内容只保存到此 Mac 的私有文件，保存后输入框清空。</small></label>
        <div className="sync-connection-actions"><Button kind="secondary" disabled={!!saving || !connectionPackage.trim()} onClick={() => void updateConnection('save')}>{saving === 'connection' ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存连接</Button><Button kind="ghost" disabled={!!saving || connection?.source === 'disabled'} onClick={() => void updateConnection('disable')}>清除并停用</Button>{connection && connection.source !== 'environment' && <Button kind="ghost" disabled={!!saving} onClick={() => void updateConnection('environment')}>恢复环境配置</Button>}</div>
        {connectionError && <p className="inline-error" role="alert">{connectionError}</p>}
        <p className="sync-connection-note">保存、清除或恢复连接会暂停自动同步。已有草稿保留；保存连接不会联网或上传数据。</p>
        <label className="checkbox-label"><input type="checkbox" checked={!!form.syncDraftsEnabled} disabled={!!saving || (!state.runtime.draftSyncConfigured && !form.syncDraftsEnabled)} onChange={event => change('syncDraftsEnabled', event.target.checked)} /><span><strong>生成后同步草稿至服务器</strong><small>勾选后点击“保存设置”，只同步此后生成的候选回复、联系人显示名与档案版本。旧草稿可在对话中手动同步。</small></span></label>
        <div className="info-box"><ShieldCheck size={17} /><span>完整聊天记录和习惯档案保留在 Mac。此开关不会发送微信消息。{state.runtime.draftInboxConfigured && ' 此工作空间也已配置草稿接收，可从“云端草稿箱”查看收到的回复。'}</span></div>
      </section>
      <section className="settings-card"><div className="settings-section-title"><span><Clock3 size={19} /></span><div><h2>自动处理节奏</h2><p>草稿只需短暂等待，合并连续来信；冷却、每日上限和安静时段仅用于自动发送。</p></div></div>
        <label className="field-label reply-delay-field">合并消息等待<input type="number" min={1} max={300} required value={form.replyDelaySeconds} onChange={event => change('replyDelaySeconds', Number(event.target.value))} /><small>秒 · 等对方连续说完，再生成回复</small></label>
        <div className="send-only-settings"><div className="send-only-heading"><h3>自动发送专用设置</h3><span>{form.autoReplyMode === 'draft' ? '当前草稿模式不使用以下限制' : '仅影响自动发送'}</span></div><div className="form-grid"><label className="field-label">发送冷却<input type="number" min={0} max={3600} required value={form.cooldownSeconds} onChange={event => change('cooldownSeconds', Number(event.target.value))} /><small>秒 · 两次自动发送之间的间隔</small></label><label className="field-label">每位联系人每日发送上限<input type="number" min={1} max={200} required value={form.dailyLimit} onChange={event => change('dailyLimit', Number(event.target.value))} /><small>次 / 人 · 不限制草稿数量</small></label></div>
          <div className="setting-toggle-row"><div><strong>自动发送安静时段</strong><p>在这个时间段内暂停自动发送，草稿仍可生成。</p></div><Toggle checked={form.quietHoursEnabled} onChange={() => change('quietHoursEnabled', !form.quietHoursEnabled)} label="开启自动发送安静时段" /></div>{form.quietHoursEnabled && <div className="quiet-time"><label className="field-label">开始时间<input type="time" required value={form.quietStart} onChange={event => change('quietStart', event.target.value)} /></label><span>至</span><label className="field-label">结束时间<input type="time" required value={form.quietEnd} onChange={event => change('quietEnd', event.target.value)} /></label><small>北京时间 · Asia/Shanghai</small></div>}
        </div>
      </section>
      <section className="settings-card channel-setting"><div className="settings-section-title"><span><ShieldCheck size={19} /></span><div><h2>消息通道</h2><p>{state.runtime.bridgeSendConfigured ? '外部发送通道已配置；手动发送或自动发送模式会通过该通道送出回复。' : state.runtime.bridgeReceiveConfigured ? '当前仅接收外部来信。可生成草稿和保存反馈，回复需复制到微信手动发送。' : state.conversations.some(item => item.channel === 'wechat') ? '微信会话仅读取消息，读取与自动草稿在各自对话内控制。回复需复制到微信手动发送。' : '当前使用本机演练。接入外部消息桥需要在服务端配置。'}</p></div></div><span className="runtime-badge"><span className="status-dot" />{state.runtime.bridgeSendConfigured ? '消息桥 · 可发送' : state.runtime.bridgeReceiveConfigured ? '消息桥 · 仅接收' : state.conversations.some(item => item.channel === 'wechat') ? '微信 · 仅读取' : '不会发送到微信'}</span></section>
      <div className="settings-save"><span>设置仅保存在此工作空间。</span><Button type="submit" disabled={!!saving}>{saving === 'save' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}保存设置</Button></div>
    </form>
  </>;
}

function ActivityPage({ state, now }: { state: PublicState; now: number }) {
  return <><div className="section-heading"><div className="eyebrow">CLEAR, AT EVERY STEP</div><h1>每一步，都清楚可见。</h1><p>查看草稿与发送队列、运行结果和需要你关注的情况。</p></div><section className="activity-jobs"><div className="panel-heading"><h2><Clock3 size={18} />自动处理任务</h2><span className="label-pill">最近 {Math.min(12, state.jobs.length)} 条</span></div>{state.jobs.length ? <div className="jobs-list">{state.jobs.slice(-12).reverse().map(job => <div className="job-row" key={job.id}><span className={`job-state ${job.status}`}>{['queued', 'generating'].includes(job.status) ? <LoaderCircle size={15} className="spin" /> : ['sent', 'drafted'].includes(job.status) ? <Check size={15} /> : <Pause size={15} />}</span><div><strong>{state.conversations.find(c => c.id === job.conversationId)?.name || '已删除对话'}</strong><p>{job.detail || jobLabels[job.status]}</p>{job.replyText && <blockquote>{job.replyText}</blockquote>}</div><span className={`job-status ${job.status}`}>{job.status === 'queued' ? `${Math.max(0, Math.ceil((new Date(job.dueAt).getTime() - now) / 1000))} 秒后${(job.mode ?? 'send') === 'draft' ? '生成草稿' : '发送'}` : jobLabels[job.status]}<small>{timeLabel(job.createdAt)}</small></span></div>)}</div> : <Empty icon={Clock3} title="还没有自动处理任务">开启全局和联系人开关，再加入一条模拟来信即可体验。</Empty>}</section>
    <div className="section-subtitle"><h2>工作空间动态</h2><span>{state.activity.length} 条记录</span></div><div className="activity-timeline">{state.activity.slice().reverse().map(item => <article className={`activity-item ${item.kind}`} key={item.id}><span className="timeline-marker">{item.kind === 'success' ? <Check size={13} /> : item.kind === 'warning' || item.kind === 'error' ? <CircleHelp size={13} /> : <ActivityIcon size={13} />}</span><div><h3>{item.title}</h3><p>{item.detail}</p></div><time>{dateLabel(item.createdAt)} {timeLabel(item.createdAt)}</time></article>)}{!state.activity.length && <Empty icon={ActivityIcon} title="新的开始">你的操作与运行结果会显示在这里。</Empty>}</div></>;
}

function ImportDialog({ onClose, onDone, notify }: { onClose: () => void; onDone: (id: string) => Promise<void>; notify: (message: string, error?: boolean) => void }) {
  const [input, setInput] = useState<ImportInput>({ text: '', filename: '聊天记录.txt', format: 'auto' });
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [loading, setLoading] = useState('');
  const [error, setError] = useState('');
  const [mode, setMode] = useState<'file' | 'text'>('file');
  const previewRequest = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const getPreview = async (value = input) => {
    const request = ++previewRequest.current;
    setLoading('preview'); setError('');
    try { const result = await api<ImportPreview>('/import/preview', 'POST', value); if (request === previewRequest.current) setPreview(result); }
    catch (cause) { if (request === previewRequest.current) setError(cause instanceof Error ? cause.message : '无法预览，请检查文件格式'); }
    finally { if (request === previewRequest.current) setLoading(''); }
  };
  const chooseFile = async (file?: File) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setError('请先使用 5 MiB 以内的聊天记录文件。'); return; }
    try {
      const text = await file.text();
      setInput({ ...input, text, filename: file.name, selfId: undefined }); setPreview(null); setError('');
    } catch { setError('无法读取这个文件，请重新选择。'); }
  };
  const commit = async () => {
    setLoading('commit'); setError('');
    try {
      const result = await api<{ conversationId: string; added: number; duplicates: number; warnings: string[] }>('/import/commit', 'POST', input);
      notify(`导入完成：${result.added} 条消息${result.duplicates ? `，跳过 ${result.duplicates} 条重复消息` : ''}`);
      await onDone(result.conversationId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '导入未完成'); }
    finally { setLoading(''); }
  };
  return <Modal wide title="把对话带到相知" description="先预览、确认身份，再将聊天记录保存在本机。" onClose={onClose}>
    <div className="import-steps"><span className={!preview ? 'active' : 'complete'}><b>{preview ? <Check size={11} /> : '1'}</b>选择记录</span><ChevronRight size={13} /><span className={preview ? 'active' : ''}><b>2</b>预览与确认</span><ChevronRight size={13} /><span><b>3</b>完成导入</span></div>
    {!preview ? <><div className="tabs import-tabs"><button className={mode === 'file' ? 'active' : ''} onClick={() => setMode('file')}>上传文件</button><button className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>粘贴文本</button></div>
      {mode === 'file' ? <><input ref={fileRef} type="file" accept=".json,.jsonl,.csv,.txt,.text" hidden onChange={event => void chooseFile(event.target.files?.[0])} /><button className="upload-zone" onClick={() => fileRef.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void chooseFile(event.dataTransfer.files[0]); }}><span><ArrowDownToLine size={25} /></span><strong>{input.text ? input.filename : '点击选择文件，或拖拽到这里'}</strong><small>ChatLab 0.0.2 JSON / JSONL、简易 JSON、CSV 或文本</small><em>{input.text ? '已读取文件，点击可重新选择' : '建议先用一段经过脱敏的聊天记录体验'}</em></button></> : <label className="field-label">聊天记录<textarea rows={9} value={input.text} placeholder={'每行以“我：”或“对方：”开头。例如：\n我：今天过得怎么样？\n对方：刚忙完，准备去吃饭。'} onChange={event => setInput({ ...input, text: event.target.value, filename: '聊天记录.txt', selfId: undefined })} /></label>}
      <div className="form-grid"><label className="field-label">对话名称（可选）<input value={input.name || ''} onChange={event => setInput({ ...input, name: event.target.value })} placeholder="自动从文件识别" /></label><label className="field-label">文件格式<select value={input.format} onChange={event => setInput({ ...input, format: event.target.value as ImportInput['format'] })}><option value="auto">自动识别</option><option value="chatlab">ChatLab JSON / JSONL</option><option value="json">简易 JSON（明确 role / text）</option><option value="csv">CSV</option><option value="text">纯文本</option></select></label></div>
      <div className="info-box"><FileText size={17} /><span>支持最多 5 MiB / 5000 条私聊消息。微信官方备份不能作为 JSON 直接导入。</span></div><div className="import-examples">先试试合成样例：<a href="/examples/chatlab-demo.json" download>ChatLab JSON <ArrowDownToLine size={11} /></a><a href="/examples/messages-demo.csv" download>CSV <ArrowDownToLine size={11} /></a></div>
    </> : <><div className="preview-summary"><span className="file-icon"><FileText size={23} /></span><div><strong>{input.name || preview.name}</strong><p>{preview.format} · {preview.messages.length} 条消息 · {preview.members.length > 0 ? `${preview.members.length} 位参与者` : '已按我 / 对方标记身份'}</p></div><button onClick={() => { setPreview(null); setError(''); }}>重新选择</button></div>
      {preview.members.length > 0 && <label className="field-label self-choice">确认「我」是谁<span className="field-hint">系统会根据这个身份区分你的表达和对方的消息。</span><select value={input.selfId || ''} disabled={!!loading} onChange={event => { const next = { ...input, selfId: event.target.value || undefined }; setInput(next); void getPreview(next); }}><option value="">请选择你的身份</option>{preview.members.map(member => <option value={member.id} key={member.id}>{member.name} ({member.id})</option>)}</select></label>}
      {preview.warnings.length > 0 && <div className="import-warnings">{preview.warnings.map((warning, i) => <p key={i}><CircleHelp size={13} />{warning}</p>)}</div>}
      <div className="preview-messages"><div className="preview-caption">消息预览 · 前 {Math.min(6, preview.messages.length)} 条{loading === 'preview' && <LoaderCircle size={13} className="spin" />}</div>{preview.messages.slice(0, 6).map((message, index) => <div className="preview-message" key={index}><span className={message.role === 'self' ? 'self' : ''}>{message.role === 'self' ? '我' : message.role === 'system' ? '系统' : preview.members.find(m => m.id === message.senderId)?.name || '对方'}</span><p>{message.text}</p><time>{timeLabel(message.sentAt)}</time></div>)}</div>
    </>}
    {error && <div className="inline-error" role="alert">{error}</div>}
    <div className="modal-footer"><span className="import-privacy"><ShieldCheck size={14} />记录保存在本机</span><Button kind="secondary" onClick={onClose}>取消</Button>{preview ? <Button onClick={() => void commit()} disabled={!!loading || !preview.messages.length || (preview.needsSelfId && !input.selfId)}>{loading ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}确认导入</Button> : <Button onClick={() => void getPreview()} disabled={!!loading || !input.text.trim()}>{loading ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}预览记录</Button>}</div>
  </Modal>;
}
