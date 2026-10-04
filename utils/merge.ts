import type { DictionaryEntry, ReviewComment } from '~/types/dictionary';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;

/** 冲突解决方式：保留本地 / 采用远端 / 拼接双方 */
export type ConflictResolution = 'local' | 'remote' | 'combine';

/** 冲突类型 */
export type ConflictKind =
  | 'scalar'          // 词条标量字段双方都改了
  | 'item-scalar'     // 嵌套条目（方言/例句/来源/意见）的标量字段双方都改了
  | 'entry-removal'   // 一方删词条，另一方改了该词条
  | 'item-removal'    // 一方删条目，另一方改了该条目
  | 'entry-add'       // 双方各自新增了同 id 词条
  | 'item-add';       // 双方各自新增了同 id 条目

export interface FieldConflict {
  id: string;
  entryId: string;
  entryHeadword: string;
  kind: ConflictKind;
  /** 词条级字段名；条目级冲突时为所属数组字段名 */
  field: string;
  fieldLabel: string;
  /** 条目级冲突时的条目 id */
  itemId?: string;
  /** 条目级冲突时的条目字段名 */
  itemField?: string;
  itemFieldLabel?: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  resolution: ConflictResolution;
}

export interface MergeResult {
  /** 自动合并后的词条（冲突项默认保留本地，待 resolveMerge 应用选择） */
  entries: DictionaryEntry[];
  conflicts: FieldConflict[];
  addedEntryIds: string[];
  removedEntryIds: string[];
  autoMergedFields: number;
}

/** 词条级标量字段（整组比较） */
const ENTRY_SCALAR_FIELDS = ['headword', 'pronunciation', 'partOfSpeech', 'definition', 'status', 'notes', 'synonyms'] as const;
/** 词条级嵌套数组字段（按条目做三方合并） */
const ENTRY_ARRAY_FIELDS = ['dialectVariants', 'examples', 'sources', 'reviewerComments'] as const;

const ENTRY_FIELD_LABELS: Record<string, string> = {
  headword: '词形', pronunciation: '发音', partOfSpeech: '词性', definition: '释义',
  status: '状态', notes: '编者备注', synonyms: '同义词',
  dialectVariants: '方言变体', examples: '例句', sources: '来源', reviewerComments: '审校意见'
};

const ITEM_FIELD_LABELS: Record<string, string> = {
  dialect: '方言点', form: '词形', pronunciation: '读音', note: '使用说明',
  text: '原文', translation: '译文', source: '出处',
  title: '来源名称', citation: '引用信息', url: '链接',
  field: '绑定字段', author: '作者', message: '内容', status: '状态', createdAt: '时间'
};

/** 各方都存在的条目，需要逐字段合并 */
const ITEM_COMPARE_FIELDS: Record<string, string[]> = {
  dialectVariants: ['dialect', 'form', 'pronunciation', 'note'],
  examples: ['text', 'translation', 'source'],
  sources: ['title', 'citation', 'url'],
  reviewerComments: ['field', 'author', 'message', 'status', 'createdAt']
};

interface MergeContext {
  conflicts: FieldConflict[];
  autoMerged: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function pushConflict(
  ctx: MergeContext,
  entry: DictionaryEntry,
  kind: ConflictKind,
  field: string,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
  extra?: { itemId?: string; itemField?: string; resolution?: ConflictResolution }
) {
  ctx.conflicts.push({
    id: uid('conflict'),
    entryId: entry.id,
    entryHeadword: entry.headword || '未命名词条',
    kind,
    field,
    fieldLabel: ENTRY_FIELD_LABELS[field] ?? field,
    itemId: extra?.itemId,
    itemField: extra?.itemField,
    itemFieldLabel: extra?.itemField ? (ITEM_FIELD_LABELS[extra.itemField] ?? extra.itemField) : undefined,
    baseValue,
    localValue,
    remoteValue,
    resolution: extra?.resolution ?? 'local'
  });
}

/** 合并单个条目内部的标量字段 */
function mergeItemFields(
  arrayField: string,
  base: { id: string },
  local: { id: string },
  remote: { id: string },
  entry: DictionaryEntry,
  ctx: MergeContext
): { id: string } {
  const merged: Record<string, unknown> = { ...clone(base) };
  const fields = ITEM_COMPARE_FIELDS[arrayField] ?? Object.keys(base).filter((k) => k !== 'id');

  fields.forEach((field) => {
    const b = (base as Record<string, unknown>)[field];
    const l = (local as Record<string, unknown>)[field];
    const r = (remote as Record<string, unknown>)[field];

    if (same(l, b) && same(r, b)) return; // 都没改
    if (!same(l, b) && same(r, b)) { merged[field] = clone(l); ctx.autoMerged += 1; return; }
    if (same(l, b) && !same(r, b)) { merged[field] = clone(r); ctx.autoMerged += 1; return; }
    // 双方都改了
    if (same(l, r)) { merged[field] = clone(l); ctx.autoMerged += 1; return; }
    pushConflict(ctx, entry, 'item-scalar', arrayField, b, l, r, {
      itemId: base.id, itemField: field
    });
    merged[field] = clone(l); // 默认保留本地，待用户选择
  });

  // 审校意见的回复按 id 取并集，全部保留
  if (arrayField === 'reviewerComments') {
    const baseReplies = (base as ReviewComment).replies ?? [];
    const localReplies = (local as ReviewComment).replies ?? [];
    const remoteReplies = (remote as ReviewComment).replies ?? [];
    const seen = new Set<string>();
    const union: ReviewComment['replies'] = [];
    [...baseReplies, ...localReplies, ...remoteReplies].forEach((reply) => {
      if (reply && !seen.has(reply.id)) { seen.add(reply.id); union.push(clone(reply)); }
    });
    merged.replies = union;
  }

  return merged as { id: string };
}

/** 合并一个嵌套数组字段（按条目 id 做三方合并） */
function mergeArrayField(
  arrayField: string,
  baseItems: { id: string }[],
  localItems: { id: string }[],
  remoteItems: { id: string }[],
  entry: DictionaryEntry,
  ctx: MergeContext
): { id: string }[] {
  const baseMap = new Map(baseItems.map((item) => [item.id, item]));
  const localMap = new Map(localItems.map((item) => [item.id, item]));
  const remoteMap = new Map(remoteItems.map((item) => [item.id, item]));
  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);
  const result: { id: string }[] = [];

  allIds.forEach((id) => {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b && l && !r) { result.push(clone(l)); return; }       // 本地新增
    if (!b && !l && r) { result.push(clone(r)); return; }       // 远端新增
    if (!b && l && r) {                                          // 双方都新增了同 id
      if (same(l, r)) { result.push(clone(l)); return; }
      pushConflict(ctx, entry, 'item-add', arrayField, null, l, r, { itemId: id });
      result.push(clone(l));
      return;
    }
    if (b && l && !r) {                                          // 远端删除
      if (same(b, l)) return;                                    // 单侧删除：直接移除
      pushConflict(ctx, entry, 'item-removal', arrayField, b, l, null, { itemId: id });
      result.push(clone(l));                                     // 本地改了：默认保留
      return;
    }
    if (b && !l && r) {                                          // 本地删除
      if (same(b, r)) return;                                    // 单侧删除：直接移除
      pushConflict(ctx, entry, 'item-removal', arrayField, b, null, r, { itemId: id, resolution: 'remote' });
      result.push(clone(r));
      return;
    }
    if (b && !l && !r) return;                                   // 双方都删了
    if (b && l && r) {                                           // 三方都在：逐字段合并
      result.push(mergeItemFields(arrayField, b, l, r, entry, ctx));
    }
  });

  return result;
}

/** 合并一个词条的所有字段 */
function mergeEntryFields(
  base: DictionaryEntry,
  local: DictionaryEntry,
  remote: DictionaryEntry,
  ctx: MergeContext
): DictionaryEntry {
  const merged: DictionaryEntry = { ...clone(base) };
  const target = merged as unknown as Record<string, unknown>;

  ENTRY_SCALAR_FIELDS.forEach((field) => {
    const b = base[field];
    const l = local[field];
    const r = remote[field];

    if (same(l, b) && same(r, b)) return;
    if (!same(l, b) && same(r, b)) { target[field] = clone(l); ctx.autoMerged += 1; return; }
    if (same(l, b) && !same(r, b)) { target[field] = clone(r); ctx.autoMerged += 1; return; }
    if (same(l, r)) { target[field] = clone(l); ctx.autoMerged += 1; return; }
    pushConflict(ctx, local, 'scalar', field, b, l, r);
    target[field] = clone(l);
  });

  ENTRY_ARRAY_FIELDS.forEach((field) => {
    target[field] = mergeArrayField(field, base[field] as { id: string }[], local[field] as { id: string }[], remote[field] as { id: string }[], local, ctx);
  });

  return merged;
}

/**
 * 三方合并主入口
 * @param base   共同基线
 * @param local  当前工作区
 * @param remote 载入的备份
 */
export function threeWayMerge(
  base: DictionaryEntry[],
  local: DictionaryEntry[],
  remote: DictionaryEntry[]
): MergeResult {
  const baseMap = new Map(base.map((entry) => [entry.id, entry]));
  const localMap = new Map(local.map((entry) => [entry.id, entry]));
  const remoteMap = new Map(remote.map((entry) => [entry.id, entry]));
  const allIds = new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const ctx: MergeContext = { conflicts: [], autoMerged: 0 };
  const entries: DictionaryEntry[] = [];
  const addedEntryIds: string[] = [];
  const removedEntryIds: string[] = [];

  allIds.forEach((id) => {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (!b && l && !r) { entries.push(clone(l)); addedEntryIds.push(id); return; }
    if (!b && !l && r) { entries.push(clone(r)); addedEntryIds.push(id); return; }
    if (!b && l && r) {
      if (same(l, r)) { entries.push(clone(l)); addedEntryIds.push(id); return; }
      pushConflict(ctx, l, 'entry-add', '__entry__', null, l, r);
      entries.push(clone(l));
      return;
    }
    if (b && l && !r) {
      if (same(b, l)) { removedEntryIds.push(id); return; }
      pushConflict(ctx, l, 'entry-removal', '__entry__', b, l, null);
      entries.push(clone(l));
      return;
    }
    if (b && !l && r) {
      if (same(b, r)) { removedEntryIds.push(id); return; }
      pushConflict(ctx, r, 'entry-removal', '__entry__', b, null, r, { resolution: 'remote' });
      entries.push(clone(r));
      return;
    }
    if (b && !l && !r) { removedEntryIds.push(id); return; }
    if (b && l && r) {
      entries.push(mergeEntryFields(b, l, r, ctx));
    }
  });

  return { entries, conflicts: ctx.conflicts, addedEntryIds, removedEntryIds, autoMergedFields: ctx.autoMerged };
}

/** 将用户对冲突的选择应用到合并结果，返回最终词条 */
export function resolveMerge(
  result: MergeResult,
  resolutions: Record<string, ConflictResolution>
): DictionaryEntry[] {
  const entries = clone(result.entries);
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));

  result.conflicts.forEach((conflict) => {
    const resolution = resolutions[conflict.id] ?? conflict.resolution;
    const entry = entryMap.get(conflict.entryId);
    if (!entry) return;
    const target = entry as unknown as Record<string, unknown>;

    switch (conflict.kind) {
      case 'entry-removal': {
        if (resolution === 'remote') {
          const idx = entries.findIndex((item) => item.id === conflict.entryId);
          if (idx >= 0) entries.splice(idx, 1);
        }
        break;
      }
      case 'entry-add': {
        if (resolution === 'remote') {
          const idx = entries.findIndex((item) => item.id === conflict.entryId);
          if (idx >= 0) entries[idx] = clone(conflict.remoteValue as DictionaryEntry);
        }
        break;
      }
      case 'scalar': {
        if (resolution === 'remote') {
          target[conflict.field] = clone(conflict.remoteValue);
        } else if (resolution === 'combine') {
          const local = String(conflict.localValue ?? '');
          const remote = String(conflict.remoteValue ?? '');
          target[conflict.field] = local && remote ? `${local}；${remote}` : (local || remote);
        }
        break;
      }
      case 'item-removal': {
        if (resolution === 'remote') {
          const arr = target[conflict.field] as { id: string }[];
          const idx = arr.findIndex((item) => item.id === conflict.itemId);
          if (idx >= 0) arr.splice(idx, 1);
        }
        break;
      }
      case 'item-add': {
        if (resolution === 'remote') {
          const arr = target[conflict.field] as { id: string }[];
          const idx = arr.findIndex((item) => item.id === conflict.itemId);
          if (idx >= 0) arr[idx] = clone(conflict.remoteValue) as { id: string };
        }
        break;
      }
      case 'item-scalar': {
        const arr = target[conflict.field] as { id: string }[];
        const item = arr.find((item) => item.id === conflict.itemId) as Record<string, unknown> | undefined;
        if (item) {
          if (resolution === 'remote') {
            item[conflict.itemField!] = clone(conflict.remoteValue);
          } else if (resolution === 'combine') {
            const local = String(conflict.localValue ?? '');
            const remote = String(conflict.remoteValue ?? '');
            item[conflict.itemField!] = local && remote ? `${local}；${remote}` : (local || remote);
          }
        }
        break;
      }
    }
  });

  return entries;
}
