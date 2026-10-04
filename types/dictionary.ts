export type EntryStatus = 'draft' | 'review' | 'disputed' | 'confirmed';

export interface DialectVariant {
  id: string;
  dialect: string;
  form: string;
  pronunciation: string;
  note: string;
}

export interface ExampleSentence {
  id: string;
  text: string;
  translation: string;
  source: string;
}

export interface DictionarySource {
  id: string;
  title: string;
  citation: string;
  url: string;
}

export interface ReviewComment {
  id: string;
  field: string;
  author: string;
  message: string;
  status: 'open' | 'resolved';
  createdAt: string;
  replies: Array<{ id: string; author: string; message: string; createdAt: string }>;
}

export interface DictionaryEntry {
  id: string;
  headword: string;
  pronunciation: string;
  partOfSpeech: string;
  definition: string;
  dialectVariants: DialectVariant[];
  examples: ExampleSentence[];
  sources: DictionarySource[];
  synonyms: string[];
  status: EntryStatus;
  notes: string;
  createdAt: string;
  updatedAt: string;
  reviewerComments: ReviewComment[];
}

export interface VersionRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryId?: string;
  before: DictionaryEntry[];
}

export interface AuditRecord {
  id: string;
  at: string;
  action: string;
  detail: string;
  entryIds: string[];
}

export interface DictionarySnapshot {
  revision: number;
  entries: DictionaryEntry[];
  versions: VersionRecord[];
  audit: AuditRecord[];
  syncBase?: DictionaryEntry[];
}

export interface BackupPackage extends DictionarySnapshot {
  exportedAt?: string;
}

export type MergeSide = 'ours' | 'theirs' | 'combine';
export type MergeResolution = 'ours' | 'theirs' | 'combine' | 'keep' | 'remove';
export type BaseSource = 'package' | 'history' | 'empty';

export interface MergeConflict {
  /** 形如 entry-002 / entry-002#definition / entry-002#variant#v-3#form 的稳定键 */
  key: string;
  kind: 'field' | 'presence' | 'itemPresence' | 'itemField';
  entryId: string;
  entryHeadword: string;
  /** 字段或子项的中文路径，例如「释义」「方言变体 v-3 · 词形」 */
  label: string;
  /** 允许的逐项处理方式；仅文本字段允许 combine */
  options: MergeResolution[];
  ours: unknown;
  theirs: unknown;
  base: unknown;
  combinable: boolean;
  resolution?: MergeResolution;
}

export interface MergeStats {
  entriesAdded: number;
  entriesRemoved: number;
  entriesChanged: number;
  itemsAdded: number;
  conflicts: number;
}

export interface MergePlan {
  base: DictionaryEntry[];
  baseSource: BaseSource;
  ours: DictionaryEntry[];
  theirs: DictionaryEntry[];
  conflicts: MergeConflict[];
  stats: MergeStats;
  incomingRevision: number;
  exportedAt?: string;
}

export interface DuplicatePair {
  leftId: string;
  rightId: string;
  score: number;
  reasons: string[];
}
