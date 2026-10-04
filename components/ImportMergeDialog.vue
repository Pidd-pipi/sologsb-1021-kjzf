<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';
import { COLLECTION_META, STATUS_LABELS, resolvePlan } from '~/utils/merge';
import type { DictionaryEntry, MergeConflict, MergePlan, MergeResolution } from '~/types/dictionary';

const visible = defineModel<boolean>({ required: true });
const emit = defineEmits<{ merged: [detail: string] }>();
const store = useDictionaryStore();

const fileInput = ref<HTMLInputElement | null>(null);
const fileName = ref('');
const plan = ref<MergePlan | null>(null);
const decisions = reactive<Record<string, MergeResolution>>({});
const parseError = ref('');
const applying = ref(false);

let pickedFile: File | null = null;

const reset = () => {
  fileName.value = '';
  plan.value = null;
  parseError.value = '';
  applying.value = false;
  pickedFile = null;
  Object.keys(decisions).forEach((key) => { delete decisions[key]; });
  if (fileInput.value) fileInput.value.value = '';
};

const close = () => { visible.value = false; };

const pickFile = () => fileInput.value?.click();

const readFile = (file: File) => {
  const reader = new FileReader();
  reader.onload = () => {
    parseError.value = '';
    // 预览阶段只做三方比较，不触碰工作区；失败时保留当前状态，可直接重新选择重试
    try {
      const next = store.previewImport(String(reader.result ?? ''));
      plan.value = next;
      Object.keys(decisions).forEach((key) => { delete decisions[key]; });
    } catch (error) {
      plan.value = null;
      parseError.value = error instanceof Error ? error.message : '备份解析失败';
    }
  };
  reader.onerror = () => { parseError.value = '文件读取失败，请重试或更换备份文件'; };
  reader.readAsText(file);
};

const onFileChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  pickedFile = file;
  fileName.value = file.name;
  readFile(file);
};

const retry = () => {
  parseError.value = '';
  if (pickedFile && fileName.value) readFile(pickedFile);
  else pickFile();
};

const baseSourceText = computed(() => {
  if (!plan.value) return '';
  if (plan.value.baseSource === 'package') return '共同基线取自备份导出时的工作区，比较结果最准确。';
  if (plan.value.baseSource === 'history') return '该备份未记录共同基线，已根据本地版本历史推断分叉点，合并前请留意冲突清单。';
  return '该备份未记录共同基线，版本历史中也找不到分叉点，已按空基线比较：新增内容照常并入，双方都改过的字段会逐项请你确认。';
});

const isPresence = (conflict: MergeConflict) => conflict.kind === 'presence' || conflict.kind === 'itemPresence';

const optionMeta = (conflict: MergeConflict): Array<{ value: MergeResolution; label: string }> => {
  if (isPresence(conflict)) {
    const survivor: 'ours' | 'theirs' | null = conflict.ours !== null ? 'ours' : conflict.theirs !== null ? 'theirs' : null;
    const survivorLabel = survivor === 'ours' ? '工作区' : survivor === 'theirs' ? '备份' : '对方';
    return [
      { value: 'keep', label: `保留${survivorLabel}中的版本` },
      { value: 'remove', label: '确认移除该条' }
    ];
  }
  return [
    { value: 'ours', label: '取工作区' },
    { value: 'theirs', label: '取备份' },
    ...(conflict.combinable ? [{ value: 'combine' as MergeResolution, label: '拼接双方' }] : [])
  ];
};

const groupedConflicts = computed(() => {
  if (!plan.value) return [];
  const groups = new Map<string, { entryId: string; headword: string; items: MergeConflict[] }>();
  plan.value.conflicts.forEach((conflict) => {
    let group = groups.get(conflict.entryId);
    if (!group) {
      group = { entryId: conflict.entryId, headword: conflict.entryHeadword, items: [] };
      groups.set(conflict.entryId, group);
    }
    group.items.push(conflict);
  });
  return [...groups.values()];
});

const pending = computed(() => plan.value?.conflicts.filter((conflict) => !decisions[conflict.key]) ?? []);

const liveStats = computed(() => {
  if (!plan.value) return null;
  // 非严格解析：未选择的冲突按默认值试算，统计会随逐项选择实时变化
  return resolvePlan(plan.value, decisions, false).stats;
});

const oursMap = computed(() => new Map((plan.value?.ours ?? []).map((entry) => [entry.id, entry])));
const baseMap = computed(() => new Map((plan.value?.base ?? []).map((entry) => [entry.id, entry])));

const autoAddedEntries = computed<DictionaryEntry[]>(() =>
  (plan.value?.theirs ?? []).filter((entry) => !oursMap.value.has(entry.id) && !baseMap.value.has(entry.id))
);

const autoRemovedEntries = computed<DictionaryEntry[]>(() => {
  if (!plan.value) return [];
  return plan.value.base.filter((baseEntry) => {
    const ours = oursMap.value.get(baseEntry.id);
    const theirs = plan.value!.theirs.find((entry) => entry.id === baseEntry.id);
    const oursDeletedTheirsUntouched = ours === undefined && theirs && JSON.stringify(theirs) === JSON.stringify(baseEntry);
    const theirsDeletedOursUntouched = theirs === undefined && ours && JSON.stringify(ours) === JSON.stringify(baseEntry);
    return oursDeletedTheirsUntouched || theirsDeletedOursUntouched;
  });
});

/** 字段冲突的“取某侧”对存在冲突意味着：该侧仍保留就保留，该侧已移除就移除 */
const sideDecision = (conflict: MergeConflict, side: 'ours' | 'theirs'): MergeResolution => {
  if (!isPresence(conflict)) return side;
  if (side === 'ours') return conflict.ours === null ? 'remove' : 'keep';
  return conflict.theirs === null ? 'remove' : 'keep';
};

const applySide = (side: 'ours' | 'theirs', entryId?: string) => {
  plan.value?.conflicts.forEach((conflict) => {
    if (entryId && conflict.entryId !== entryId) return;
    decisions[conflict.key] = sideDecision(conflict, side);
  });
};

const collectionOf = (conflict: MergeConflict) => conflict.key.split('#')[1] as keyof typeof COLLECTION_META | undefined;

const renderScalar = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '（空）';
  if (typeof value === 'string') return STATUS_LABELS[value] ?? value;
  return JSON.stringify(value);
};

const summarizeObject = (value: unknown, collection?: keyof typeof COLLECTION_META): string => {
  if (!value || typeof value !== 'object' || !collection) return '（已修改）';
  const obj = value as Record<string, unknown>;
  const meta = COLLECTION_META[collection];
  return meta.fields.map(([field, label]) => `${label}：${typeof obj[field] === 'string' && obj[field] ? obj[field] : '空'}`).join(' · ');
};

const fieldsOf = (conflict: MergeConflict): Array<[string, string]> => {
  const collection = collectionOf(conflict);
  return collection ? COLLECTION_META[collection].fields : [];
};

const choose = (conflict: MergeConflict, value: unknown) => {
  decisions[conflict.key] = value as MergeResolution;
};

const isEntryValue = (value: unknown): value is DictionaryEntry =>
  typeof value === 'object' && value !== null && 'headword' in value && 'dialectVariants' in value;

const confirm = () => {
  if (!plan.value || pending.value.length || applying.value) return;
  applying.value = true;
  try {
    const stats = store.applyImport(plan.value, decisions);
    const detail = `备份合入完成：新增 ${stats.entriesAdded}、移除 ${stats.entriesRemoved}、修改 ${stats.entriesChanged}，解决冲突 ${stats.conflicts} 处，可一次撤销`;
    reset();
    visible.value = false;
    emit('merged', detail);
  } catch (error) {
    // 落盘失败时工作区保持原样，选择不丢失，可修正后重试
    applying.value = false;
    parseError.value = error instanceof Error ? error.message : '合入失败，工作区未改动，可重试';
  }
};
</script>

<template>
  <t-dialog v-model:visible="visible" header="载入田野备份 · 三方合并" width="1040px" :footer="false" class="import-dialog" @close="reset">
    <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFileChange" />

    <!-- 选择文件 / 解析失败：原工作区未改动，可随时重试 -->
    <div v-if="!plan" class="import-pick">
      <t-alert v-if="parseError" theme="error" :title="`备份无法合入：${parseError}`">
        当前工作区没有被改动。请检查文件后重新选择，也可以先导出当前工作区留底再试。
      </t-alert>
      <div v-else class="pick-hint">
        <strong>先比较，再写入</strong>
        <p>载入时会把备份与「共同基线 + 当前工作区」做三方比较：双方各改不同字段会自动保留；同一字段、移除与修改撞车时逐项由你决定；新增和单侧移除直接合入；方言变体、例句、来源和审校意见都会保留。</p>
      </div>
      <div v-if="fileName" class="pick-file">已选择文件：<strong>{{ fileName }}</strong></div>
      <div class="dialog-actions">
        <t-button variant="outline" @click="close">取消</t-button>
        <t-button v-if="parseError" theme="warning" @click="retry">恢复并重试选择</t-button>
        <t-button theme="primary" @click="pickFile">选择备份文件</t-button>
      </div>
    </div>

    <div v-else class="import-plan">
      <div class="plan-head">
        <div>
          <span class="eyebrow">THREE-WAY MERGE</span>
          <h3>{{ fileName }}</h3>
          <p>{{ baseSourceText }}</p>
        </div>
        <t-button size="small" variant="outline" @click="pickFile">换一个文件</t-button>
      </div>

      <t-alert v-if="parseError" theme="error" :title="parseError" class="plan-alert" />

      <div class="plan-stats">
        <div><strong>{{ liveStats?.entriesAdded ?? 0 }}</strong><span>自动新增词条</span></div>
        <div><strong>{{ liveStats?.entriesRemoved ?? 0 }}</strong><span>移除词条</span></div>
        <div><strong>{{ liveStats?.entriesChanged ?? 0 }}</strong><span>合并修改词条</span></div>
        <div><strong>{{ liveStats?.itemsAdded ?? 0 }}</strong><span>自动并入子项</span></div>
        <div :class="{ pending: pending.length }"><strong>{{ pending.length }} / {{ plan.conflicts.length }}</strong><span>待逐项选择</span></div>
      </div>

      <div class="auto-zones">
        <div class="auto-zone">
          <strong>直接合入的新增</strong>
          <span v-if="!autoAddedEntries.length">没有仅存在于备份的新词条</span>
          <ul v-else><li v-for="entry in autoAddedEntries" :key="entry.id">{{ entry.headword }} <small>{{ entry.dialectVariants.length }} 方言 · {{ entry.examples.length }} 例句 · {{ entry.sources.length }} 来源 · {{ entry.reviewerComments.length }} 意见</small></li></ul>
        </div>
        <div class="auto-zone">
          <strong>单侧移除（直接合入）</strong>
          <span v-if="!autoRemovedEntries.length">没有单侧确认移除的词条</span>
          <ul v-else><li v-for="entry in autoRemovedEntries" :key="entry.id">{{ entry.headword }} <small>另一侧未改动，随其移除</small></li></ul>
        </div>
      </div>

      <div v-if="plan.conflicts.length" class="conflict-toolbar">
        <div><strong>逐项选择冲突</strong><span>同一字段双方都改、或移除与修改撞车时，必须逐条决定后才能写入；可按词条或整包快速选择。</span></div>
        <div class="bulk-actions">
          <t-button size="small" variant="outline" @click="applySide('ours')">全部取工作区 / 保留</t-button>
          <t-button size="small" variant="outline" @click="applySide('theirs')">全部取备份 / 跟随移除</t-button>
        </div>
      </div>

      <div class="conflict-scroll">
        <section v-for="group in groupedConflicts" :key="group.entryId" class="conflict-group">
          <header>
            <strong>{{ group.headword }}</strong>
            <span>{{ group.items.filter((item) => !decisions[item.key]).length }} 项待选 / 共 {{ group.items.length }} 项</span>
            <div class="group-bulk">
              <button @click="applySide('ours', group.entryId)">本词条取工作区</button>
              <button @click="applySide('theirs', group.entryId)">本词条取备份</button>
            </div>
          </header>

          <article v-for="conflict in group.items" :key="conflict.key" class="conflict-item" :class="{ unresolved: !decisions[conflict.key] }">
            <div class="conflict-title">
              <strong>{{ conflict.label }}</strong>
              <small v-if="!decisions[conflict.key]" class="pending-flag">待选择</small>
              <small v-else class="chosen-flag">已选择</small>
            </div>
            <div class="conflict-sides">
              <div class="side ours" :class="{ chosen: decisions[conflict.key] === 'ours' || (isPresence(conflict) && decisions[conflict.key] === 'keep' && conflict.ours !== null) }">
                <span>工作区</span>
                <template v-if="isEntryValue(conflict.ours)">
                  <strong>{{ conflict.ours.headword }}</strong>
                  <p>{{ conflict.ours.definition || '（无释义）' }}</p>
                  <small>{{ conflict.ours.dialectVariants.length }} 方言 · {{ conflict.ours.examples.length }} 例句 · {{ conflict.ours.sources.length }} 来源 · {{ conflict.ours.reviewerComments.length }} 意见</small>
                </template>
                <template v-else-if="conflict.ours && typeof conflict.ours === 'object'">
                  <p v-for="([field, label]) in fieldsOf(conflict)" :key="field">
                    <em>{{ label }}</em>{{ renderScalar((conflict.ours as Record<string, unknown>)[field]) }}
                  </p>
                </template>
                <template v-else><p>{{ renderScalar(conflict.ours) }}</p></template>
              </div>
              <div class="side theirs" :class="{ chosen: decisions[conflict.key] === 'theirs' || (isPresence(conflict) && decisions[conflict.key] === 'keep' && conflict.ours === null) }">
                <span>备份</span>
                <template v-if="isEntryValue(conflict.theirs)">
                  <strong>{{ conflict.theirs.headword }}</strong>
                  <p>{{ conflict.theirs.definition || '（无释义）' }}</p>
                  <small>{{ conflict.theirs.dialectVariants.length }} 方言 · {{ conflict.theirs.examples.length }} 例句 · {{ conflict.theirs.sources.length }} 来源 · {{ conflict.theirs.reviewerComments.length }} 意见</small>
                </template>
                <template v-else-if="conflict.theirs && typeof conflict.theirs === 'object'">
                  <p v-for="([field, label]) in fieldsOf(conflict)" :key="field">
                    <em>{{ label }}</em>{{ renderScalar((conflict.theirs as Record<string, unknown>)[field]) }}
                  </p>
                </template>
                <template v-else><p>{{ renderScalar(conflict.theirs) }}</p></template>
              </div>
            </div>
            <div class="conflict-base">共同基线：{{ isEntryValue(conflict.base) ? `${conflict.base.headword} · ${conflict.base.definition || '（无释义）'}` : conflict.base && typeof conflict.base === 'object' ? summarizeObject(conflict.base, collectionOf(conflict)) : renderScalar(conflict.base) }}</div>
            <t-radio-group :model-value="decisions[conflict.key]" variant="default" size="small" @change="(value) => choose(conflict, value)">
              <t-radio-button v-for="option in optionMeta(conflict)" :key="option.value" :value="option.value">{{ option.label }}</t-radio-button>
            </t-radio-group>
          </article>
        </section>
        <t-empty v-if="!groupedConflicts.length" description="没有冲突：双方修改互不重叠，可直接合入" />
      </div>

      <div class="merge-warning"><strong>只记一个可撤销版本</strong><span>合入成功后，本次所有新增、移除和逐项选择合并为一条版本记录，按一次撤销即可整体回到合入前；若写入失败，工作区保持原样并可以重试。</span></div>
      <div class="dialog-actions">
        <t-button variant="outline" @click="close">取消</t-button>
        <t-button theme="primary" :disabled="pending.length > 0" :loading="applying" @click="confirm">
          {{ pending.length ? `还有 ${pending.length} 项待选择` : '确认合入工作区' }}
        </t-button>
      </div>
    </div>
  </t-dialog>
</template>

<style scoped>
.import-pick { display: flex; flex-direction: column; gap: 14px; padding: 6px 2px 2px; }
.pick-hint { padding: 14px; border: 1px solid #d6e0dc; border-radius: 9px; background: #f5f8f6; }
.pick-hint strong { font-family: "Songti SC", serif; font-size: 16px; color: var(--forest); }
.pick-hint p { margin: 7px 0 0; color: var(--muted); font-size: 11px; line-height: 1.7; }
.pick-file { font-size: 11px; color: var(--muted); }
.pick-file strong { color: var(--ink); }
.import-plan { display: flex; flex-direction: column; gap: 12px; }
.plan-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.plan-head h3 { margin: 4px 0 2px; font-family: "Songti SC", serif; font-size: 18px; }
.plan-head p { margin: 0; color: var(--muted); font-size: 10px; }
.plan-alert { flex: none; }
.plan-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.plan-stats div { padding: 10px 6px; text-align: center; border-radius: 8px; background: #eef4f1; }
.plan-stats strong { display: block; font-family: "Songti SC", serif; font-size: 21px; color: var(--forest); }
.plan-stats span { font-size: 9px; color: var(--muted); }
.plan-stats div.pending strong { color: var(--ochre); }
.auto-zones { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.auto-zone { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border: 1px solid #dce4e0; border-radius: 8px; background: #fafbf9; }
.auto-zone > strong { font-size: 10px; color: var(--forest); }
.auto-zone > span { font-size: 9px; color: #95a19c; }
.auto-zone ul { margin: 2px 0 0; padding-left: 16px; max-height: 92px; overflow-y: auto; }
.auto-zone li { font-size: 10px; line-height: 1.7; }
.auto-zone li small { color: var(--muted); margin-left: 4px; }
.conflict-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 8px; background: #fbf0de; }
.conflict-toolbar strong { font-size: 11px; color: #77552d; }
.conflict-toolbar span { display: block; margin-top: 2px; font-size: 9px; color: #947448; }
.bulk-actions { display: flex; gap: 6px; flex: none; }
.conflict-scroll { max-height: 46vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding-right: 4px; }
.conflict-group { border: 1px solid #dce4e0; border-radius: 9px; overflow: hidden; }
.conflict-group > header { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: #eef4f1; font-size: 11px; }
.conflict-group > header > strong { font-family: "Songti SC", serif; font-size: 14px; color: var(--forest); }
.conflict-group > header > span { color: var(--muted); font-size: 9px; }
.group-bulk { margin-left: auto; display: flex; gap: 4px; }
.group-bulk button { border: 1px solid #c5d4ce; border-radius: 5px; padding: 3px 8px; color: #3f6b5e; background: white; font-size: 9px; cursor: pointer; }
.group-bulk button:hover { border-color: var(--forest); }
.conflict-item { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-top: 1px solid #e6ece9; }
.conflict-item.unresolved { background: #fffaf5; }
.conflict-title { display: flex; align-items: center; gap: 8px; }
.conflict-title strong { font-size: 11px; }
.pending-flag { color: var(--ochre); font-size: 9px; font-weight: 700; }
.chosen-flag { color: var(--forest); font-size: 9px; }
.conflict-sides { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.side { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px; border: 1px solid #e0e6e3; border-radius: 7px; background: white; }
.side span { font-size: 8px; font-weight: 800; letter-spacing: .12em; color: #8a9893; }
.side strong { font-family: "Songti SC", serif; font-size: 14px; }
.side p { margin: 0; font-size: 10px; line-height: 1.55; word-break: break-word; }
.side p em { display: inline-block; margin-right: 5px; color: #8a9893; font-style: normal; font-size: 9px; }
.side small { color: var(--muted); font-size: 8px; }
.side.ours.chosen { border-color: #4b8778; box-shadow: inset 3px 0 0 var(--forest); background: #f2f8f5; }
.side.theirs.chosen { border-color: #b4773f; box-shadow: inset 3px 0 0 var(--ochre); background: #fdf8f1; }
.conflict-base { font-size: 9px; color: #8a9893; }
</style>
