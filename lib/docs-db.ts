// DocShell 文档持久化（IndexedDB）。一个「文档」= 一个会话（含正文段、批注、ccSessionId）。
// 多开 = 多文档，切换/刷新/关窗都不丢。
import { openDB, type IDBPDatabase } from 'idb';

export interface StoredPara {
  id: string;
  kind: 'input' | 'reply' | 'revision';
  text?: string;
  file?: string;
  before?: string;
  after?: string;
}
export interface StoredComment {
  id: string;
  icon: string;
  who: string;
  summary: string;
  detail: string;
  err?: boolean;
}
export interface StoredDoc {
  id: string;
  title: string;
  paras: StoredPara[];
  comments: StoredComment[];
  ccSessionId?: string;
  createdAt: number;
  updatedAt: number;
}

const DB_NAME = 'docshell';
const STORE = 'docs';

let dbp: Promise<IDBPDatabase> | null = null;
function db() {
  if (!dbp) {
    dbp = openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id' });
        }
      },
    });
  }
  return dbp;
}

// 文档列表（按最近更新排序），用于「文件」菜单
export async function listDocs(): Promise<StoredDoc[]> {
  const all = (await (await db()).getAll(STORE)) as StoredDoc[];
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDoc(id: string): Promise<StoredDoc | undefined> {
  return (await db()).get(STORE, id) as Promise<StoredDoc | undefined>;
}

export async function saveDoc(doc: StoredDoc): Promise<void> {
  await (await db()).put(STORE, doc);
}

export async function deleteDoc(id: string): Promise<void> {
  await (await db()).delete(STORE, id);
}
