import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, Camera, Video, X, Loader2, Upload, Users,
  Wifi, WifiOff, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiPost, apiUrl, getActiveEstateId, checkManagerSession } from "@/lib/api";
import { savePendingEstateUpdate, newLocalId } from "@/lib/offline-db";
import { useToast } from "@/hooks/use-toast";
import type { Pairing } from "@/lib/pairing";

const TODAY = new Date().toISOString().split("T")[0];

function compressImage(dataUrl: string, maxW = 800): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, maxW / img.width);
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.src = dataUrl;
  });
}

interface GeoState {
  status: "idle" | "locating" | "done" | "denied";
  latitude?: string;
  longitude?: string;
}

export function WorkUpdateScreen({
  pairing,
  onBack,
  onRevoked,
  onRecorded,
}: {
  pairing: Pairing;
  onBack: () => void;
  onRevoked: () => void;
  onRecorded: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const photoRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);

  const [mediaDataUrl, setMediaDataUrl] = useState<string | undefined>();
  const [mediaType, setMediaType] = useState<"photo" | "video" | undefined>();
  const [description, setDescription] = useState("");
  const [blockName, setBlockName] = useState("");
  const [attendanceCount, setAttendanceCount] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [aiCounting, setAiCounting] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [geo, setGeo] = useState<GeoState>({ status: "idle" });

  // Online/offline awareness so the Post button + status pill reflect reality.
  useEffect(() => {
    const on = () => setIsOnline(true);
    const off = () => setIsOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // Best-effort GPS tag — works offline (it's device hardware, not network).
  // A denial is non-fatal: the update still posts, just without a location.
  useEffect(() => {
    if (!("geolocation" in navigator)) {
      setGeo({ status: "denied" });
      return;
    }
    setGeo({ status: "locating" });
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setGeo({
          status: "done",
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }),
      () => setGeo({ status: "denied" }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }, []);

  async function runAiCount(dataUrl: string) {
    if (!navigator.onLine) return;
    setAiCounting(true);
    setAiDone(false);
    try {
      const res = await fetch(apiUrl("/ai/count-workers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl }),
      });
      if (res.ok) {
        const data = await res.json();
        const count = Math.max(0, Math.round(Number(data.count) || 0));
        setAttendanceCount(String(count));
        setAiDone(true);
      }
    } catch {
      // ignore — manager can type the count by hand
    } finally {
      setAiCounting(false);
    }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>, type: "photo" | "video") {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const raw = ev.target?.result as string;
      if (type === "photo") {
        const compressed = await compressImage(raw);
        setMediaDataUrl(compressed);
        setMediaType("photo");
        runAiCount(compressed);
      } else {
        setMediaDataUrl(raw);
        setMediaType("video");
      }
    };
    reader.readAsDataURL(file);
  }

  function clearMedia() {
    setMediaDataUrl(undefined);
    setMediaType(undefined);
    setAiCounting(false);
    setAiDone(false);
  }

  async function submit() {
    if (!description.trim()) {
      toast({ title: "Please describe the work done", variant: "destructive" });
      return;
    }
    setSaving(true);

    const parsed = attendanceCount !== "" ? parseInt(attendanceCount, 10) : undefined;
    // One stable id for this submit: it's the offline-queue key AND the server
    // idempotency key, so a retried/lost-response POST can't create a duplicate.
    const clientId = newLocalId();
    const base = {
      estateId: getActiveEstateId(),
      date: TODAY,
      workerName: pairing.managerName,
      blockName: blockName.trim() || null,
      description: description.trim(),
      photoUrl: mediaType === "photo" ? (mediaDataUrl ?? null) : null,
      videoUrl: mediaType === "video" ? (mediaDataUrl ?? null) : null,
      notes: notes.trim() || null,
      attendanceCount: parsed != null && !isNaN(parsed) ? parsed : null,
      latitude: geo.latitude ?? null,
      longitude: geo.longitude ?? null,
    };

    // Offline: queue locally and let the device sync when the network returns.
    if (!navigator.onLine) {
      await savePendingEstateUpdate(base, clientId);
      toast({ title: "Saved offline ✓", description: "Will upload automatically when internet returns." });
      qc.invalidateQueries({ queryKey: ["estate-updates"] });
      onRecorded();
      onBack();
      return;
    }

    // Online: re-check the manager session before writing to the shared farm records.
    const verdict = await checkManagerSession();
    if (verdict === "invalid") {
      onRevoked();
      return;
    }

    try {
      await apiPost("/estate-updates", { ...base, clientId });
      toast({ title: "Work update posted ✓", description: "The owner can see it now." });
      qc.invalidateQueries({ queryKey: ["estate-updates"] });
      onRecorded();
      onBack();
    } catch {
      // Network dropped mid-send — keep the work instead of losing it.
      await savePendingEstateUpdate(base, clientId);
      toast({ title: "Saved offline ✓", description: "Will upload automatically when internet returns." });
      qc.invalidateQueries({ queryKey: ["estate-updates"] });
      onRecorded();
      onBack();
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-accent px-3 py-3 flex items-center gap-2 sticky top-0 z-10">
        <button onClick={onBack} className="p-1.5 text-white">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="font-bold text-white flex-1">New Work Update</h1>
        <Button
          size="sm"
          className="bg-white/20 hover:bg-white/30 text-white rounded-xl px-4"
          disabled={saving}
          onClick={submit}
        >
          {saving ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isOnline ? (
            <><Upload className="h-4 w-4 mr-1" /> Post</>
          ) : (
            <><WifiOff className="h-4 w-4 mr-1" /> Save</>
          )}
        </Button>
      </div>

      <div className="p-4 space-y-4">
        {/* Online/offline + location status */}
        <div className="flex flex-wrap items-center gap-2">
          <div className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl ${
            isOnline ? "bg-primary/5 text-primary" : "bg-amber-50 text-amber-700"
          }`}>
            {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {isOnline ? "Online — uploads now" : "Offline — saves to phone"}
          </div>
          <div className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl ${
            geo.status === "done" ? "bg-accent/5 text-accent" : "bg-gray-100 text-gray-500"
          }`}>
            <MapPin className="h-3.5 w-3.5" />
            {geo.status === "locating" ? "Finding location…"
              : geo.status === "done" ? "Location attached"
              : "No location"}
          </div>
        </div>

        {/* Media capture: photo + video */}
        <div>
          <p className="text-xs font-semibold text-gray-500 uppercase mb-2">Capture photo / video</p>
          {mediaDataUrl ? (
            <div className="relative">
              {mediaType === "photo" ? (
                <img src={mediaDataUrl} alt="work" className="w-full rounded-2xl object-cover max-h-56" />
              ) : (
                <video src={mediaDataUrl} controls playsInline className="w-full rounded-2xl max-h-56 bg-black" />
              )}
              {aiCounting && (
                <div className="absolute inset-0 bg-black/40 rounded-2xl flex flex-col items-center justify-center gap-2">
                  <Loader2 className="h-7 w-7 text-white animate-spin" />
                  <p className="text-white text-xs font-semibold">AI counting workers…</p>
                </div>
              )}
              <button
                onClick={clearMedia}
                className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => photoRef.current?.click()}
                className="flex flex-col items-center gap-1.5 bg-accent/5 border-2 border-dashed border-accent/20 rounded-2xl py-6 active:bg-accent/15"
              >
                <Camera className="h-6 w-6 text-accent" />
                <span className="text-xs font-semibold text-accent">Take photo</span>
                <span className="text-[10px] text-accent">AI counts workers</span>
              </button>
              <button
                onClick={() => videoRef.current?.click()}
                className="flex flex-col items-center gap-1.5 bg-purple-50 border-2 border-dashed border-purple-200 rounded-2xl py-6 active:bg-purple-100"
              >
                <Video className="h-6 w-6 text-purple-500" />
                <span className="text-xs font-semibold text-purple-700">Record video</span>
                <span className="text-[10px] text-purple-500">Short clip of the work</span>
              </button>
            </div>
          )}
          <input
            ref={photoRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => handleFile(e, "photo")}
          />
          <input
            ref={videoRef}
            type="file"
            accept="video/*"
            capture="environment"
            className="hidden"
            onChange={(e) => handleFile(e, "video")}
          />
        </div>

        {/* AI result hint */}
        {mediaType === "photo" && aiDone && (
          <p className="text-xs text-purple-700 bg-purple-50 rounded-lg px-3 py-2 leading-snug">
            🤖 AI detected {attendanceCount || 0} worker{attendanceCount === "1" ? "" : "s"} — edit the count below if needed.
          </p>
        )}

        {/* Description */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">
            What work was done? <span className="text-red-500">*</span>
          </label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Pruning completed in Block A, weeding near irrigation lines..."
            className="rounded-xl text-sm min-h-[90px]"
          />
        </div>

        {/* Block + attendance */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Block / Area</label>
            <Input
              value={blockName}
              onChange={(e) => setBlockName(e.target.value)}
              placeholder="e.g. Block A"
              className="rounded-xl text-sm"
            />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5 flex items-center gap-1">
              <Users className="h-3 w-3" /> Workers present
            </label>
            <Input
              type="number"
              min="0"
              value={attendanceCount}
              onChange={(e) => setAttendanceCount(e.target.value)}
              placeholder="Optional"
              className="rounded-xl text-sm"
            />
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Notes (optional)</label>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any issues, observations, materials used..."
            className="rounded-xl text-sm min-h-[60px]"
          />
        </div>
      </div>
    </div>
  );
}
