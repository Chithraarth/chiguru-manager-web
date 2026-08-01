import { useEffect, useRef, useState } from "react";
import { Camera, Loader2, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { detectFace, loadFaceModels, matchWorker, type FaceWorkerLike } from "@/lib/face";

type Phase = "loading" | "scanning" | "error";

interface FaceAttendanceProps {
  workers: FaceWorkerLike[];
  /** Workers already marked present today — recognized again, we just say so. */
  presentWorkerIds: Set<number>;
  /** Called once per newly recognized worker; parent records the attendance. */
  onMarkPresent: (workerId: number) => Promise<void>;
  onClose: () => void;
}

/**
 * Scan-only face attendance for the manager device: recognizes registered
 * faces and marks them present one by one. New faces are registered by the
 * owner in the Farm app — this device only recognizes, it never enrolls.
 */
export function FaceAttendance({ workers, presentWorkerIds, onMarkPresent, onClose }: FaceAttendanceProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  const markedRef = useRef<Set<number>>(new Set());
  const unknownAtRef = useRef(0);

  const [phase, setPhase] = useState<Phase>("loading");
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [errorMsg, setErrorMsg] = useState("");
  const [banner, setBanner] = useState<{ kind: "ok" | "info"; text: string } | null>(null);
  const [sessionMarked, setSessionMarked] = useState<string[]>([]);

  // Start camera + models
  useEffect(() => {
    let cancelled = false;
    async function start() {
      setPhase("loading");
      try {
        const [stream] = await Promise.all([
          navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }),
          loadFaceModels(),
        ]);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setPhase("scanning");
      } catch {
        if (!cancelled) {
          setErrorMsg("Could not open the camera. Please allow camera access and try again.");
          setPhase("error");
        }
      }
    }
    start();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [facing]);

  // Recognition loop — fully automatic, no shutter button.
  useEffect(() => {
    const timer = setInterval(async () => {
      if (busyRef.current) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      busyRef.current = true;
      try {
        const face = await detectFace(video);
        if (!face) return;
        const match = matchWorker(face.descriptor, workers);
        if (match) {
          const { worker } = match;
          if (presentWorkerIds.has(worker.id) || markedRef.current.has(worker.id)) {
            setBanner({ kind: "info", text: `${worker.name} — already marked today ✔` });
          } else {
            markedRef.current.add(worker.id);
            try {
              await onMarkPresent(worker.id);
              setSessionMarked((s) => [worker.name, ...s]);
              setBanner({ kind: "ok", text: `✅ ${worker.name} marked present` });
            } catch {
              markedRef.current.delete(worker.id);
              setBanner({ kind: "info", text: `Could not save ${worker.name} — try again` });
            }
          }
        } else {
          // Unknown face — this device can't register faces; point to the owner.
          const now = Date.now();
          if (now - unknownAtRef.current > 6000) {
            unknownAtRef.current = now;
            setBanner({
              kind: "info",
              text: "Face not registered — the owner can add it from the Farm app (Attendance → Face Attendance).",
            });
          }
        }
      } finally {
        busyRef.current = false;
      }
    }, 900);
    return () => clearInterval(timer);
  }, [workers, presentWorkerIds, onMarkPresent]);

  // Fade the banner after a moment
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 3000);
    return () => clearTimeout(t);
  }, [banner]);

  return (
    <div className="fixed inset-0 z-40 bg-black flex flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Camera className="h-5 w-5" />
          <span className="font-semibold">Single Face Attendance</span>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setFacing((f) => (f === "user" ? "environment" : "user"))}
            aria-label="Flip camera"
          >
            <RefreshCcw className="h-5 w-5" />
          </button>
          <button onClick={onClose} aria-label="Close">
            <X className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Camera */}
      <div className="relative flex-1 overflow-hidden">
        <video
          ref={videoRef}
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover ${facing === "user" ? "scale-x-[-1]" : ""}`}
        />

        {phase === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 text-white">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm">Starting camera & loading face model…</p>
            <p className="text-xs text-gray-400">First time may take a few seconds</p>
          </div>
        )}

        {phase === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-white px-8 text-center">
            <p className="text-sm">{errorMsg}</p>
            <Button onClick={onClose} variant="secondary">Close</Button>
          </div>
        )}

        {phase === "scanning" && (
          <>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-56 h-72 rounded-[50%] border-2 border-white/60 border-dashed" />
            </div>
            <p className="absolute top-3 inset-x-0 text-center text-white/90 text-sm font-medium drop-shadow">
              One person at a time — show the face inside the oval
            </p>
          </>
        )}

        {banner && (
          <div
            className={`absolute top-12 inset-x-4 rounded-xl px-4 py-3 text-center text-sm font-semibold shadow-lg ${
              banner.kind === "ok" ? "bg-primary text-white" : "bg-white/95 text-gray-800"
            }`}
          >
            {banner.text}
          </div>
        )}
      </div>

      {/* Session summary */}
      {sessionMarked.length > 0 && (
        <div className="bg-black/90 text-white px-4 py-2 text-xs">
          Marked now: <span className="font-semibold">{sessionMarked.join(", ")}</span>
        </div>
      )}
    </div>
  );
}
