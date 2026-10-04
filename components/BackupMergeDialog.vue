<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useDictionaryStore } from '~/store/dictionary';
import type { ConflictResolution, FieldConflict } from '~/utils/merge';

const visible = defineModel<boolean>({ required: true });
const store = useDictionaryStore();

const resolutions = reactive<Record<string, ConflictResolution>>({});

const result = computed(() => store.mergeSession.result);
const conflicts = computed<FieldConflict[]>(() => result.value?.conflicts ?? []);

interface ConflictGroup {
  entryId: string;
  entryHeadword: string;
  items: FieldConflict[];
}

const groupedConflicts = computed<ConflictGroup[]>(() => {
  const map = new Map<string, ConflictGroup>();
  conflicts.value.forEach((conflict) => {
    let group = map.get(conflict.entryId);
    if (!group) {
      group = { entryId: conflict.entryId, entryHeadword: conflict.entryHeadword, items: [] };
      map.set(conflict.entryId, group);
    }
    group.items.push(conflict);
  });
  return [...map.values()];
});

watch(visible, (open) => {
  if (!open) return;
  // 默认全部保留本地，用户可逐项改为远端或拼接
  Object.keys(resolutions).forEach((key) => delete resolutions[key]);
  conflicts.value.forEach((conflict) => {
    resolutions[conflict.id] = conflict.resolution;
  });
});

const isCombinable = (value: unknown): boolean => typeof value === 'string';

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value || '—';
  if (Array.isArray(value)) return value.length ? `[${value.length} 项]` : '—';
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return String(obj.headword ?? obj.form ?? obj.title ?? obj.message ?? JSON.stringify(value).slice(0, 40));
  }
  return String(value);
};

const conflictTitle = (conflict: FieldConflict): string => {
  if (conflict.field === '__entry__') return '整个词条';
  if (conflict.itemField) return `${conflict.fieldLabel} · ${conflict.itemFieldLabel}`;
  return conflict.fieldLabel;
};

const removalMessage = (conflict: FieldConflict): string => {
  if (conflict.kind === 'entry-removal') {
    return conflict.localValue === null ? '本地删除了此词条，但远端做了修改' : '远端删除了此词条，但本地做了修改';
  }
  return conflict.localValue === null ? '本地删除了此条目，但远端做了修改' : '远端删除了此条目，但本地做了修改';
};

const apply = () => {
  store.applyMerge({ ...resolutions });
  visible.value = false;
};

const cancel = () => {
  store.cancelMerge();
  visible.value = false;
};

const setAll = (value: ConflictResolution) => {
  conflicts.value.forEach((conflict) => {
    resolutions[conflict.id] = value;
  });
};
</script>

<template>
  <t-dialog v-model:visible="visible" header="备份合并 · 三方比较" width="1180px" :footer="false" class="merge-dialog">
    <div v-if="result" class="backup-merge">
      <div class="merge-summary">
        <div class="summary-chip added"><strong>{{ result.addedEntryIds.length }}</strong><span>新增词条</span></div>
        <div class="summary-chip removed"><strong>{{ result.removedEntryIds.length }}</strong><span>单侧移除</span></div>
        <div class="summary-chip auto"><strong>{{ result.autoMergedFields }}</strong><span>字段自动合并</span></div>
        <div class="summary-chip conflict"><strong>{{ conflicts.length }}</strong><span>项冲突待确认</span></div>
        <div class="summary-actions">
          <t-button size="small" variant="outline" @click="setAll('local')">全部保留本地</t-button>
          <t-button size="small" variant="outline" @click="setAll('remote')">全部采用远端</t-button>
        </div>
      </div>

      <t-alert theme="info" class="merge-tip"
        title="双方改了不同字段已自动保留；同一字段或移除与修改冲突时，请逐项选择后再写入。方言变体、例句、来源和审校意见均按条目保留。" />

      <div v-if="!conflicts.length" class="no-conflict">
        <t-alert theme="success" title="没有需要逐项确认的冲突"
          description="新增和单侧移除已直接合入，双方修改不同字段的部分已自动保留。点击“应用合并”完成载入。" />
      </div>

      <div class="conflict-list">
        <div v-for="group in groupedConflicts" :key="group.entryId" class="conflict-group">
          <div class="group-head"><span class="group-dot" />{{ group.entryHeadword }}</div>
          <div v-for="conflict in group.items" :key="conflict.id" class="conflict-row" :class="{ 'removal-row': conflict.kind === 'entry-removal' || conflict.kind === 'item-removal' }">
            <div class="conflict-field">
              <strong>{{ conflictTitle(conflict) }}</strong>
              <small v-if="conflict.kind === 'entry-removal' || conflict.kind === 'item-removal'" class="removal-msg">{{ removalMessage(conflict) }}</small>
            </div>
            <div class="conflict-side" :class="{ 'side-active': resolutions[conflict.id] === 'local' }">
              <span class="side-tag">本地工作区</span>
              <p>{{ formatValue(conflict.localValue) }}</p>
            </div>
            <div class="conflict-side" :class="{ 'side-active': resolutions[conflict.id] === 'remote' }">
              <span class="side-tag remote">载入备份</span>
              <p>{{ formatValue(conflict.remoteValue) }}</p>
            </div>
            <div class="conflict-choice">
              <t-radio-group v-model="resolutions[conflict.id]" variant="default" size="small">
                <t-radio-button value="local">保留本地</t-radio-button>
                <t-radio-button value="remote">采用远端</t-radio-button>
                <t-radio-button v-if="isCombinable(conflict.localValue) && isCombinable(conflict.remoteValue)" value="combine">拼接</t-radio-button>
              </t-radio-group>
            </div>
          </div>
        </div>
      </div>

      <div class="dialog-actions">
        <span class="restore-hint">取消将恢复原工作区，可重新载入重试</span>
        <t-button variant="outline" @click="cancel">取消并恢复</t-button>
        <t-button theme="primary" @click="apply">应用合并</t-button>
      </div>
    </div>
  </t-dialog>
</template>
