import test from 'node:test';
import assert from 'node:assert/strict';
import { newClip, splitClips, moveBoundary, mergeBoundary, namedClips, parseTime, formatTime, validateDraft } from '../src/domain.mjs';

test('备课流程：连续切分、微调共用边界、跳过片头、手动命名不被统一命名覆盖', () => {
  let clips = [newClip(0, 120)];
  clips = splitClips(clips, 12.125);
  clips = splitClips(clips, 45);
  clips[0].checked = false;
  clips[1].name = '课文范读'; clips[1].manual = true;
  clips = moveBoundary(clips, 1, 13.5);
  assert.equal(clips[0].end, 13.5);
  assert.equal(clips[1].start, 13.5);
  assert.equal(clips[1].end, clips[2].start);
  assert.deepEqual(namedClips(clips, '荷叶圆圆').filter(c => c.checked).map(c => c.filename), ['课文范读.mp3', '荷叶圆圆_002.mp3']);
  const merged = mergeBoundary(clips, 2);
  assert.equal(merged[1].name, '课文范读'); assert.equal(merged[1].end, 120);
});
test('导出名称：中文、保留名、不合法字符、大小写重名与用户填写扩展名', () => {
  const names = ['课文/范读', '课文_范读.mp3', 'CON', 'a', 'A', ''];
  const clips = names.map((name, i) => ({ ...newClip(i, i + 1), name, manual: true }));
  assert.deepEqual(namedClips(clips, '语文').map(c => c.filename), ['课文_范读.mp3', '课文_范读_2.mp3', '_CON.mp3', 'a.mp3', 'A_2.mp3', '语文_006.mp3']);
});
test('边界约束：不允许零长度、重叠、跨越相邻边界；失败不改原内容', () => {
  const clips = splitClips([newClip(0, 10)], 4);
  const original = structuredClone(clips);
  assert.throws(() => splitClips(clips, 4));
  assert.throws(() => moveBoundary(clips, 1, 0));
  assert.throws(() => moveBoundary(clips, 1, 10));
  assert.deepEqual(clips, original);
});
test('时间输入与草稿恢复：毫秒精度，损坏或不连续的草稿被拒绝', () => {
  assert.equal(parseTime('01:23.125'), 83.125);
  assert.equal(parseTime('1:02:03.5'), 3723.5);
  assert.equal(formatTime(59.9996), '01:00.000');
  assert.throws(() => parseTime('01:63'));
  const draft = { version: 1, file: { name: '课文.mp4', size: 100, duration: 10 }, prefix: '课文', format: 'mp3', clips: splitClips([newClip(0, 10)], 4) };
  assert.ok(validateDraft(draft));
  draft.clips[1].start = 5;
  assert.equal(validateDraft(draft), null);
});
