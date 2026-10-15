export const MIN_CLIP = 0.05;
export const roundTime = value => Math.round(value * 1000) / 1000;
export function formatTime(value, precision = 3) {
  const total = Math.max(0, Math.round((Number(value) || 0) * 1000));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  const fraction = precision ? `.${String(total % 1000).padStart(3, '0').slice(0, precision)}` : '';
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${fraction}`;
}
export function parseTime(text) {
  const parts = String(text).trim().replace('：', ':').split(':');
  if (!parts.length || parts.length > 3 || parts.some(p => !/^\d+(?:\.\d{1,3})?$/.test(p))) throw new Error('请输入时间，例如 01:23.500。');
  if (parts.slice(1).some(p => Number(p) >= 60) || parts.slice(0, -1).some(p => p.includes('.'))) throw new Error('冒号后的分、秒需要小于 60。');
  return roundTime(parts.reduce((sum, part) => sum * 60 + Number(part), 0));
}
export function newClip(start, end, checked = true) {
  return { id: crypto.randomUUID(), start: roundTime(start), end: roundTime(end), checked, name: '', manual: false };
}
export function splitClips(clips, position) {
  const point = roundTime(position);
  const index = clips.findIndex(c => point - c.start >= MIN_CLIP && c.end - point >= MIN_CLIP);
  if (index < 0) throw new Error('这里已经是分段位置，或者离边界太近。请稍微移动标记。');
  const result = structuredClone(clips);
  const old = result[index];
  result.splice(index, 1, { ...old, end: point }, newClip(point, old.end, old.checked));
  return result;
}
export function moveBoundary(clips, index, position) {
  if (index < 1 || index >= clips.length) throw new Error('视频开头和结尾保持不变。可以把不要的部分分出来，取消勾选。');
  const point = roundTime(position);
  if (!Number.isFinite(point) || point - clips[index - 1].start < MIN_CLIP || clips[index].end - point < MIN_CLIP) throw new Error('分段位置需要在前后两个边界之间，每段至少保留 0.05 秒。');
  const result = structuredClone(clips);
  result[index - 1].end = point;
  result[index].start = point;
  return result;
}
export function mergeBoundary(clips, index) {
  if (index < 1 || index >= clips.length) throw new Error('这个位置没有可以合并的片段。');
  const result = structuredClone(clips);
  const left = result[index - 1], right = result[index];
  result.splice(index - 1, 2, { ...left, end: right.end, checked: left.checked || right.checked });
  return result;
}
export function baseName(name) { return String(name).replace(/\.[^.]+$/, '') || '课堂音频'; }
export function safeName(value) {
  let text = String(value).normalize('NFC').replace(/\.(mp3|wav)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[.\s]+$/g, '').trim();
  if (!text) text = '音频片段';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(text)) text = `_${text}`;
  return Array.from(text).slice(0, 100).join('');
}
export function namedClips(clips, prefix, format = 'mp3') {
  const used = new Set();
  let number = 0;
  return clips.map((clip, i) => {
    if (clip.checked) number++;
    const suggested = `${prefix || '课堂音频'}_${String(clip.checked ? number : i + 1).padStart(3, '0')}`;
    const label = clip.manual && clip.name.trim() ? clip.name : suggested;
    const base = safeName(label);
    let name = base, suffix = 2;
    if (clip.checked) {
      while (used.has(name.toLocaleLowerCase())) name = `${base}_${suffix++}`;
      used.add(name.toLocaleLowerCase());
    }
    return { ...clip, label, filename: `${name}.${format}` };
  });
}
export function validateDraft(raw) {
  if (!raw || raw.version !== 1 || !raw.file || typeof raw.file.name !== 'string' || !Number.isFinite(raw.file.size) || raw.file.size < 0 || !Number.isFinite(raw.file.duration) || raw.file.duration <= 0 || typeof raw.prefix !== 'string' || !['mp3', 'wav'].includes(raw.format) || !Array.isArray(raw.clips) || !raw.clips.length || raw.clips.length > 2000) return null;
  const ids = new Set();
  for (let i = 0; i < raw.clips.length; i++) {
    const c = raw.clips[i];
    if (!c || typeof c.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(c.id) || ids.has(c.id) || typeof c.name !== 'string' || c.name.length > 500 || typeof c.checked !== 'boolean' || typeof c.manual !== 'boolean' || !Number.isFinite(c.start) || !Number.isFinite(c.end) || c.end - c.start < MIN_CLIP - 0.001 || Math.abs(c.start - (i ? raw.clips[i - 1].end : 0)) > 0.001) return null;
    ids.add(c.id);
  }
  if (Math.abs(raw.clips.at(-1).end - raw.file.duration) > 0.01) return null;
  return raw;
}
export function matchingFile(draft, file, duration) { return draft?.file.name === file.name && draft.file.size === file.size && Math.abs(draft.file.duration - duration) < 0.05; }
