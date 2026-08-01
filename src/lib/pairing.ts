const KEY = "manager_session";

// Cached copy of the last-known /manager/me response, so the UI has a name
// and farm to show instantly on load while Firebase restores the sign-in
// session and we re-fetch the authoritative copy. The real identity always
// comes from Firebase auth state + the server, never from this cache alone.
export interface Pairing {
  farmName: string;
  managerName: string;
}

export function getPairing(): Pairing | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Pairing;
    if (!p.managerName) return null;
    return p;
  } catch {
    return null;
  }
}

export function savePairing(p: Pairing) {
  localStorage.setItem(KEY, JSON.stringify(p));
}

export function clearPairing() {
  localStorage.removeItem(KEY);
}
