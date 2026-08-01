// On-device face recognition (no photos leave the phone — only a 128-number
// "face signature" is stored per worker and matched locally).
let faceapi: typeof import("@vladmandic/face-api") | null = null;
let modelsLoaded = false;

export async function loadFaceModels() {
  if (!faceapi) {
    faceapi = await import("@vladmandic/face-api");
  }
  if (!modelsLoaded) {
    const base = `${import.meta.env.BASE_URL}models`;
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(base),
      faceapi.nets.faceLandmark68Net.loadFromUri(base),
      faceapi.nets.faceRecognitionNet.loadFromUri(base),
    ]);
    modelsLoaded = true;
  }
  return faceapi;
}

export interface DetectedFace {
  descriptor: Float32Array;
  /** Head turn estimate from jaw/nose landmarks: ~0 facing straight, +/- when turned. */
  yaw: number;
}

/** Detect the most prominent face in the video frame: 128-d descriptor + head-turn estimate. */
export async function detectFace(video: HTMLVideoElement): Promise<DetectedFace | null> {
  const api = await loadFaceModels();
  const det = await api
    .detectSingleFace(video, new api.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!det) return null;
  // Yaw from landmark asymmetry: nose tip (30) between jaw edges (0, 16).
  const pts = det.landmarks.positions;
  const nose = pts[30];
  const jawL = pts[0];
  const jawR = pts[16];
  const left = Math.abs(nose.x - jawL.x);
  const right = Math.abs(jawR.x - nose.x);
  const yaw = left + right > 0 ? (right - left) / (right + left) : 0;
  return { descriptor: det.descriptor, yaw };
}

/** Distance between two face descriptors (lower = more similar). */
export function descriptorDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return euclidean(a, b);
}

function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Lower = stricter. 0.5 is the widely-used default for this model. */
export const FACE_MATCH_THRESHOLD = 0.5;

export interface FaceWorkerLike {
  id: number;
  name: string;
  faceDescriptor?: string | null;
}

/** Round to 5 decimals — plenty of precision for matching, much smaller to store. */
export function compactDescriptor(d: Float32Array): number[] {
  return Array.from(d, (n) => Math.round(n * 1e5) / 1e5);
}

/** Stored value may be one descriptor (number[128]) or several poses (number[][]). */
function parseStoredDescriptors(stored: string): number[][] {
  try {
    const parsed = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length === 0) return [];
    if (Array.isArray(parsed[0])) {
      return parsed.filter((a: unknown) => Array.isArray(a) && a.length === 128);
    }
    return parsed.length === 128 ? [parsed] : [];
  } catch {
    return [];
  }
}

/** Find the closest registered worker for a live descriptor, or null if nobody is close enough. */
export function matchWorker<T extends FaceWorkerLike>(
  descriptor: Float32Array,
  workers: T[],
): { worker: T; distance: number } | null {
  let best: { worker: T; distance: number } | null = null;
  for (const w of workers) {
    if (!w.faceDescriptor) continue;
    for (const stored of parseStoredDescriptors(w.faceDescriptor)) {
      const d = euclidean(descriptor, stored);
      if (!best || d < best.distance) best = { worker: w, distance: d };
    }
  }
  return best && best.distance <= FACE_MATCH_THRESHOLD ? best : null;
}
