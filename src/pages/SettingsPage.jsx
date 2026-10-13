import { useEffect, useState, useCallback } from 'react';
import PageContainer from '../components/PageContainer.jsx';
import { Plus, RefreshCw, Volume2 } from 'lucide-react';
import { api, PROVIDERS } from '../api.js';
import {
  useLayoutSettings, CONTENT_WIDTH_OPTIONS, FONT_SIZE_OPTIONS, THEME_OPTIONS, READING_FONT_OPTIONS, fontSizeClass,
} from '../context/LayoutSettingsContext.jsx';
import { UI_SCALE_OPTIONS } from '../lib/uiScale.js';
import { useConfirm } from '../context/ConfirmContext.jsx';
import { Button, Field, Notice, PageHeader, Segmented, Sheet, Tag, inputClass } from '../components/ui.jsx';
import { playBlob } from '../lib/ttsPlayer.js';
import { useAuth, roleLabel } from '../context/AuthContext.jsx';
import { ChangePasswordForm } from './LoginPage.jsx';
import DataManagement from '../components/admin/DataManagement.jsx';
import ActivityLog from '../components/admin/ActivityLog.jsx';
import UserManagement from '../components/admin/UserManagement.jsx';

const TTS_PREVIEW_TEXT = 'Hello! This is a preview of how Kokoro will read your paragraphs.';

// A vertical section list with a one-line hint per section, instead of a
// horizontal tab bar — reads better once there are 5+ sections.
// `permission`: the tab only appears for users who have it.
const TABS = [
  { key: 'account', label: 'Tài khoản', hint: 'Thông tin, mật khẩu, vai trò' },
  { key: 'interface', label: 'Giao diện', hint: 'Sáng tối, cỡ chữ, bố cục' },
  { key: 'tts', label: 'Giọng đọc', hint: 'Giọng và tốc độ đọc tiếng Anh' },
  { key: 'ai', label: 'AI dịch', hint: 'Nhà cung cấp, model, API key', permission: 'settings.ai' },
  { key: 'prompts', label: 'Prompt dịch', hint: 'Prompt riêng theo loại sách', permission: 'prompts.manage' },
  { key: 'users', label: 'Người dùng & nhóm', hint: 'Tài khoản, nhóm, vai trò, SSO', permission: 'users.manage' },
  { key: 'activity', label: 'Nhật ký hoạt động', hint: 'Ai làm gì, khi nào', permission: 'users.manage' },
  { key: 'data', label: 'Dữ liệu & sao lưu', hint: 'Sao lưu, kiểm tra, hoàn tác gộp từ', permission: 'users.manage' },
];

function SectionNav({ tabs, active, onChange }) {
  return (
    <nav aria-label="Các mục cài đặt" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          aria-current={active === t.key ? 'page' : undefined}
          onClick={() => onChange(t.key)}
          className={`shrink-0 rounded-md px-3 py-2 text-left transition-colors ${
            active === t.key ? 'bg-accent-soft text-accent' : 'text-soft hover:bg-page hover:text-ink'
          }`}
        >
          <span className="block text-body font-semibold">{t.label}</span>
          <span className={`hidden text-caption lg:block ${active === t.key ? 'text-accent' : 'text-mute'}`}>{t.hint}</span>
        </button>
      ))}
    </nav>
  );
}

function SectionTitle({ title, children }) {
  return (
    <div>
      <h2 className="font-serif text-title font-semibold text-ink">{title}</h2>
      {children && <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-soft">{children}</p>}
    </div>
  );
}

function Setting({ label, hint, children }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-rule py-4 first:border-t-0 first:pt-0 last:pb-0">
      <div>
        <p className="text-body font-medium text-ink">{label}</p>
        {hint && <p className="mt-0.5 text-meta text-mute">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function InterfaceTab() {
  const { settings: layout, updateSettings: updateLayout } = useLayoutSettings();
  return (
    <div className="space-y-6">
      <SectionTitle title="Giao diện">
        Áp dụng cho mọi trang. Phần hiển thị trang chương cũng chỉnh được ngay khi đang đọc, ở nút Hiển thị.
      </SectionTitle>

      <div>
        <Setting label="Chế độ sáng tối" hint="Theo máy sẽ đổi cùng hệ điều hành.">
          <Segmented label="Chế độ sáng tối" options={THEME_OPTIONS} value={layout.theme} onChange={(theme) => updateLayout({ theme })} />
        </Setting>
        <Setting label="Cỡ chữ giao diện" hint="Phóng to chữ và khoảng cách của mọi trang. Cỡ chữ cũng tự lớn dần theo độ rộng màn hình.">
          <Segmented label="Cỡ chữ giao diện" options={UI_SCALE_OPTIONS} value={layout.uiScale || 'md'} onChange={(uiScale) => updateLayout({ uiScale })} />
        </Setting>
        <Setting label="Cỡ chữ hai cột Anh–Việt" hint="Cùng cỡ chữ cho bản gốc và bản dịch.">
          <Segmented label="Cỡ chữ đoạn văn" options={FONT_SIZE_OPTIONS} value={layout.fontSize} onChange={(fontSize) => updateLayout({ fontSize })} />
        </Setting>
        <Setting label="Kiểu chữ hai cột Anh–Việt" hint="Áp dụng cùng font và nhịp dòng cho tiếng Anh lẫn tiếng Việt.">
          <Segmented label="Kiểu chữ đoạn văn" options={READING_FONT_OPTIONS} value={layout.readingFont} onChange={(readingFont) => updateLayout({ readingFont })} />
        </Setting>
        <Setting label="Độ rộng nội dung" hint={CONTENT_WIDTH_OPTIONS.find((o) => o.key === layout.contentWidth)?.hint}>
          <Segmented label="Độ rộng nội dung" options={CONTENT_WIDTH_OPTIONS} value={layout.contentWidth} onChange={(contentWidth) => updateLayout({ contentWidth })} />
        </Setting>
        <Setting label="Cột ghi chú" hint="Ghi chú theo đoạn được thu gọn để ưu tiên phần đọc Anh–Việt.">
          <Segmented
            label="Cột ghi chú"
            options={[{ key: 'show', label: 'Hiện' }, { key: 'hide', label: 'Ẩn' }]}
            value={layout.showNotes !== false ? 'show' : 'hide'}
            onChange={(v) => updateLayout({ showNotes: v === 'show' })}
          />
        </Setting>
        <Setting label="Đánh dấu từ đã có trong kho" hint="Gạch chân chấm ở cột English, màu theo trạng thái ôn tập. Rê chuột hoặc chạm để xem IPA và nghĩa.">
          <Segmented
            label="Đánh dấu từ đã có trong kho"
            options={[{ key: 'show', label: 'Hiện' }, { key: 'hide', label: 'Ẩn' }]}
            value={layout.showVocabHints !== false ? 'show' : 'hide'}
            onChange={(v) => updateLayout({ showVocabHints: v === 'show' })}
          />
        </Setting>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 rounded-md border border-rule bg-sunken p-3">
          <p className="mb-1 text-caption font-semibold text-mute">Bản gốc · English</p>
          <p className={`book-text text-ink ${layout.readingFont === 'sans' ? '!font-sans' : ''} ${fontSizeClass('paragraph', layout.fontSize)}`}>
            The quick brown fox jumps over the lazy dog. Clear type helps you stay with the story.
          </p>
        </div>
        <div className="min-w-0 rounded-md border border-rule bg-sunken p-3">
          <p className="mb-1 text-caption font-semibold text-mute">Bản dịch · Tiếng Việt</p>
          <p className={`book-text text-ink ${layout.readingFont === 'sans' ? '!font-sans' : ''} ${fontSizeClass('paragraph', layout.fontSize)}`}>
            Người đọc cần kiểu chữ rõ ràng, đủ dấu tiếng Việt: ệ, ướ, ẫ, ữ. Cùng cỡ chữ giúp dễ đối chiếu.
          </p>
        </div>
      </div>
    </div>
  );
}

function TtsTab() {
  const { settings: layout, updateSettings: updateLayout } = useLayoutSettings();
  const [voices, setVoices] = useState([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    api.listVoices().then((r) => setVoices(r.voices || [])).catch(() => {});
  }, []);

  async function handlePreviewVoice() {
    setPreviewLoading(true);
    setPreviewError('');
    try {
      const blob = await api.speak({ text: TTS_PREVIEW_TEXT, voice: layout.ttsVoice, speed: layout.ttsSpeed });
      playBlob('settings-preview', blob);
    } catch (e) {
      setPreviewError(e.message);
    } finally {
      setPreviewLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="Giọng đọc">
        Giọng và tốc độ mặc định khi nghe một đoạn văn hoặc một từ. Kokoro TTS chạy hoàn toàn trên máy này, văn bản không được gửi ra ngoài. Chỉ đọc được tiếng Anh.
      </SectionTitle>

      <div className="grid grid-cols-1 gap-5 sm:max-w-xl sm:grid-cols-2">
        <Field label="Giọng đọc">
          <select value={layout.ttsVoice} onChange={(e) => updateLayout({ ttsVoice: e.target.value })} className={inputClass}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
          </select>
        </Field>
        <Field label={`Tốc độ đọc: ${layout.ttsSpeed.toFixed(2)}x`}>
          <input
            type="range"
            min={0.5}
            max={1.5}
            step={0.05}
            value={layout.ttsSpeed}
            onChange={(e) => updateLayout({ ttsSpeed: Number(e.target.value) })}
            className="mt-2.5 w-full accent-accent"
          />
        </Field>
      </div>

      {previewError && <Notice>{previewError}</Notice>}

      <Button onClick={handlePreviewVoice} disabled={previewLoading}>
        <Volume2 size={16} /> {previewLoading ? 'Đang tạo giọng đọc…' : 'Nghe thử'}
      </Button>
    </div>
  );
}

const WORKFLOW_MODES = [
  { key: 'linear', label: 'Một lượt' },
  { key: 'graph', label: 'Tự kiểm tra & sửa' },
];

// How a paragraph is translated (server/workflow/): the linear pipeline
// saves the first draft; the graph checks it (missing sentences, decided
// terminology, English left over, citation, bold) and asks the model for
// narrow repairs before saving. Saved as soon as it is changed.
function WorkflowSetting({ workflow = { mode: 'linear', maxRepairs: 2 }, onSaved }) {
  const [error, setError] = useState('');
  async function save(patch) {
    setError('');
    try {
      onSaved(await api.updateSettings({ workflow: { ...workflow, ...patch } }));
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <div className="max-w-2xl space-y-3 border-t border-rule pt-5">
      <p className="text-lead font-semibold text-ink">Quy trình dịch</p>
      <Segmented label="Quy trình dịch" options={WORKFLOW_MODES} value={workflow.mode} onChange={(mode) => save({ mode })} />
      <p className="text-body leading-relaxed text-soft">
        {workflow.mode === 'graph'
          ? 'Sau khi AI dịch, app kiểm tra bản dịch: sót câu, sai thuật ngữ đã chốt, còn sót tiếng Anh, chưa dịch trích dẫn, bôi đậm lệch. Lỗi tìm thấy được gửi lại cho AI để sửa đúng chỗ đó, giữ bản tốt nhất. Lỗi còn lại sau số lần sửa cho phép thì đoạn được đánh dấu 🚩 cần xem lại. Chậm hơn và tốn thêm lượt gọi AI khi có lỗi.'
          : 'AI dịch một lượt và lưu ngay, không kiểm tra lại.'}
      </p>
      {workflow.mode === 'graph' && (
        <label className="flex items-center gap-2 text-body text-soft">
          Số lần sửa tối đa mỗi đoạn
          <select value={workflow.maxRepairs ?? 2} onChange={(e) => save({ maxRepairs: Number(e.target.value) })} className="rounded-md border border-rule bg-page px-2 py-1 text-body text-ink">
            {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

const PIPELINE_MODES = [
  { key: 'single', label: 'Một model' },
  { key: 'hybrid', label: 'Kết hợp' },
];
const MT_OPTIONS = [
  { key: 'nvidia', label: 'NVIDIA Build (đám mây)' },
  { key: 'metta', label: 'Metta-AI-Server (tự chạy)' },
  { key: 'riva', label: 'Riva NMT (gRPC, không cần model)' },
];
const ANNOTATOR_KEYS = ['anthropic', 'gemini', 'openai', 'nvidia', 'ollama', 'lmstudio', 'metta'];
// Translation-only models (same test as the server's isMtOnly).
const isMtModel = (id) => /riva-translate|(^|\/)nmt\b/i.test(id || '');

// The hybrid pipeline (server/llm/hybridPipeline.js): a translation-only
// model (Riva Translate 4B…) translates, a chat model adds the notes and
// enforces the agreed terms. Saved on change, like the workflow above.
function PipelineSetting({ settings, onSaved }) {
  const pipeline = settings.pipeline || { mode: 'single', translator: 'nvidia', translatorModel: 'nvidia/riva-translate-4b-instruct-v2', annotator: 'anthropic' };
  const [error, setError] = useState('');
  const [model, setModel] = useState(pipeline.translatorModel);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState(null);
  // The translator's own model list (live, remembered or fallback), the
  // translation-only models first — they are what this field is for.
  const [mtModels, setMtModels] = useState([]);
  const [mtSource, setMtSource] = useState(null);
  const { translator, mode } = pipeline;
  useEffect(() => {
    if (mode !== 'hybrid' || translator === 'riva') return undefined;
    let live = true;
    api.listModels(translator, settings[translator])
      .then((res) => {
        if (!live) return;
        const list = res.models || [];
        setMtModels([...list.filter((m) => isMtModel(m.id)), ...list.filter((m) => !isMtModel(m.id))]);
        setMtSource(res.source);
      })
      .catch(() => { if (live) { setMtModels([]); setMtSource('error'); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, translator]);

  async function save(patch) {
    setError('');
    setTest(null);
    try {
      onSaved(await api.updateSettings({ pipeline: { ...pipeline, ...patch } }));
    } catch (e) {
      setError(e.message);
    }
  }
  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.testPipeline());
    } catch (e) {
      setTest({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }
  const label = (key) => PROVIDERS.find((p) => p.key === key)?.label || key;
  const selectClass = 'rounded-md border border-rule bg-page px-2 py-1 text-body text-ink';

  return (
    <div className="max-w-2xl space-y-3 border-t border-rule pt-5">
      <p className="text-lead font-semibold text-ink">Cách dịch</p>
      <Segmented label="Cách dịch" options={PIPELINE_MODES} value={pipeline.mode} onChange={(mode) => save({ mode })} />
      <p className="text-body leading-relaxed text-soft">
        {pipeline.mode === 'hybrid'
          ? 'Một model chuyên dịch (như Riva Translate 4B) dịch đoạn văn; sau đó model ghi chú giữ nguyên bản dịch đó, chỉ sửa cho đúng thuật ngữ đã thống nhất hay chỗ sai nghĩa, rồi bôi đậm và ghi chú từ vựng. Nếu một bước lỗi, app tự lùi về bước còn lại và báo lại.'
          : `Nhà cung cấp đang dùng (${label(settings.provider)}) tự dịch và ghi chú.`}
      </p>
      {pipeline.mode === 'hybrid' && (
        <div className="space-y-3">
          <label className="flex flex-wrap items-center gap-2 text-body text-soft">
            Máy dịch
            <select value={pipeline.translator} onChange={(e) => save({ translator: e.target.value })} className={selectClass}>
              {MT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
          </label>
          {pipeline.translator !== 'riva' && (
            <label className="flex flex-wrap items-center gap-2 text-body text-soft">
              Model dịch
              {mtModels.length > 0 ? (
                <select value={pipeline.translatorModel} onChange={(e) => { setModel(e.target.value); save({ translatorModel: e.target.value }); }} className={`${selectClass} min-w-0 flex-1`}>
                  {!mtModels.some((m) => m.id === pipeline.translatorModel) && <option value={pipeline.translatorModel}>{pipeline.translatorModel} (đã lưu)</option>}
                  {mtModels.map((m) => <option key={m.id} value={m.id}>{isMtModel(m.id) ? `${m.id} — chỉ dịch` : m.id}</option>)}
                </select>
              ) : (
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onBlur={() => model.trim() !== pipeline.translatorModel && save({ translatorModel: model.trim() })}
                  className={`${selectClass} min-w-0 flex-1`}
                />
              )}
            </label>
          )}
          {pipeline.translator !== 'riva' && mtSource && mtSource !== 'live' && (
            <p className="text-caption text-mute">
              {mtSource === 'cached' ? 'Máy chủ không kết nối được; danh sách đã lấy lần trước.' : 'Chưa lấy được danh sách thật từ nhà cung cấp; đây là danh sách mặc định.'}
            </p>
          )}
          <label className="flex flex-wrap items-center gap-2 text-body text-soft">
            Model ghi chú
            <select value={pipeline.annotator} onChange={(e) => save({ annotator: e.target.value })} className={selectClass}>
              {ANNOTATOR_KEYS.map((k) => <option key={k} value={k}>{label(k)} — {settings[k]?.model || '?'}</option>)}
            </select>
          </label>
          <p className="text-caption text-mute">
            Model ghi chú dùng model đã chọn cho nhà cung cấp đó ở trên. Nó phải là model chat (không phải model chỉ dịch).
          </p>
          <Button onClick={runTest} disabled={testing}>{testing ? 'Đang chạy thử…' : 'Chạy thử quy trình'}</Button>
          {test && (test.ok ? (
            <Notice tone={test.warnings?.length ? 'warn' : 'ok'}>
              <span className="block">Máy dịch ({test.translator}, {(test.mtMs / 1000).toFixed(1)} giây): “{test.base || '—'}”</span>
              <span className="mt-1 block">Kết quả cuối ({test.annotator}, tổng {(test.ms / 1000).toFixed(1)} giây, {test.notes} ghi chú): “{test.sample}”</span>
              {test.warnings?.map((w) => <span key={w} className="mt-1 block">⚠ {w}</span>)}
            </Notice>
          ) : <Notice tone="error">Chạy thử thất bại: {test.error}</Notice>)}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function AiProviderTab() {
  const [settings, setSettings] = useState(null);
  const [selected, setSelected] = useState('anthropic');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');

  const [modelOptions, setModelOptions] = useState([]);
  const [modelsSource, setModelsSource] = useState(null);
  const [modelsCachedAt, setModelsCachedAt] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');

  const loadSettings = useCallback(() => {
    setLoadError('');
    api.getSettings()
      .then((s) => { setSettings(s); setSelected(s.provider); })
      .catch((e) => setLoadError(e.message));
  }, []);

  useEffect(loadSettings, [loadSettings]);

  const loadModels = useCallback((providerKey, config) => {
    setModelsLoading(true);
    setModelsError('');
    api.listModels(providerKey, config)
      .then((res) => {
        setModelOptions(res.models || []);
        setModelsSource(res.source);
        setModelsCachedAt(res.cachedAt || null);
        if (res.error) setModelsError(res.error);
      })
      .catch((e) => setModelsError(e.message))
      .finally(() => setModelsLoading(false));
  }, []);

  useEffect(() => {
    if (!settings) return;
    const kind = PROVIDERS.find((p) => p.key === selected)?.kind;
    if (kind === 'riva') return; // no "model" concept to list
    loadModels(selected, settings[selected]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, settings === null]);

  function updateField(providerKey, field, value) {
    setSettings((s) => ({ ...s, [providerKey]: { ...s[providerKey], [field]: value } }));
    setSaved(false);
    setTestResult(null);
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const payload = { provider: selected, [selected]: settings[selected] };
      const updated = await api.updateSettings(payload);
      setSettings(updated);
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const res = await api.testSettings(selected, settings[selected]);
      setTestResult(res);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  const provider = settings ? PROVIDERS.find((p) => p.key === selected) : null;
  const config = settings ? settings[selected] : null;
  const currentModelKnown = modelOptions.some((m) => m.id === config?.model);

  return (
    <div className="space-y-6">
      <SectionTitle title="AI dịch">
        Chọn dịch vụ AI dùng để dịch đoạn văn và trích từ vựng. Dịch vụ đám mây cần API key; mô hình chạy tại máy (Ollama, LM Studio) chỉ cần Base URL.
      </SectionTitle>

      {loadError ? (
        <Notice action={<Button size="sm" onClick={loadSettings}>Thử lại</Button>}>
          Không tải được cài đặt: {loadError}. Kiểm tra backend đang chạy tại http://localhost:3001/api/health.
        </Notice>
      ) : !settings ? (
        <p className="text-body text-mute">Đang tải…</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="Nhà cung cấp AI" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {PROVIDERS.map((p) => {
              const isSelected = selected === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() => { setSelected(p.key); setTestResult(null); }}
                  className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-body font-medium transition-colors ${
                    isSelected ? 'border-accent bg-accent-soft text-ink' : 'border-rule text-soft hover:border-mute hover:text-ink'
                  }`}
                >
                  <span className="min-w-0">{p.label}</span>
                  {settings.provider === p.key && <Tag tone="ok" className="shrink-0">Đang dùng</Tag>}
                </button>
              );
            })}
          </div>

          <div className="max-w-xl space-y-4">
            {provider.kind === 'riva' ? (
              <>
                <Field label="API key (NVCF)">
                  <input
                    type="password"
                    value={config.apiKey || ''}
                    onChange={(e) => updateField(selected, 'apiKey', e.target.value)}
                    placeholder={config.hasApiKey ? 'Đã lưu. Nhập key mới để thay thế' : 'nvapi-...'}
                    className={inputClass}
                  />
                </Field>
                <Field label="Function ID">
                  <input
                    value={config.functionId || ''}
                    onChange={(e) => updateField(selected, 'functionId', e.target.value)}
                    placeholder="Function ID trên build.nvidia.com"
                    className={inputClass}
                  />
                </Field>
                <Notice tone="warn">
                  Dịch máy thuần tuý: chỉ điền cột tiếng Việt, không trích từ vựng, không bôi đậm, không chú thích. Hợp khi chỉ cần bản dịch nhanh, không cần học từ.
                </Notice>
              </>
            ) : provider.kind === 'cloud' ? (
              <Field label="API key">
                <input
                  type="password"
                  value={config.apiKey || ''}
                  onChange={(e) => updateField(selected, 'apiKey', e.target.value)}
                  placeholder={config.hasApiKey ? 'Đã lưu. Nhập key mới để thay thế' : 'sk-...'}
                  className={inputClass}
                />
              </Field>
            ) : (
              <Field label="Base URL">
                <input
                  value={config.baseUrl || ''}
                  onChange={(e) => updateField(selected, 'baseUrl', e.target.value)}
                  placeholder={provider.baseUrlPlaceholder}
                  className={inputClass}
                />
              </Field>
            )}

            {provider.kind !== 'riva' && (
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="ai-model" className="text-meta font-medium text-soft">Model</label>
                  <button
                    type="button"
                    onClick={() => loadModels(selected, config)}
                    disabled={modelsLoading}
                    className="inline-flex items-center gap-1.5 text-meta font-medium text-accent hover:text-accent-strong disabled:opacity-50"
                  >
                    <RefreshCw size={13} className={modelsLoading ? 'animate-spin' : ''} />
                    {modelsLoading ? 'Đang tải danh sách…' : 'Tải lại danh sách'}
                  </button>
                </div>

                {modelOptions.length > 0 ? (
                  <select id="ai-model" value={config.model || ''} onChange={(e) => updateField(selected, 'model', e.target.value)} className={inputClass}>
                    {!currentModelKnown && config.model && <option value={config.model}>{config.model} (đã lưu)</option>}
                    {modelOptions.map((m) => (
                      <option key={m.id} value={m.id}>{m.label !== m.id ? `${m.label} (${m.id})` : m.id}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    id="ai-model"
                    value={config.model || ''}
                    onChange={(e) => updateField(selected, 'model', e.target.value)}
                    placeholder={provider.modelPlaceholder}
                    className={inputClass}
                  />
                )}

                <p className="mt-1.5 text-caption text-mute">
                  {modelOptions.length > 0
                    ? modelsSource === 'live'
                      ? 'Danh sách lấy trực tiếp từ nhà cung cấp.'
                      : modelsSource === 'cached'
                        ? `Máy chủ đang không kết nối được; đây là danh sách đã lấy lần trước${modelsCachedAt ? ` (${new Date(modelsCachedAt).toLocaleString('vi-VN')})` : ''}.`
                        : 'Danh sách mặc định, chưa lấy được danh sách thật từ nhà cung cấp.'
                    : modelsError
                      ? `Không tải được danh sách (${modelsError}). Nhập tên model thủ công.`
                      : 'Nhập tên model thủ công.'}
                </p>
              </div>
            )}
          </div>

          {error && <Notice>{error}</Notice>}
          {testResult && (
            <Notice tone={testResult.ok ? (testResult.warnings?.length ? 'warn' : 'ok') : 'error'}>
              {testResult.ok ? `Kết nối thành công. Kết quả mẫu: "${testResult.sample}"` : `Kết nối thất bại: ${testResult.error}`}
              {testResult.warnings?.map((w) => <span key={w} className="mt-1 block">⚠ {w}</span>)}
            </Notice>
          )}
          {saved && !testResult && <Notice tone="ok">Đã lưu. {provider.label} đang là AI dịch mặc định.</Notice>}

          <div className="flex flex-wrap gap-2 border-t border-rule pt-5">
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Đang lưu…' : `Lưu và dùng ${provider.label}`}
            </Button>
            <Button onClick={handleTest} disabled={testing}>
              {testing ? 'Đang kiểm tra…' : 'Kiểm tra kết nối'}
            </Button>
          </div>

          <WorkflowSetting workflow={settings.workflow} onSaved={setSettings} />
          <PipelineSetting settings={settings} onSaved={setSettings} />
        </>
      )}
    </div>
  );
}

function AccountTab() {
  const { user, roles } = useAuth();
  return (
    <div className="space-y-6">
      <SectionTitle title="Tài khoản" />
      <dl className="grid gap-x-6 gap-y-3 text-body sm:grid-cols-[9rem_minmax(0,1fr)]">
        <dt className="text-mute">Họ tên</dt><dd className="text-ink">{user.name || '—'}</dd>
        <dt className="text-mute">Email</dt><dd className="text-ink">{user.email}</dd>
        <dt className="text-mute">Vai trò</dt>
        <dd className="flex flex-wrap gap-1.5">
          {user.effectiveRoles.length ? user.effectiveRoles.map((r) => <Tag key={r} tone="accent">{roleLabel(roles, r)}</Tag>) : <span className="text-mute">Chưa có vai trò</span>}
        </dd>
        {user.groups.length > 0 && (<><dt className="text-mute">Nhóm</dt><dd className="text-ink">{user.groups.map((g) => g.name).join(', ')}</dd></>)}
        <dt className="text-mute">Đăng nhập</dt><dd className="text-ink">{[user.hasPassword && 'Mật khẩu', user.sso && 'Metta SSO'].filter(Boolean).join(', ')}</dd>
      </dl>
      {user.hasPassword && (
        <div className="max-w-md border-t border-rule pt-6">
          <h3 className="mb-4 font-serif text-heading font-semibold text-ink">Đổi mật khẩu</h3>
          <ChangePasswordForm />
        </div>
      )}
      {!user.hasPassword && <p className="text-body text-soft">Tài khoản này đăng nhập bằng SSO; mật khẩu được quản lý ở hệ thống SSO.</p>}
    </div>
  );
}

function PromptsTab() {
  const confirm = useConfirm();
  const [prompts, setPrompts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // selectId: pass an explicit id to select after the list refreshes (e.g. a
  // just-created prompt) — otherwise keeps the current selection if it still
  // exists in the list, falling back to the first prompt.
  const load = useCallback((selectId) => {
    setLoading(true);
    setLoadError('');
    api.listPrompts()
      .then((list) => {
        setPrompts(list);
        setSelectedId((prev) => {
          if (selectId !== undefined) return selectId;
          if (prev && list.some((p) => p.id === prev)) return prev;
          return list[0]?.id ?? null;
        });
      })
      .catch((e) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => load(), [load]);

  const selected = prompts.find((p) => p.id === selectedId) || null;

  useEffect(() => {
    if (isCreating) return;
    setName(selected?.name || '');
    setContent(selected?.content || '');
    setSaved(false);
    setError('');
  }, [selected?.id, isCreating]); // eslint-disable-line react-hooks/exhaustive-deps

  function startCreate() {
    setIsCreating(true);
    setSelectedId(null);
    setName('');
    setContent('');
    setSaved(false);
    setError('');
  }

  async function handleSave() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      if (isCreating) {
        const created = await api.createPrompt({ name, content });
        setIsCreating(false);
        load(created.id);
      } else if (selected) {
        await api.updatePrompt(selected.id, { name, content });
        load();
      }
      setSaved(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!selected || !(await confirm(`Xoá prompt "${selected.name}"?`))) return;
    setSaving(true);
    setError('');
    try {
      await api.deletePrompt(selected.id);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleSetDefault() {
    if (!selected) return;
    setSaving(true);
    setError('');
    try {
      await api.setDefaultPrompt(selected.id);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <SectionTitle title="Prompt dịch">
        Mỗi prompt là hướng dẫn dịch cho một loại sách: giọng văn, cách xưng hô, mức độ sát nghĩa, thuật ngữ. Gán prompt cho một cuốn sách ở phần Sửa thông tin của sách đó; sách chưa gán dùng prompt mặc định.
      </SectionTitle>

      {loadError ? (
        <Notice action={<Button size="sm" onClick={() => load()}>Thử lại</Button>}>Không tải được danh sách prompt: {loadError}.</Notice>
      ) : loading ? (
        <p className="text-body text-mute">Đang tải…</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
          <div className="space-y-2">
            <Button onClick={startCreate} className="w-full"><Plus size={15} /> Tạo prompt mới</Button>
            <ul className="space-y-0.5">
              {prompts.map((p) => {
                const isActive = !isCreating && selectedId === p.id;
                return (
                  <li key={p.id}>
                    <button
                      type="button"
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => { setIsCreating(false); setSelectedId(p.id); }}
                      className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-body transition-colors ${
                        isActive ? 'bg-accent-soft font-medium text-accent' : 'text-soft hover:bg-sunken hover:text-ink'
                      }`}
                    >
                      <span className="truncate">{p.name}</span>
                      {Boolean(p.is_default) && <Tag tone="ok" className="shrink-0">Mặc định</Tag>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="min-w-0 space-y-4">
            {!selected && !isCreating ? (
              <p className="text-body text-mute">Chọn một prompt để xem và sửa, hoặc tạo prompt mới.</p>
            ) : (
              <>
                <Field label="Tên prompt (loại sách)">
                  <input
                    value={name}
                    onChange={(e) => { setName(e.target.value); setSaved(false); }}
                    placeholder="VD: Tiểu thuyết, Sách kỹ thuật, Sách thiếu nhi"
                    className={inputClass}
                  />
                </Field>

                <Field
                  label="Hướng dẫn dịch"
                  hint="Chỉ cần viết cách dịch. Ứng dụng tự thêm quy tắc định dạng kết quả (các trường dữ liệu, bôi đậm, danh sách từ vựng) khi gửi cho AI. Prompt cũ đã có sẵn các quy tắc đó vẫn dùng được như trước."
                >
                  <textarea
                    value={content}
                    onChange={(e) => { setContent(e.target.value); setSaved(false); }}
                    rows={18}
                    spellCheck={false}
                    className={`${inputClass} text-meta leading-relaxed`}
                  />
                </Field>

                {error && <Notice>{error}</Notice>}
                {saved && <Notice tone="ok">Đã lưu prompt.</Notice>}

                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={handleSave} disabled={saving || !name.trim() || !content.trim()}>
                    {saving ? 'Đang lưu…' : isCreating ? 'Tạo prompt' : 'Lưu prompt'}
                  </Button>
                  {!isCreating && selected && (
                    <>
                      <Button onClick={handleSetDefault} disabled={saving || Boolean(selected.is_default)}>Đặt làm mặc định</Button>
                      <Button variant="danger" onClick={handleDelete} disabled={saving || Boolean(selected.is_default) || prompts.length <= 1}>Xoá prompt</Button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  const tabs = TABS.filter((x) => !x.permission || can(x.permission));
  const [tab, setTab] = useState('account');

  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Cài đặt" />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <SectionNav tabs={tabs} active={tab} onChange={setTab} />

        <Sheet className="p-5 sm:p-7">
          {tab === 'interface' && <InterfaceTab />}
          {tab === 'tts' && <TtsTab />}
          {tab === 'ai' && can('settings.ai') && <AiProviderTab />}
          {tab === 'prompts' && can('prompts.manage') && <PromptsTab />}
          {tab === 'account' && <AccountTab />}
          {tab === 'users' && can('users.manage') && <UserManagement />}
          {tab === 'activity' && can('users.manage') && <ActivityLog />}
          {tab === 'data' && can('users.manage') && <DataManagement />}
        </Sheet>
      </div>
    </PageContainer>
  );
}
