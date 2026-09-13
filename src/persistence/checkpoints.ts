import type { Collaboration, Entry, Panel, Workspace } from "../lab/store";
import type { LessonEvidence, LessonId } from "../lessons/lessons";
import type { DatabaseMode, RuntimeCloneSeed } from "../runtime/protocol";

const DATABASE_NAME = "revision-lab-app";
const DATABASE_VERSION = 1;
const CHECKPOINTS = "checkpoints";
const SESSION = "session";
const SESSION_KEY = "current";

export type WorkspaceCheckpoint = {
  formatVersion: 1;
  workspace: {
    id: string; name: string; mode: DatabaseMode; evidence: LessonEvidence;
    role?: Workspace["role"]; collaborationId?: string; file?: string; revision?: string;
    entries: Entry[];
  };
  seed: RuntimeCloneSeed;
  savedAt: number;
};

export type PersistedSession = {
  formatVersion: 1;
  workspaceIds: string[];
  activeId?: string;
  panel: Panel;
  guideEnabled: boolean;
  activeLesson: LessonId;
  collaboration?: Collaboration;
};

export type RestoredSession = { session: PersistedSession; checkpoints: WorkspaceCheckpoint[] };

export interface CheckpointRepository {
  save(checkpoint: WorkspaceCheckpoint, session: PersistedSession): Promise<void>;
  saveSession(session: PersistedSession): Promise<void>;
  load(): Promise<RestoredSession | undefined>;
  loadCheckpoint(workspaceId: string): Promise<WorkspaceCheckpoint | undefined>;
  delete(workspaceIds: string[], session: PersistedSession): Promise<void>;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(CHECKPOINTS)) database.createObjectStore(CHECKPOINTS, { keyPath: "workspace.id" });
      if (!database.objectStoreNames.contains(SESSION)) database.createObjectStore(SESSION);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another tab"));
  });
}

function databaseRepository(): CheckpointRepository {
  return {
    async save(checkpoint, session) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction([CHECKPOINTS, SESSION], "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(CHECKPOINTS).put(checkpoint);
        transaction.objectStore(SESSION).put(session, SESSION_KEY);
        await done;
      } finally { database.close(); }
    },
    async saveSession(session) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(SESSION, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(SESSION).put(session, SESSION_KEY);
        await done;
      } finally { database.close(); }
    },
    async load() {
      const database = await openDatabase();
      try {
        const transaction = database.transaction([CHECKPOINTS, SESSION], "readonly");
        const done = transactionDone(transaction);
        const session = await requestValue(transaction.objectStore(SESSION).get(SESSION_KEY)) as PersistedSession | undefined;
        if (!session || session.formatVersion !== 1 || !Array.isArray(session.workspaceIds)) return undefined;
        const checkpoints: WorkspaceCheckpoint[] = [];
        for (const id of session.workspaceIds.slice(0, 4)) {
          const checkpoint = await requestValue(transaction.objectStore(CHECKPOINTS).get(id)) as WorkspaceCheckpoint | undefined;
          if (checkpoint?.formatVersion === 1) checkpoints.push(checkpoint);
        }
        await done;
        return { session, checkpoints };
      } finally { database.close(); }
    },
    async loadCheckpoint(workspaceId) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction(CHECKPOINTS, "readonly");
        const done = transactionDone(transaction);
        const checkpoint = await requestValue(transaction.objectStore(CHECKPOINTS).get(workspaceId)) as WorkspaceCheckpoint | undefined;
        await done;
        return checkpoint?.formatVersion === 1 ? checkpoint : undefined;
      } finally { database.close(); }
    },
    async delete(workspaceIds, session) {
      const database = await openDatabase();
      try {
        const transaction = database.transaction([CHECKPOINTS, SESSION], "readwrite");
        const done = transactionDone(transaction);
        for (const id of workspaceIds) transaction.objectStore(CHECKPOINTS).delete(id);
        transaction.objectStore(SESSION).put(session, SESSION_KEY);
        await done;
      } finally { database.close(); }
    },
  };
}

export function createCheckpointRepository(): CheckpointRepository {
  if (typeof indexedDB === "undefined") {
    return {
      save: async () => undefined, saveSession: async () => undefined, load: async () => undefined,
      loadCheckpoint: async () => undefined, delete: async () => undefined,
    };
  }
  return databaseRepository();
}
