import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { apiUrl } from "./api";

// Items that keep getting rejected by the server (a permanently bad payload —
// e.g. an oversized video) are dropped after this many 4xx replies so they can't
// block every newer record behind them forever.
const MAX_ATTEMPTS = 5;

// Upload budgets. A request stalled longer than this on a flaky link is dead, not
// slow — abort and retry later instead of hanging the loop.
const TIMEOUT_SMALL_MS = 20_000; // attendance / small JSON POSTs
const TIMEOUT_MEDIA_MS = 60_000; // estate updates may carry a base64 photo/video

// On flaky networks a TCP connection can open and then stall forever; a fetch with
// no timeout would freeze the whole sync loop (and the pending badge). Abort after a
// budget so a stalled request is treated as "retry later" (rejects → caught → break).
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A 200 that isn't actually our API — captive portals / ISP login pages on public
// and rural wifi return 200 with an HTML page — must NOT count as a synced write, or
// we'd delete the record while the server never received it. Our mutation endpoints
// always reply with JSON (or 204 No Content).
function looksLikeOurApi(res: Response): boolean {
  if (res.status === 204) return true;
  return (res.headers.get("content-type") ?? "").includes("application/json");
}

// A stable id that doubles as the server idempotency key (clientId). Generate it
// once when a submit starts so the immediate POST and, if that fails, the queued
// retry both carry the same key — the server then dedupes a re-sent write.
export function newLocalId(): string {
  return `eu-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface SyncQueueItem {
  id?: number;
  url: string;
  body: unknown;
  // The estate this record was captured under. Pinned at enqueue time so a
  // manager who switches estates before the queue drains still uploads each
  // record to the estate it belongs to (sent back as X-Estate-Id on flush).
  estateId?: string | null;
  timestamp: number;
  attempts?: number;
}

export interface PendingEstateUpdate {
  localId: string;
  // Pinned estate (see SyncQueueItem.estateId) — sent as X-Estate-Id on flush.
  estateId?: string | null;
  date: string;
  workerName: string | null;
  blockName: string | null;
  description: string;
  photoUrl?: string | null;
  videoUrl?: string | null;
  notes?: string | null;
  attendanceCount?: number | null;
  latitude?: string | null;
  longitude?: string | null;
  attempts?: number;
  createdAt: string;
}

// Build the estate header for a queued record. Falls back to no header (server
// uses the owner's first estate) only for legacy items queued before estate
// pinning existed.
function estateHeaders(estateId?: string | null): Record<string, string> {
  return estateId ? { "X-Estate-Id": estateId } : {};
}

interface ManagerDBSchema extends DBSchema {
  syncQueue: {
    key: number;
    value: SyncQueueItem;
    indexes: { "by-timestamp": number };
  };
  estateUpdatesQueue: {
    key: string;
    value: PendingEstateUpdate;
  };
}

let dbPromise: Promise<IDBPDatabase<ManagerDBSchema>> | null = null;
let dbInstance: IDBPDatabase<ManagerDBSchema> | null = null;

function resetDB() {
  try {
    dbInstance?.close();
  } catch {
    // already closing/closed — ignore
  }
  dbInstance = null;
  dbPromise = null;
}

function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<ManagerDBSchema>("manager-device-v1", 1, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("syncQueue")) {
          const sq = db.createObjectStore("syncQueue", {
            keyPath: "id",
            autoIncrement: true,
          });
          sq.createIndex("by-timestamp", "timestamp");
        }
        if (!db.objectStoreNames.contains("estateUpdatesQueue")) {
          db.createObjectStore("estateUpdatesQueue", { keyPath: "localId" });
        }
      },
      blocking() {
        resetDB();
      },
      terminated() {
        dbInstance = null;
        dbPromise = null;
      },
    }).then((db) => {
      dbInstance = db;
      return db;
    });
  }
  return dbPromise;
}

function isConnectionClosingError(err: unknown): boolean {
  return (
    err instanceof Error &&
    /connection is closing|database is closing/i.test(err.message)
  );
}

// Self-healing wrapper: if the cached IDB connection was closed underneath us
// (browser reclaim, frozen tab, HMR), reopen once and retry.
async function withDB<T>(
  fn: (db: IDBPDatabase<ManagerDBSchema>) => Promise<T>,
): Promise<T> {
  try {
    return await fn(await getDB());
  } catch (err) {
    if (isConnectionClosingError(err)) {
      resetDB();
      return await fn(await getDB());
    }
    throw err;
  }
}

// ─── Generic sync queue (attendance POSTs) ───────────────────────────────────

export async function enqueueSync(
  url: string,
  body: unknown,
  estateId?: string | null,
) {
  await withDB((db) =>
    db.add("syncQueue", { url, body, estateId, timestamp: Date.now() }),
  );
}

export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  return withDB((db) => db.getAllFromIndex("syncQueue", "by-timestamp"));
}

async function removeSyncItem(id: number) {
  await withDB((db) => db.delete("syncQueue", id));
}

export async function flushSyncQueue(): Promise<number> {
  const queue = await getSyncQueue();
  let flushed = 0;
  for (const item of queue) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        apiUrl(item.url),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...estateHeaders(item.estateId) },
          body: JSON.stringify(item.body),
        },
        TIMEOUT_SMALL_MS,
      );
    } catch {
      break; // still offline or request stalled — stop and retry later
    }
    try {
      if (res.ok) {
        if (!looksLikeOurApi(res)) {
          break; // captive portal / proxy, not our API — retry once truly online
        }
        await removeSyncItem(item.id!);
        flushed++;
      } else if (res.status >= 500) {
        break; // server is down — stop, retry the whole queue later
      } else {
        // 4xx: this payload is permanently bad — count it and skip past it
        // (don't head-of-line block newer records) ; drop after MAX_ATTEMPTS.
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await removeSyncItem(item.id!);
        } else {
          await withDB((db) => db.put("syncQueue", { ...item, attempts }));
        }
      }
    } catch {
      break; // still offline — stop and retry later
    }
  }
  return flushed;
}

// ─── Estate updates queue (work updates incl. video + gps) ───────────────────

export async function savePendingEstateUpdate(
  update: Omit<PendingEstateUpdate, "localId" | "createdAt">,
  localId: string = newLocalId(),
): Promise<PendingEstateUpdate> {
  const item: PendingEstateUpdate = {
    ...update,
    localId,
    createdAt: new Date().toISOString(),
  };
  await withDB((db) => db.put("estateUpdatesQueue", item));
  return item;
}

export async function getPendingEstateUpdates(): Promise<PendingEstateUpdate[]> {
  return withDB((db) => db.getAll("estateUpdatesQueue"));
}

export async function deletePendingEstateUpdate(localId: string) {
  await withDB((db) => db.delete("estateUpdatesQueue", localId));
}

export async function flushEstateUpdates(): Promise<number> {
  const items = await getPendingEstateUpdates();
  let flushed = 0;
  for (const item of items) {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        apiUrl("/estate-updates"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...estateHeaders(item.estateId) },
          body: JSON.stringify({
            clientId: item.localId,
            date: item.date,
            workerName: item.workerName,
            blockName: item.blockName,
            description: item.description,
            photoUrl: item.photoUrl ?? null,
            videoUrl: item.videoUrl ?? null,
            notes: item.notes ?? null,
            attendanceCount: item.attendanceCount ?? null,
            latitude: item.latitude ?? null,
            longitude: item.longitude ?? null,
          }),
        },
        TIMEOUT_MEDIA_MS,
      );
    } catch {
      break; // offline or stalled upload — retry later
    }
    try {
      if (res.ok) {
        if (!looksLikeOurApi(res)) {
          break; // captive portal / proxy, not our API — retry once truly online
        }
        await deletePendingEstateUpdate(item.localId);
        flushed++;
      } else if (res.status >= 500) {
        break; // server is down — retry the whole queue later
      } else {
        // 4xx: permanently bad payload — count + skip; drop after MAX_ATTEMPTS.
        const attempts = (item.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await deletePendingEstateUpdate(item.localId);
        } else {
          await withDB((db) => db.put("estateUpdatesQueue", { ...item, attempts }));
        }
      }
    } catch {
      break; // IDB hiccup — retry later
    }
  }
  return flushed;
}

export async function getPendingCount(): Promise<number> {
  return withDB(async (db) => {
    const [sq, eu] = await Promise.all([
      db.count("syncQueue"),
      db.count("estateUpdatesQueue"),
    ]);
    return sq + eu;
  });
}

// Single-flight guard: the App effect can fire flushAll() from several triggers
// (mount, "online" event, interval). Without this lock two overlapping runs could
// read the same queue snapshot and POST the same item twice before either deletes
// it. Run the two queues sequentially under one lock.
let flushing = false;

// Returns the number of records flushed, or null when a flush was already in
// progress (single-flight). Callers can use null to avoid reporting a
// misleading "nothing to upload" when another run is mid-flight.
export async function flushAll(): Promise<number | null> {
  if (flushing) return null;
  flushing = true;
  try {
    const estate = await flushEstateUpdates();
    const sync = await flushSyncQueue();
    return estate + sync;
  } finally {
    flushing = false;
  }
}
