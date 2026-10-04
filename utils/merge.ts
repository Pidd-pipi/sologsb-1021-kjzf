import type {
  AuditRecord, BackupPackage, BaseSource, DictionaryEntry, MergeConflict, MergePlan, MergeResolution,
  MergeSide, MergeStats, ReviewComment, VersionRecord
} from '~/types/dictionary';

export const STATUS_LABELS: Record<string, string> = {
  draft: '草稿', review: '待审', disputed: '争议', confirmed: '已确认', open: '待处理', resolved: '已解决'
};

export const FIELD_LABELS: Record<string, string> = {
  headword: '词形', pronunciation: '发音', partOfSpeech: '词性', definition: '释义',
  notes: '编者备注', status: '状态', synonyms: '同义词', createdAt: '创建时间', updatedAt: '更新时间'
};

type CollectionKey = 'dialectVariants' | 'examples' | 'sources' | 'reviewerComments';

interface CollectionMeta {
  label: string;
  fields: Array<[string, string]>;
  statusField?: string;
  combinable: Set<string>;
}

export const COLLECTION_META: Record<CollectionKey, CollectionMeta> = {
  dialectVariants: {
    label: '方言变体',
    fields: [['dialect', '方言点'], ['form', '词形'], ['pronunciation', '读音'], ['note', '使用说明']],
    combinable: new Set(['note'])
  },
  examples: {
    label: '例句',
    fields: [['text', '原文'], ['translation', '译文'], ['source', '出处']],
    combinable: new Set(['text', 'translation', 'source'])
  },
  sources: {
    label: '来源',
    fields: [['title', '来源名称'], ['citation', '引用信息'], ['url', '链接']],
    combinable: new Set(['title', 'citation'])
  },
  reviewerComments: {
    label: '审校意见',
    fields: [['field', '绑定字段'], ['author', '作者'], ['message', '意见内容'], ['status', '处理状态']],
    statusField: 'status',
    combinable: new Set(['message'])
  }
};

const COLLECTION_ORDER: CollectionKey[] = ['dialectVariants', 'examples', 'sources', 'reviewerComments'];

const SCALAR_FIELDS = ['headword', 'pronunciation', 'partOfSpeech', 'definition', 'notes'] as const;
/** 允许“拼接”的长文本字段；词性、状态、绑定字段等值域固定，只能二选一 */
const COMBINABLE_ENTRY_FIELDS = new Set<string>(['headword', 'pronunciation', 'definition', 'notes']);

type Json = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === 'string';
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)) as T);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** 审校意见回复按并集追加、双方都删除才移除，回复本身不产生字段冲突 */
function mergeReplies(ours: ReviewComment['replies'], theirs: ReviewComment['replies'], base: ReviewComment['replies'] = []) {
  const result: ReviewComment['replies'] = [];
  const push = (reply: ReviewComment['replies'][number]) => { if (!result.some((item) => item.id === reply.id)) result.push(reply); };
  [...base, ...ours, ...theirs].forEach((reply) => {
    const inBase = base.some((item) => item.id === reply.id);
    const inOurs = ours.some((item) => item.id === reply.id);
    const inTheirs = theirs.some((item) => item.id === reply.id);
    if (inBase) {
      // 两侧都删除才移除；任一侧保留即留下（有修改时优先取工作区文本）
      if (inOurs || inTheirs) push(ours.find((item) => item.id === reply.id) ?? theirs.find((item) => item.id === reply.id)!);
    } else if (inOurs || inTheirs) {
      push(ours.find((item) => item.id === reply.id) ?? theirs.find((item) => item.id === reply.id)!);
    }
  });
  return result;
}

/** 兼容旧版备份：缺少的字段补默认值，类型不对则明确报错，保证失败时不破坏工作区 */
function normalizeEntry(raw: unknown, index: number): DictionaryEntry {
  if (typeof raw !== 'object' || raw === null) throw new Error(`第 ${index + 1} 个词条不是有效对象`);
  const obj = raw as Json;
  if (!isString(obj.id) || !obj.id.trim()) throw new Error(`第 ${index + 1} 个词条缺少 id`);
  const requireString = (value: unknown, name: string): string => {
    if (value === undefined || value === null) return '';
    if (!isString(value)) throw new Error(`词条 ${obj.id} 的 ${name} 不是文本`);
    return value;
  };
  const fallbackId = (kind: string) => `${kind}-import-${index}-${Math.random().toString(36).slice(2, 8)}`;
  const statuses = ['draft', 'review', 'disputed', 'confirmed'];
  const status = isString(obj.status) && statuses.includes(obj.status) ? obj.status as DictionaryEntry['status'] : 'draft';
  const normalizeItem = <T>(value: unknown, name: string, build: (data: Json, i: number) => T): T[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`词条 ${obj.id} 的 ${name} 不是数组`);
    return value.map((item, i) => {
      if (typeof item !== 'object' || item === null) throw new Error(`词条 ${obj.id} 的 ${name} 第 ${i + 1} 项不是对象`);
      return build(item as Json, i);
    });
  };
  return {
    id: obj.id,
    headword: requireString(obj.headword, '词形'),
    pronunciation: requireString(obj.pronunciation, '发音'),
    partOfSpeech: requireString(obj.partOfSpeech, '词性'),
    definition: requireString(obj.definition, '释义'),
    notes: requireString(obj.notes, '备注'),
    dialectVariants: normalizeItem(obj.dialectVariants, '方言变体', (data) => ({
      id: requireString(data.id, '变体 id') || fallbackId('variant'),
      dialect: requireString(data.dialect, '方言点'), form: requireString(data.form, '词形'),
      pronunciation: requireString(data.pronunciation, '读音'), note: requireString(data.note, '说明')
    })),
    examples: normalizeItem(obj.examples, '例句', (data) => ({
      id: requireString(data.id, '例句 id') || fallbackId('example'),
      text: requireString(data.text, '原文'), translation: requireString(data.translation, '译文'), source: requireString(data.source, '出处')
    })),
    sources: normalizeItem(obj.sources, '来源', (data) => ({
      id: requireString(data.id, '来源 id') || fallbackId('source'),
      title: requireString(data.title, '名称'), citation: requireString(data.citation, '引用'), url: requireString(data.url, '链接')
    })),
    synonyms: Array.isArray(obj.synonyms) ? obj.synonyms.map((item) => {
      if (!isString(item)) throw new Error(`词条 ${obj.id} 的同义词包含非文本项`);
      return item;
    }) : [],
    status,
    createdAt: requireString(obj.createdAt, '创建时间') || new Date().toISOString(),
    updatedAt: requireString(obj.updatedAt, '更新时间') || new Date().toISOString(),
    reviewerComments: normalizeItem(obj.reviewerComments, '审校意见', (data) => ({
      id: requireString(data.id, '意见 id') || fallbackId('comment'),
      field: requireString(data.field, '绑定字段'), author: requireString(data.author, '作者'),
      message: requireString(data.message, '内容'),
      status: (data.status === 'resolved' ? 'resolved' : 'open') as ReviewComment['status'],
      createdAt: requireString(data.createdAt, '时间') || new Date().toISOString(),
      replies: normalizeItem(data.replies, '回复', (reply) => ({
        id: requireString(reply.id, '回复 id') || fallbackId('reply'),
        author: requireString(reply.author, '作者'), message: requireString(reply.message, '内容'),
        createdAt: requireString(reply.createdAt, '时间') || new Date().toISOString()
      }))
    }))
  };
}

export function parseBackup(raw: unknown): BackupPackage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('备份不是有效的 JSON 对象');
  const obj = raw as Json;
  if (!Array.isArray(obj.entries)) throw new Error('备份中缺少 entries 词条数组，可能不是本工具导出的备份文件');
  const entries = obj.entries.map((entry, index) => normalizeEntry(entry, index));
  const normalizeHistory = <T extends { id: string }>(value: unknown, name: string): T[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`备份中的 ${name} 不是数组`);
    return value.filter((item): item is T => typeof item === 'object' && item !== null && isString((item as Json).id));
  };
  return {
    revision: typeof obj.revision === 'number' ? obj.revision : 1,
    entries,
    versions: normalizeHistory<VersionRecord>(obj.versions, '版本记录'),
    audit: normalizeHistory<AuditRecord>(obj.audit, '审计记录'),
    syncBase: Array.isArray(obj.syncBase) ? obj.syncBase.map((entry, index) => normalizeEntry(entry, index)) : undefined,
    exportedAt: isString(obj.exportedAt) ? obj.exportedAt : undefined
  };
}

/** 子项的人类可读摘要，用于冲突列表里定位“是哪一条变体 / 例句 / 来源 / 意见” */
export function summarizeItem(collection: CollectionKey, item: Record<string, unknown> | undefined | null): string {
  if (!item) return '（已移除）';
  const text = (value: unknown) => (isString(value) && value.trim() ? value : '未命名');
  if (collection === 'dialectVariants') return `${text(item.dialect)} · ${text(item.form)}`;
  if (collection === 'examples') return text(item.text);
  if (collection === 'sources') return text(item.title);
  return `${text(item.field)}：${text(item.message)}`;
}

/**
 * 旧版备份没有共同基线时，从本地版本历史中找分叉点：
 * 与备份共享且内容完全一致的词条越多、分歧越少，越接近田野组带走时的基线。
 * 只参考历史快照（提交前状态），绝不把当前工作区当基线，避免本地修改被静默覆盖。
 */
export function inferBaseEntries(theirs: DictionaryEntry[], versionBases: DictionaryEntry[][]): { base: DictionaryEntry[]; source: BaseSource } {
  const theirsMap = new Map(theirs.map((entry) => [entry.id, entry]));
  const bestRef: { current: { entries: DictionaryEntry[]; matches: number; mismatches: number } | null } = { current: null };
  versionBases.forEach((entries) => {
    let matches = 0;
    let mismatches = 0;
    entries.forEach((entry) => {
      const incoming = theirsMap.get(entry.id);
      if (!incoming) return;
      if (same(entry, incoming)) matches += 1;
      else mismatches += 1;
    });
    if (matches <= 0) return;
    const best = bestRef.current;
    if (!best || matches > best.matches || (matches === best.matches && mismatches < best.mismatches)) {
      bestRef.current = { entries, matches, mismatches };
    }
  });
  return bestRef.current ? { base: bestRef.current.entries, source: 'history' } : { base: [], source: 'empty' };
}

type ConflictResolver = (conflict: Omit<MergeConflict, 'resolution'>) => MergeResolution;

interface MergeContext {
  conflicts: MergeConflict[];
  resolve: ConflictResolver;
  itemsAdded: number;
}

const combineText = (ours: unknown, theirs: unknown): string =>
  [ours, theirs].filter((value) => isString(value) && value.trim()).join('；');

function mergeScalar(
  ours: unknown, theirs: unknown, base: unknown,
  conflict: Omit<MergeConflict, 'ours' | 'theirs' | 'base' | 'options' | 'combinable'>,
  ctx: MergeContext, combinable: boolean, isStatus = false
) {
  if (same(ours, theirs)) return ours;
  if (same(base, ours)) return theirs;
  if (same(base, theirs)) return ours;
  const options: MergeResolution[] = isStatus
    ? ['ours', 'theirs']
    : combinable ? ['ours', 'theirs', 'combine'] : ['ours', 'theirs'];
  const resolution = ctx.resolve({ ...conflict, ours, theirs, base, options, combinable: !isStatus && combinable });
  if (resolution === 'theirs') return theirs;
  if (resolution === 'combine' && combinable) return combineText(ours, theirs);
  return ours;
}

/** 同义词按三方集合合并：单侧新增直接并入，单侧删除传播，双方分歧不产生碎片冲突 */
function mergeSynonyms(ours: string[], theirs: string[], base: string[]) {
  const result: string[] = [];
  const push = (word: string) => { if (!result.includes(word)) result.push(word); };
  [...base, ...ours, ...theirs].forEach((word) => {
    const inBase = base.includes(word);
    const inOurs = ours.includes(word);
    const inTheirs = theirs.includes(word);
    if (inBase) { if (inOurs && inTheirs) push(word); }
    else if (inOurs || inTheirs) push(word);
  });
  return result;
}

function mergeCollection(
  entryId: string, headword: string, collection: CollectionKey,
  oursItems: Json[], theirsItems: Json[], baseItems: Json[], ctx: MergeContext
): Json[] {
  const meta = COLLECTION_META[collection];
  const byId = (items: Json[]) => new Map(items.map((item) => [String(item.id), item]));
  const oursMap = byId(oursItems);
  const theirsMap = byId(theirsItems);
  const baseMap = byId(baseItems);
  const merged = new Map<string, Json>();

  const mergeItemFields = (itemId: string, label: string, oursItem: Json, theirsItem: Json, baseItem?: Json): Json => {
    // 以字段较多的一侧为底稿，保证非冲突字段（如 id、createdAt）不丢失
    const mergedItem: Json = clone(Object.keys(theirsItem).length > Object.keys(oursItem).length ? theirsItem : oursItem);
    mergedItem.id = itemId;
    meta.fields.forEach(([field, fieldLabel]) => {
      const isStatus = meta.statusField === field;
      mergedItem[field] = mergeScalar(
        oursItem[field], theirsItem[field], baseItem?.[field],
        {
          key: `${entryId}#${collection}#${itemId}#${field}`,
          kind: 'itemField', entryId, entryHeadword: headword,
          label: `${meta.label}「${label}」· ${fieldLabel}`
        },
        ctx, meta.combinable.has(field), isStatus
      );
    });
    if (collection === 'reviewerComments') {
      mergedItem.createdAt = !oursItem.createdAt ? theirsItem.createdAt
        : !theirsItem.createdAt ? oursItem.createdAt
        : String(oursItem.createdAt) <= String(theirsItem.createdAt) ? oursItem.createdAt : theirsItem.createdAt;
      mergedItem.replies = mergeReplies(
        asArray(oursItem.replies) as ReviewComment['replies'],
        asArray(theirsItem.replies) as ReviewComment['replies'],
        asArray(baseItem?.replies) as ReviewComment['replies']
      );
    }
    return mergedItem;
  };

  const order: string[] = [];
  [...baseItems, ...oursItems, ...theirsItems].forEach((item) => {
    const id = String(item.id);
    if (!order.includes(id)) order.push(id);
  });

  order.forEach((itemId) => {
    const oursItem = oursMap.get(itemId);
    const theirsItem = theirsMap.get(itemId);
    const baseItem = baseMap.get(itemId);

    if (!baseItem) {
      // 基线没有：单侧新增直接合入；双方各自新增同 id 子项时逐字段三方比较
      if (oursItem && theirsItem) {
        merged.set(itemId, mergeItemFields(itemId, summarizeItem(collection, oursItem), oursItem, theirsItem));
      } else {
        merged.set(itemId, clone((oursItem ?? theirsItem)!));
        ctx.itemsAdded += 1;
      }
      return;
    }
    if (oursItem && theirsItem) {
      if (same(oursItem, theirsItem)) { merged.set(itemId, clone(oursItem)); return; }
      if (same(baseItem, oursItem)) { merged.set(itemId, clone(theirsItem)); return; }
      if (same(baseItem, theirsItem)) { merged.set(itemId, clone(oursItem)); return; }
      merged.set(itemId, mergeItemFields(itemId, summarizeItem(collection, oursItem), oursItem, theirsItem, baseItem));
      return;
    }
    // 基线有、仅一侧保留：另一侧未改动则直接移除；移除与修改冲突时逐项选择
    const survivor = oursItem ?? theirsItem!;
    if (same(baseItem, survivor)) return;
    const resolution = ctx.resolve({
      key: `${entryId}#${collection}#${itemId}`,
      kind: 'itemPresence', entryId, entryHeadword: headword,
      label: `${meta.label}「${summarizeItem(collection, survivor)}」`,
      ours: oursItem ?? null, theirs: theirsItem ?? null, base: baseItem,
      options: ['keep', 'remove'], combinable: false
    });
    if (resolution === 'keep') merged.set(itemId, clone(survivor));
  });

  return [...merged.values()];
}

function mergeEntry(
  entryId: string, ours: DictionaryEntry | undefined, theirs: DictionaryEntry | undefined,
  base: DictionaryEntry | undefined, ctx: MergeContext
): DictionaryEntry | null {
  const headword = ours?.headword || theirs?.headword || base?.headword || '未命名词条';

  // 词条级存在冲突：一侧移除、另一侧修改时逐项选择；未改的一侧移除直接合入
  const presenceConflict = (side: MergeSide): DictionaryEntry | null => {
    const survivor = side === 'theirs' ? theirs : ours;
    const resolution = ctx.resolve({
      key: `${entryId}#presence`, kind: 'presence', entryId, entryHeadword: headword,
      label: `词条「${headword}」`,
      ours: ours ?? null, theirs: theirs ?? null, base: base ?? null,
      options: ['keep', 'remove'], combinable: false
    });
    return resolution === 'keep' ? clone(survivor!) : null;
  };

  if (base) {
    if (ours && !theirs) return same(base, ours) ? null : presenceConflict('ours');
    if (!ours && theirs) return same(base, theirs) ? null : presenceConflict('theirs');
  } else if (!ours) { return theirs ? clone(theirs) : null; }
  else if (!theirs) return clone(ours);

  if (!ours || !theirs) return null;
  if (same(ours, theirs)) return clone(ours);

  // 双方都新增（基线无此条）时，缺失侧按空值参与逐字段比较
  const baseRef = base as DictionaryEntry | undefined;
  const merged: DictionaryEntry = clone(ours);
  SCALAR_FIELDS.forEach((field) => {
    merged[field] = mergeScalar(ours[field], theirs[field], baseRef?.[field] ?? '', {
      key: `${entryId}#${field}`, kind: 'field', entryId, entryHeadword: headword, label: FIELD_LABELS[field]
    }, ctx, COMBINABLE_ENTRY_FIELDS.has(field)) as string;
  });
  merged.status = mergeScalar(ours.status, theirs.status, baseRef?.status ?? '', {
    key: `${entryId}#status`, kind: 'field', entryId, entryHeadword: headword, label: FIELD_LABELS.status
  }, ctx, false, true) as DictionaryEntry['status'];
  merged.synonyms = mergeSynonyms(ours.synonyms, theirs.synonyms, baseRef?.synonyms ?? []);
  COLLECTION_ORDER.forEach((collection) => {
    (merged as unknown as Json)[collection] = mergeCollection(
      entryId, headword, collection,
      ours[collection] as unknown as Json[], theirs[collection] as unknown as Json[],
      (baseRef?.[collection] ?? []) as unknown as Json[], ctx
    );
  });
  merged.createdAt = !ours.createdAt ? theirs.createdAt
    : !theirs.createdAt ? ours.createdAt
    : ours.createdAt <= theirs.createdAt ? ours.createdAt : theirs.createdAt;
  merged.updatedAt = !ours.updatedAt ? theirs.updatedAt
    : !theirs.updatedAt ? ours.updatedAt
    : ours.updatedAt >= theirs.updatedAt ? ours.updatedAt : theirs.updatedAt;
  return merged;
}

function runMerge(
  baseEntries: DictionaryEntry[], oursEntries: DictionaryEntry[], theirsEntries: DictionaryEntry[], resolver: ConflictResolver
) {
  const ctx: MergeContext = { conflicts: [], resolve: resolver, itemsAdded: 0 };
  const baseMap = new Map(baseEntries.map((entry) => [entry.id, entry]));
  const oursMap = new Map(oursEntries.map((entry) => [entry.id, entry]));
  const theirsMap = new Map(theirsEntries.map((entry) => [entry.id, entry]));

  const order: string[] = [];
  [...baseEntries, ...oursEntries, ...theirsEntries].forEach((entry) => {
    if (!order.includes(entry.id)) order.push(entry.id);
  });

  const result = new Map<string, DictionaryEntry>();
  order.forEach((entryId) => {
    const merged = mergeEntry(entryId, oursMap.get(entryId), theirsMap.get(entryId), baseMap.get(entryId), ctx);
    if (merged) result.set(entryId, merged);
  });
  return { entries: [...result.values()], conflicts: ctx.conflicts, itemsAdded: ctx.itemsAdded };
}

/** 规划阶段只收集冲突清单，冲突集合在任意选择下保持稳定（各冲突互相独立） */
export function createMergePlan(ours: DictionaryEntry[], pkg: BackupPackage, versionBases: DictionaryEntry[][]): MergePlan {
  const oursClone = clone(ours);
  const theirs = clone(pkg.entries);
  const inferred = pkg.syncBase
    ? { base: clone(pkg.syncBase), source: 'package' as BaseSource }
    : inferBaseEntries(theirs, versionBases.map(clone));

  const collected: Omit<MergeConflict, 'resolution'>[] = [];
  const { itemsAdded } = runMerge(inferred.base, oursClone, theirs, (conflict) => {
    collected.push(conflict);
    return conflict.kind === 'presence' || conflict.kind === 'itemPresence' ? 'keep' : 'ours';
  });
  const conflicts = collected as MergeConflict[];

  return {
    base: inferred.base,
    baseSource: inferred.source,
    ours: oursClone,
    theirs,
    conflicts,
    stats: { entriesAdded: 0, entriesRemoved: 0, entriesChanged: 0, itemsAdded, conflicts: conflicts.length },
    incomingRevision: pkg.revision ?? 1,
    exportedAt: pkg.exportedAt
  };
}

const isPresenceConflict = (conflict: MergeConflict) => conflict.kind === 'presence' || conflict.kind === 'itemPresence';
const defaultDecision = (conflict: MergeConflict): MergeResolution => isPresenceConflict(conflict) ? 'keep' : 'ours';

export interface ResolvedMerge {
  entries: DictionaryEntry[];
  stats: MergeStats;
  touched: Set<string>;
}

/** 按逐项选择落盘；strict 模式下任何未决冲突都抛出，保证不会半选择地写入 */
export function resolvePlan(plan: MergePlan, decisions: Record<string, MergeResolution | undefined>, strict = false): ResolvedMerge {
  if (strict) {
    const pending = plan.conflicts.filter((conflict) => !conflict.resolution && !decisions[conflict.key]);
    if (pending.length) throw new Error(`还有 ${pending.length} 个冲突尚未逐项选择`);
  }
  const choice = (conflict: Omit<MergeConflict, 'resolution'>): MergeResolution => {
    const picked = decisions[conflict.key];
    if (picked && conflict.options.includes(picked)) return picked;
    if (strict) throw new Error(`冲突「${conflict.label}」的选择无效`);
    return defaultDecision(conflict);
  };

  const { entries, itemsAdded } = runMerge(clone(plan.base), clone(plan.ours), clone(plan.theirs), choice);
  const oursMap = new Map(plan.ours.map((entry) => [entry.id, entry]));
  const resultMap = new Map(entries.map((entry) => [entry.id, entry]));
  const touched = new Set<string>();
  let entriesAdded = 0;
  let entriesRemoved = 0;
  let entriesChanged = 0;
  entries.forEach((entry) => {
    const before = oursMap.get(entry.id);
    if (!before) { entriesAdded += 1; touched.add(entry.id); }
    else if (!same(before, entry)) { entriesChanged += 1; touched.add(entry.id); }
  });
  plan.ours.forEach((entry) => {
    if (!resultMap.has(entry.id)) { entriesRemoved += 1; touched.add(entry.id); }
  });
  return {
    entries,
    touched,
    stats: { entriesAdded, entriesRemoved, entriesChanged, itemsAdded, conflicts: plan.conflicts.length }
  };
}
