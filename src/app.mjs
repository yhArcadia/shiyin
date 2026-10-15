import { MIN_CLIP, roundTime, formatTime, parseTime, newClip, splitClips, moveBoundary, mergeBoundary, baseName, safeName, namedClips, validateDraft, matchingFile } from './domain.mjs';
import { createTimelineController } from './timeline.mjs';
import { waitForTask } from './engine-loader.mjs';

const $ = id => document.getElementById(id);
const video = $('video');
const DRAFT_KEY = 'shiyin.draft.v1';
const state = { file: null, url: null, duration: 0, clips: [], prefix: '', format: 'mp3', marker: null, zoom: 1, previewEnd: null };
let undoStack = [], redoStack = [], nameEdit = null, busy = false, currentJob = null, raf = null, scrubbing = false, activeClip = null, toastTimer, dragDepth = 0, draftWarningShown = false;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<i data-lucide="${name}" aria-hidden="true"></i>`;
function icons() { window.lucide?.createIcons({ attrs: { width: 19, height: 19 } }); }
function notify(text, error = false) { clearTimeout(toastTimer); $('toast').textContent = text; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 6500 : 3800); }
function status(text) { $('editorStatus').textContent = text; }
function readDraft() { try { return validateDraft(JSON.parse(localStorage.getItem(DRAFT_KEY))); } catch { return null; } }
function snapshot() { return structuredClone({ clips: state.clips, prefix: state.prefix, format: state.format, marker: state.marker }); }
function pushHistory(previous = snapshot()) { undoStack.push(previous); if (undoStack.length > 50) undoStack.shift(); redoStack = []; paintHistory(); }
function paintHistory() { $('undoButton').disabled = !undoStack.length; $('redoButton').disabled = !redoStack.length; }
function saveDraft() {
  if (!state.file) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 1, file: { name: state.file.name, size: state.file.size, lastModified: state.file.lastModified, duration: state.duration }, clips: state.clips, prefix: state.prefix, format: state.format, marker: state.marker, updatedAt: Date.now() }));
    $('saveStatus').innerHTML = `${icon('check')}已在本机保存草稿`;
  } catch {
    $('saveStatus').textContent = '当前浏览器暂时不能保存草稿';
    if (!draftWarningShown) { notify('浏览器暂时不能保存草稿，仍可以继续编辑和下载。'); draftWarningShown = true; }
  }
}
function mutate(action, message) {
  if (busy || !state.file) return;
  const previous = snapshot();
  try { action(); pushHistory(previous); saveDraft(); renderAll(); if (message) status(message); }
  catch (error) { notify(error.message, true); }
}
function restoreHistory(direction) {
  if (busy || !state.file) return;
  const source = direction === 'undo' ? undoStack : redoStack, destination = direction === 'undo' ? redoStack : undoStack;
  if (!source.length) return;
  destination.push(snapshot()); Object.assign(state, source.pop()); nameEdit = null;
  saveDraft(); renderAll(); status(direction === 'undo' ? '已经撤销上一步。' : '已经恢复这一步。');
}
function cutPosition() { return Number.isFinite(state.marker) ? state.marker : video.currentTime || 0; }
function canSplit() { const t = cutPosition(); return state.clips.some(c => t - c.start >= MIN_CLIP && c.end - t >= MIN_CLIP); }
function highlight(time) {
  const id = state.clips.find(c => time >= c.start && time < c.end)?.id || state.clips.at(-1)?.id;
  if (id === activeClip) return;
  activeClip = id;
  for (const element of document.querySelectorAll('[data-clip], [data-segment]')) element.classList.toggle('is-current', (element.dataset.clip || element.dataset.segment) === id);
}
function paintTime(forced) {
  if (!state.file) return;
  const time = forced ?? video.currentTime ?? 0;
  $('playbackTime').textContent = formatTime(time);
  $('playState').textContent = video.paused ? '已暂停' : state.previewEnd !== null ? '正在听这一段' : '正在播放';
  if (!scrubbing) $('seek').value = time;
  const marked = Number.isFinite(state.marker);
  $('markerPin').hidden = !marked;
  $('markerPin').style.left = `${(state.marker || 0) / state.duration * 100}%`;
  $('markerTime').textContent = marked ? `分段标记 ${formatTime(state.marker)}` : '拖动后留下分段标记';
  $('returnButton').disabled = !marked;
  if (document.activeElement !== $('markerInput')) $('markerInput').value = marked ? formatTime(state.marker) : '';
  $('splitButton').disabled = !canSplit();
  $('splitButton').querySelector('span').textContent = marked ? '在标记处分段' : '在播放位置分段';
  highlight(time);
}
function paintPlayButton() {
  const playing = !video.paused;
  $('playButton').innerHTML = `${icon(playing ? 'pause' : 'play')}<span>${playing ? '暂停' : '播放看看'}</span>`;
  $('screenPlayButton').innerHTML = icon(playing ? 'pause' : 'play');
  $('screenPlayButton').setAttribute('aria-label', playing ? '暂停视频' : '播放视频');
  icons(); paintTime();
}
function frame() {
  if (video.paused) return;
  if (state.previewEnd !== null && video.currentTime >= state.previewEnd - 0.008) {
    const end = state.previewEnd; state.previewEnd = null; video.pause(); video.currentTime = end;
    status('这一段听完了。分段标记保持不变。'); paintTime(end); return;
  }
  paintTime(); raf = requestAnimationFrame(frame);
}
async function togglePlay() {
  if (!state.file || busy) return;
  if (!video.paused) { video.pause(); return; }
  if (video.currentTime >= state.duration - 0.01) video.currentTime = 0;
  state.previewEnd = null;
  try { await video.play(); } catch { notify('视频暂时没能播放，请再点一次，或换一个常见的 MP4 视频。', true); }
}
function scrollToTime(time) {
  timeline.scrollToTime(time);
}
function seekTo(time, mark = false, reveal = true) {
  if (!state.file) return;
  const value = Math.max(0, Math.min(state.duration, roundTime(time)));
  video.pause(); state.previewEnd = null; video.currentTime = value;
  if (mark) { state.marker = value; saveDraft(); status(`已记住 ${formatTime(value)}。播放确认后，直接按标记分段。`); }
  paintTime(value); if (reveal) scrollToTime(value);
}
function split() {
  if (busy || !state.file) return;
  const point = roundTime(cutPosition());
  mutate(() => { state.clips = splitClips(state.clips, point); }, `已在 ${formatTime(point)} 分段，播放位置保持不变。拖动可以留下下一个标记。`);
}
function clipNote(clip) {
  const raw = `${clip.label}.${state.format}`;
  const adjusted = raw !== clip.filename;
  return `${adjusted ? `<span>保存为：${escape(clip.filename)}</span>` : ''}${clip.manual ? `<button class="quiet" data-auto="${clip.id}">恢复自动命名</button>` : ''}`;
}
function renderClips() {
  const top = $('clipList').scrollTop;
  const named = namedClips(state.clips, state.prefix, state.format);
  $('clipList').innerHTML = named.map((clip, i) => `<article class="clip ${clip.checked ? 'is-checked' : ''}" data-clip="${clip.id}" aria-label="第 ${i + 1} 段">
    <div class="clip-top"><input type="checkbox" data-check="${clip.id}" ${clip.checked ? 'checked' : ''} aria-label="保存第 ${i + 1} 段"><input class="clip-name" type="text" data-name="${clip.id}" value="${escape(clip.label)}" maxlength="160" aria-label="第 ${i + 1} 段的音频名称"></div>
    <div class="clip-badges"><span class="clip-select-state">${clip.checked ? '将导出' : '不导出'}</span><span class="current-tag">当前片段</span></div>
    <div class="clip-bottom"><span class="clip-time">${formatTime(clip.start)} — ${formatTime(clip.end)}</span><div class="clip-actions"><button class="quiet" data-listen="${clip.id}">${icon('headphones')}听这一段</button><button class="quiet" data-export="${clip.id}" aria-label="下载第 ${i + 1} 段音频">${icon('download')}</button></div></div>
    <div class="filename-note" data-note="${clip.id}">${clipNote(clip)}</div></article>`).join('');
  $('clipList').scrollTop = top; activeClip = null; icons(); highlight(video.currentTime);
}
function renderTimeline() {
  timeline.render();
}
function renderSummary() {
  const selected = state.clips.filter(c => c.checked), seconds = selected.reduce((sum, c) => sum + c.end - c.start, 0);
  $('selectedCount').textContent = `已选 ${selected.length} / ${state.clips.length} 段`;
  $('selectedDuration').textContent = selected.length ? `合计 ${formatTime(seconds, 1)}` : '勾选需要的片段';
  $('exportButton').querySelector('span').textContent = selected.length ? `下载选中的 ${selected.length} 段音频` : '先勾选要保存的片段';
  $('exportButton').disabled = !selected.length;
  $('prefixInput').value = state.prefix; $('formatSelect').value = state.format;
  paintHistory();
}
function renderAll() { renderClips(); renderTimeline(); renderSummary(); paintTime(); }
const timeline = createTimelineController({
  state, video, isBusy: () => busy,
  getNames: () => namedClips(state.clips, state.prefix, state.format),
  capture: snapshot,
  onPaint: () => { activeClip = null; paintTime(); },
  onSelect: clip => {
    seekTo(clip.start, false, false);
    const row = document.querySelector(`[data-clip="${clip.id}"]`), list = $('clipList');
    if (row) {
      const r = row.getBoundingClientRect(), container = list.getBoundingClientRect();
      if (r.top < container.top || r.bottom > container.bottom) list.scrollTo({ top: list.scrollTop + r.top - container.top - list.clientHeight / 2 + r.height / 2, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    }
  },
  onMoveBoundary: (index, position) => mutate(() => { state.clips = moveBoundary(state.clips, index, position); }, '相邻两段的边界已一起调整。'),
  onCommitDrag: previous => { pushHistory(previous); saveDraft(); renderAll(); status('相邻两段的边界已一起调整，可以撤销。'); },
  onMerge: index => mutate(() => { state.clips = mergeBoundary(state.clips, index); }, '已合并前后两段，保留前一段的名称。可以撤销。')
});
function updateNotes() {
  for (const clip of namedClips(state.clips, state.prefix, state.format)) {
    const note = document.querySelector(`[data-note="${clip.id}"]`); if (note) note.innerHTML = clipNote(clip);
  }
  timeline.refreshLabels();
}
function askToReplace() {
  $('confirmTitle').textContent = '打开另一个视频？';
  $('confirmText').textContent = '新视频的草稿会替换上次的草稿。如果当前还有要保存的音频，可以先完成下载。';
  return new Promise(resolve => {
    const dialog = $('confirmDialog');
    const finish = value => { $('confirmYes').onclick = null; $('confirmNo').onclick = null; dialog.removeEventListener('cancel', cancel); dialog.close(); resolve(value); };
    const cancel = event => { event.preventDefault(); finish(false); };
    $('confirmYes').onclick = () => finish(true); $('confirmNo').onclick = () => finish(false);
    dialog.addEventListener('cancel', cancel); dialog.showModal();
  });
}
async function inspectFile(file) {
  const url = URL.createObjectURL(file), probe = document.createElement('video'); probe.preload = 'metadata';
  try {
    const duration = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('读取视频有点慢。请重新选择文件试试。')), 30000);
      probe.onloadedmetadata = () => { clearTimeout(timeout); if (Number.isFinite(probe.duration) && probe.duration >= MIN_CLIP) resolve(roundTime(probe.duration)); else reject(new Error('这个视频的时长无法读取，请换一个完整的 MP4 视频。')); };
      probe.onerror = () => { clearTimeout(timeout); reject(new Error('浏览器暂时打不开这个视频。推荐使用能正常播放的 MP4、MOV 或 WebM 视频。')); };
      probe.src = url;
    });
    return { url, duration };
  } catch (error) { URL.revokeObjectURL(url); throw error; }
  finally { probe.onloadedmetadata = null; probe.onerror = null; probe.removeAttribute('src'); probe.load(); }
}
let opening = false;
async function openFile(file) {
  if (!file || busy || opening) return;
  if (!file.size) { notify('这个文件是空的，请重新选择视频。', true); return; }
  if (file.size >= 1024 ** 3) { notify('这一版适合 1 GB 以内的视频。请先换一个小一些的课堂素材。', true); return; }
  opening = true; $('openButton').disabled = true; let candidate;
  try {
    status('正在打开视频…');
    candidate = await inspectFile(file);
    const draft = readDraft();
    const restore = matchingFile(draft, file, candidate.duration);
    if (state.file?.name === file.name && state.file?.size === file.size && state.file?.lastModified === file.lastModified) { URL.revokeObjectURL(candidate.url); notify('这就是当前打开的视频，可以继续编辑。'); return; }
    if ((state.file || draft) && !restore && !(await askToReplace())) { URL.revokeObjectURL(candidate.url); return; }
    video.pause(); timeline.reset(); if (state.url) URL.revokeObjectURL(state.url);
    Object.assign(state, { file, url: candidate.url, duration: candidate.duration, clips: restore ? structuredClone(draft.clips) : [newClip(0, candidate.duration)], prefix: restore ? draft.prefix : baseName(file.name), format: restore ? draft.format : 'mp3', marker: restore && Number.isFinite(draft.marker) ? Math.max(0, Math.min(candidate.duration, draft.marker)) : null, zoom: 1, previewEnd: null });
    undoStack = []; redoStack = []; nameEdit = null;
    video.src = state.url; video.load(); $('seek').max = state.duration;
    $('welcome').hidden = true; $('workspace').hidden = false;
    $('projectTitle').textContent = `给《${baseName(file.name)}》准备音频`;
    $('fileDescription').textContent = `${file.name} · ${formatTime(state.duration, 0)} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    $('durationText').textContent = ` / ${formatTime(state.duration, 0)}`;
    saveDraft(); renderAll(); icons();
    status(restore ? '上次的分段、名称和勾选已恢复，可以继续编辑。' : '视频已打开。拖到想分段的位置，松手留下标记，再播放确认。');
    if (restore) notify('上次的编辑已经恢复。');
  } catch (error) { notify(error.message, true); }
  finally { opening = false; $('openButton').disabled = false; $('fileInput').value = ''; }
}
function downloadBlob() {
  if (!currentJob?.url) return;
  $('saveExportButton').querySelector('span').textContent = '再保存一份';
  $('exportLocalNote').textContent = '已交给浏览器保存，可以在浏览器的下载记录中查看。';
}
function clearArtifact() { if (currentJob?.url) { URL.revokeObjectURL(currentJob.url); currentJob.url = null; } }
function updateExport(update) {
  if (currentJob?.canceled) return;
  const titles = { loading: '正在准备音频工具', reading: '正在读取视频里的声音', encoding: '正在导出音频', packing: '正在准备保存' };
  $('exportTitle').textContent = titles[update.phase] || '正在准备音频';
  $('exportMessage').textContent = update.message;
  if (Number.isFinite(update.progress)) $('exportProgress').value = Math.max(0, Math.min(1, update.progress));
  else $('exportProgress').removeAttribute('value');
  $('exportPercent').textContent = update.detail || (update.phase === 'loading' && Number.isFinite(update.progress) ? `工具准备 ${Math.round(update.progress * 100)}%` : update.phase === 'encoding' ? `${Math.round(update.progress * 100)}%` : '');
}
async function startExport(ids = null) {
  if (!state.file || busy || opening) return;
  const all = namedClips(state.clips, state.prefix, state.format), clips = all.filter(c => ids ? ids.includes(c.id) : c.checked);
  if (!clips.length) { notify('先勾选需要保存的片段。'); return; }
  timeline.closeMenu(); clearArtifact(); currentJob = { ids: clips.map(c => c.id), canceled: false, cancel: null, url: null };
  const job = currentJob; job.controller = new AbortController(); job.cancel = () => job.controller.abort(); busy = true; video.pause(); state.previewEnd = null;
  $('editor').inert = true; $('openButton').disabled = true;
  $('exportTitle').textContent = '正在准备音频'; $('exportMessage').textContent = '稍等一下，正在准备…'; $('exportProgress').value = 0; $('exportProgress').hidden = false;
  $('exportPercent').textContent = ''; $('exportFileList').replaceChildren();
  $('cancelExportButton').hidden = false; $('cancelExportButton').disabled = false;
  for (const id of ['saveExportButton', 'closeExportButton', 'retryExportButton']) $(id).hidden = true;
  $('exportLocalNote').textContent = '视频仍在你的设备里，请保持页面在前台；关闭页面会中断处理。';
  if (!$('exportDialog').open) $('exportDialog').showModal();
  updateExport({ phase: 'loading', progress: null, message: '正在连接音频工具…', detail: '首次需要下载约 31 MB，请保持页面在前台' });
  let result;
  try {
    const module = await waitForTask(() => import('./exporter.mjs?v=20261015-2'), { signal: job.controller.signal, stage: 'export-module' });
    job.cancel = () => { job.controller.abort(); module.cancelExport(); };
    result = job.canceled ? { canceled: true, completed: [], remaining: job.ids, error: '已取消导出，分段和名称都保留着。' } : await module.exportClips({ file: state.file, clips, format: state.format, archiveName: `${safeName(state.prefix)}_课堂音频`, onUpdate: updateExport });
  } catch (error) { console.error(error); result = { canceled: job.canceled, error: error.userMessage || '音频工具暂时没有准备好，请重试。你的编辑内容仍然保留。', completed: [], remaining: job.ids }; }
  finally { busy = false; $('editor').inert = false; $('openButton').disabled = false; }
  $('cancelExportButton').hidden = true; $('closeExportButton').hidden = false; $('exportProgress').hidden = true; $('exportPercent').textContent = '';
  if (result.artifact) {
    job.url = URL.createObjectURL(result.artifact.blob); job.filename = result.artifact.filename;
    $('saveExportButton').href = job.url; $('saveExportButton').download = job.filename;
    $('saveExportButton').hidden = false; $('saveExportButton').querySelector('span').textContent = result.error ? '保存已完成的音频' : clips.length > 1 ? '保存音频压缩包' : '保存这段音频';
  }
  job.retryIds = result.artifact ? result.remaining : job.ids;
  $('retryExportButton').hidden = !job.retryIds.length || (!result.error && !result.canceled);
  $('exportTitle').textContent = result.canceled ? '已取消，编辑还在' : result.error ? result.artifact ? `已完成 ${result.completed.length} 段` : '这次没有导出成功' : '音频准备好了';
  $('exportMessage').textContent = result.canceled ? '分段、名称和勾选都保留着，可以稍后重试。' : result.error || (clips.length > 1 ? `共 ${clips.length} 段，已经放进一个压缩包。点击下面的按钮保存。` : '点击下面的按钮，把这段声音保存到电脑。');
  $('exportFileList').innerHTML = clips.filter(c => result.completed.includes(c.id) && result.artifact).map(c => `<p>✓ ${escape(c.filename)}</p>`).join('');
  $('exportLocalNote').textContent = '原视频和编辑草稿都保留在本机。'; icons();
  (result.artifact ? $('saveExportButton') : $('closeExportButton')).focus();
}

$('openButton').onclick = $('dropzone').onclick = $('resumeButton').onclick = () => { if (!busy) $('fileInput').click(); };
$('fileInput').addEventListener('change', () => openFile($('fileInput').files[0]));
$('helpButton').onclick = () => $('helpDialog').showModal();
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => $(button.dataset.close).close(); });
$('playButton').onclick = $('screenPlayButton').onclick = togglePlay;
$('splitButton').onclick = split;
$('returnButton').onclick = () => { if (Number.isFinite(state.marker)) { seekTo(state.marker); status('已回到标记，可以再听一次。'); } };
$('undoButton').onclick = () => restoreHistory('undo'); $('redoButton').onclick = () => restoreHistory('redo');
$('seek').addEventListener('pointerdown', () => { scrubbing = true; video.pause(); state.previewEnd = null; });
$('seek').addEventListener('input', event => { scrubbing = true; video.pause(); state.previewEnd = null; video.currentTime = Number(event.target.value); paintTime(Number(event.target.value)); });
$('seek').addEventListener('change', event => { scrubbing = false; const time = Number(event.target.value); state.marker = roundTime(time); video.currentTime = time; saveDraft(); paintTime(time); status(`已记住 ${formatTime(time)}。播放确认后，直接点“在标记处分段”。`); });
$('seek').addEventListener('pointercancel', () => { scrubbing = false; paintTime(); });
$('seek').addEventListener('pointerup', () => { scrubbing = false; });
function commitMarkerInput(event) { try { const time = parseTime(event.target.value); if (time > state.duration) throw new Error('标记不能超过视频结尾。'); seekTo(time, true); } catch (error) { notify(error.message, true); event.target.value = Number.isFinite(state.marker) ? formatTime(state.marker) : ''; } }
$('markerInput').addEventListener('change', commitMarkerInput);
$('markerInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); commitMarkerInput(event); } });
$('markerBack').onclick = () => seekTo(cutPosition() - 0.1, true); $('markerForward').onclick = () => seekTo(cutPosition() + 0.1, true);
$('selectAll').onclick = () => mutate(() => { state.clips.forEach(c => { c.checked = true; }); }, '已经选中全部片段。');
$('selectNone').onclick = () => mutate(() => { state.clips.forEach(c => { c.checked = false; }); }, '已取消勾选，可以重新选择需要的片段。');
$('prefixInput').addEventListener('change', event => { const value = event.target.value.trim() || baseName(state.file.name); mutate(() => { state.prefix = value; }, '统一名称已更新，手动起的名字会保留。'); });
$('formatSelect').addEventListener('change', event => { const value = event.target.value; mutate(() => { state.format = value; }); });
$('clipList').addEventListener('focusin', event => { if (event.target.matches('[data-name]')) nameEdit = { id: event.target.dataset.name, before: snapshot(), saved: false }; });
$('clipList').addEventListener('input', event => {
  const id = event.target.dataset.name; if (!id || busy) return;
  if (!nameEdit || nameEdit.id !== id) nameEdit = { id, before: snapshot(), saved: false };
  if (!nameEdit.saved) { pushHistory(nameEdit.before); nameEdit.saved = true; }
  const clip = state.clips.find(c => c.id === id); clip.name = event.target.value; clip.manual = true; saveDraft(); updateNotes();
});
$('clipList').addEventListener('focusout', event => {
  const id = event.target.dataset.name; if (!id) return;
  const clip = state.clips.find(c => c.id === id); if (!clip) return;
  if (!clip.name.trim()) { clip.name = ''; clip.manual = false; event.target.value = namedClips(state.clips, state.prefix, state.format).find(c => c.id === id).label; }
  nameEdit = null; saveDraft(); updateNotes();
});
$('clipList').addEventListener('change', event => {
  if (event.target.dataset.check) { const id = event.target.dataset.check, checked = event.target.checked; mutate(() => { state.clips.find(c => c.id === id).checked = checked; }); }
});
$('clipList').addEventListener('click', async event => {
  if (busy) return;
  const button = event.target.closest('button');
  if (!button) {
    const row = event.target.closest('[data-clip]');
    if (row && !event.target.closest('input,button,a,select,textarea,label') && !window.getSelection()?.toString()) {
      mutate(() => { const clip = state.clips.find(c => c.id === row.dataset.clip); clip.checked = !clip.checked; });
    }
    return;
  }
  if (button.dataset.listen) {
    const clip = state.clips.find(c => c.id === button.dataset.listen); video.pause(); video.currentTime = clip.start; state.previewEnd = clip.end;
    try { await video.play(); status(`正在听「${namedClips(state.clips, state.prefix, state.format).find(c => c.id === clip.id).label}」，到结尾会自动暂停。`); } catch { notify('暂时没能播放，请再试一次。', true); }
  }
  if (button.dataset.export) startExport([button.dataset.export]);
  if (button.dataset.auto) mutate(() => { const clip = state.clips.find(c => c.id === button.dataset.auto); clip.manual = false; clip.name = ''; }, '已经恢复自动命名。');
});
video.addEventListener('play', () => { cancelAnimationFrame(raf); paintPlayButton(); raf = requestAnimationFrame(frame); });
video.addEventListener('pause', () => { cancelAnimationFrame(raf); paintPlayButton(); });
video.addEventListener('timeupdate', () => { if (!scrubbing) paintTime(); });
video.addEventListener('loadedmetadata', () => paintTime());
video.addEventListener('error', () => { if (state.file) notify('这个视频暂时无法播放，建议使用常见的 MP4 视频。', true); });
$('exportButton').onclick = () => startExport();
$('cancelExportButton').onclick = () => { if (!busy) return; currentJob.canceled = true; currentJob.cancel?.(); $('cancelExportButton').disabled = true; $('exportMessage').textContent = '正在取消，分段和名称会保留…'; };
$('saveExportButton').onclick = downloadBlob;
$('closeExportButton').onclick = () => $('exportDialog').close();
$('retryExportButton').onclick = () => startExport(currentJob.retryIds);
$('exportDialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('exportDialog').addEventListener('close', clearArtifact);
document.addEventListener('keydown', event => {
  if (!state.file || busy || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable],summary,#boundaryMenu')) return;
  const command = event.ctrlKey || event.metaKey;
  if (command && event.key.toLowerCase() === 'z') { event.preventDefault(); restoreHistory(event.shiftKey ? 'redo' : 'undo'); return; }
  if (command || event.altKey) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.key.toLowerCase() === 's') { event.preventDefault(); split(); }
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); seekTo((video.currentTime || 0) + (event.shiftKey ? 0.1 : 1) * (event.key === 'ArrowRight' ? 1 : -1), true); }
});
document.addEventListener('dragenter', event => { if (!event.dataTransfer.types.includes('Files') || busy) return; event.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } });
document.addEventListener('dragleave', event => { if (event.dataTransfer.types.includes('Files') && --dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
document.addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; if (!busy) openFile(event.dataTransfer.files[0]); });
window.addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
const draft = readDraft();
if (draft) { $('draftBanner').hidden = false; $('draftDescription').textContent = `重新选择「${draft.file.name}」，就能接着做。`; }
icons();
