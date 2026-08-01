import { useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight, Loader2, Check, Users, Banknote,
  Camera, Sparkles, Wallet, CalendarClock, Plus, X, FolderOpen, ScanFace,
} from "lucide-react";
import { FaceAttendance } from "@/components/face-attendance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiFetch, apiPost, apiUrl, getActiveEstateId, checkManagerSession } from "@/lib/api";
import { enqueueSync } from "@/lib/offline-db";
import { useToast } from "@/hooks/use-toast";
import type { Pairing } from "@/lib/pairing";
import { fmtMoney, curSymbol } from "@/lib/currency";

interface WorkGroup {
  id: number;
  name: string;
  paymentType: string;
  rate: number;
  cropName?: string;
  advancePerUnit?: number;
  payFrequency?: string;
}
interface Worker {
  id: number;
  name: string;
  type: string;
  wageRate: number;
  wageUnit: string;
  isActive: boolean;
  faceDescriptor?: string | null;
}
interface Attendance {
  id: number;
  workGroupId: number;
  workerId: number;
  date: string;
  hoursWorked: number;
  wageAmount: number;
  createdAt?: string;
}

// Server-recorded time (DB sets createdAt) — device clocks can't fake this.
function fmtMarkedTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}
interface AdvancePayment {
  id: number;
  paymentDate: string;
  totalAdvancePaid: number;
}

// Local YYYY-MM-DD (avoids UTC date drift for India); used everywhere so the
// "today" we write attendance under and the period boundaries we compare against
// share one date basis.
function isoLocal(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const TODAY = isoLocal(new Date());

const PAY_FREQ_LABELS: Record<string, string> = {
  daily: "Daily",
  "weekly-5": "Every 5 days",
  "weekly-6": "Every 6 days",
  "weekly-7": "Every 7 days",
  monthly: "Monthly",
};

// Mirrors the owner app's work-group options so groups created on the manager
// device look identical in the owner's Work Groups screen.
const CATEGORIES = [
  "Harvest / Cutting", "Pruning", "Manuring", "Drone spraying",
  "Fertilizer application", "Weeding", "Irrigation", "Planting", "Custom",
];
const LABOUR_TYPES = ["General labour", "Skilled labour", "Machine operator", "Drone operator", "Contractor"];
const PAYMENT_TYPES = ["Per day", "Per hour", "Per acre", "Per kg"];
const PAY_FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly-5", label: "Every 5 days" },
  { value: "weekly-6", label: "Every 6 days" },
  { value: "weekly-7", label: "Every 7 days" },
  { value: "monthly", label: "Monthly" },
];

interface NewGroupForm {
  name: string;
  blockName: string;
  expectedWorkers: string;
  category: string;
  labourType: string;
  paymentType: string;
  rate: string;
  advancePerUnit: string;
  payFrequency: string;
}

const EMPTY_GROUP_FORM: NewGroupForm = {
  name: "", blockName: "", expectedWorkers: "",
  category: "Weeding", labourType: "General labour",
  paymentType: "Per day", rate: "", advancePerUnit: "", payFrequency: "daily",
};

/** Start of the current payout period for a given frequency. */
function periodStartISO(freq: string): string {
  const now = new Date();
  if (freq === "monthly") return isoLocal(new Date(now.getFullYear(), now.getMonth(), 1));
  if (freq.startsWith("weekly")) {
    const d = new Date(now);
    const dow = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dow);
    return isoLocal(d);
  }
  return isoLocal(now); // daily
}

/** When the held balance is settled — kept deliberately generic for weekly-N cadences. */
function payoutLabel(freq: string): string {
  if (freq === "monthly") return "month-end";
  if (freq.startsWith("weekly")) return "next payout";
  return "end of day";
}

function periodWord(freq: string): string {
  if (freq === "monthly") return "month";
  if (freq.startsWith("weekly")) return "week";
  return "day";
}

function compressImage(dataUrl: string, maxW = 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ratio = Math.min(1, maxW / img.width);
      canvas.width = img.width * ratio;
      canvas.height = img.height * ratio;
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = () => reject(new Error("Could not read that image"));
    img.src = dataUrl;
  });
}

export function AttendanceScreen({
  pairing,
  activeEstateId,
  onBack,
  onRevoked,
  onRecorded,
}: {
  pairing: Pairing;
  activeEstateId: string | null;
  onBack: () => void;
  onRevoked: () => void;
  onRecorded: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [group, setGroup] = useState<WorkGroup | null>(null);
  const [hours, setHours] = useState("8");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [aiScanning, setAiScanning] = useState(false);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [showFaceScan, setShowFaceScan] = useState(false);
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupForm, setGroupForm] = useState<NewGroupForm>(EMPTY_GROUP_FORM);

  // Estate id is in every query key: GET /work-groups and /attendance are
  // server-side scoped by X-Estate-Id, so switching estates must refetch (not
  // reuse another estate's cached groups/attendance).
  const { data: groups = [], isLoading: loadingGroups } = useQuery<WorkGroup[]>({
    queryKey: ["work-groups", activeEstateId],
    queryFn: () => apiFetch("/work-groups"),
  });

  const { data: workers = [], isLoading: loadingWorkers } = useQuery<Worker[]>({
    // Workers are estate-scoped server-side — keying by estate prevents a stale
    // list (and stale face descriptors) after switching estates.
    queryKey: ["workers", activeEstateId],
    queryFn: () => apiFetch("/workers"),
  });

  const { data: todayAtt = [] } = useQuery<Attendance[]>({
    queryKey: ["attendance", activeEstateId, TODAY],
    queryFn: () => apiFetch(`/attendance?date=${TODAY}`),
  });

  // Full attendance history for the selected group — used for the period payout total.
  const { data: groupAtt = [] } = useQuery<Attendance[]>({
    queryKey: ["attendance-group", activeEstateId, group?.id],
    queryFn: () => apiFetch(`/attendance?workGroupId=${group!.id}`),
    enabled: !!group,
  });

  // Authoritative advance payments the owner has actually recorded for this group.
  const { data: advancePayments = [] } = useQuery<AdvancePayment[]>({
    queryKey: ["advance-payments", activeEstateId, group?.id],
    queryFn: () => apiFetch(`/work-groups/${group!.id}/advance-payments`),
    enabled: !!group,
  });

  const markedIds = new Set(todayAtt.map((a) => a.workerId));
  const markedAtByWorker = new Map(
    todayAtt.filter((a) => a.createdAt).map((a) => [a.workerId, a.createdAt as string]),
  );
  const activeWorkers = workers.filter((w) => w.isActive);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Create a work group from the manager device. The server stamps the active
  // estate (X-Estate-Id) on insert, so the owner sees it in the same estate's
  // Work Groups list. Online-only: the new group needs a server-assigned id
  // before attendance can be marked against it.
  const createGroup = useMutation({
    mutationFn: (form: NewGroupForm) =>
      apiPost<WorkGroup>("/work-groups", {
        name: form.name.trim(),
        blockName: form.blockName.trim() || undefined,
        category: form.category,
        labourType: form.labourType,
        paymentType: form.paymentType,
        rate: parseFloat(form.rate),
        advancePerUnit: form.advancePerUnit ? parseFloat(form.advancePerUnit) : undefined,
        payFrequency: form.payFrequency || "daily",
        expectedWorkers: form.expectedWorkers ? parseInt(form.expectedWorkers, 10) : undefined,
      }),
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ["work-groups", activeEstateId] });
      setShowGroupForm(false);
      setGroupForm(EMPTY_GROUP_FORM);
      toast({ title: "Work group created", description: "The owner can now see this group." });
      // Jump straight into the new group so attendance can be marked right away.
      setGroup(created);
      setSelected(new Set());
      setAiNote(null);
    },
    onError: () =>
      toast({
        title: "Could not create group",
        description: "You need to be online to add a work group. Check your connection and try again.",
        variant: "destructive",
      }),
  });

  function submitGroup() {
    if (!groupForm.name.trim()) {
      toast({ title: "Enter a work name", variant: "destructive" });
      return;
    }
    const rate = parseFloat(groupForm.rate);
    if (!Number.isFinite(rate) || rate <= 0) {
      toast({ title: "Enter a valid rate", variant: "destructive" });
      return;
    }
    createGroup.mutate(groupForm);
  }

  function handleScanFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = "";
    if (!file) return;
    setAiScanning(true);
    setAiNote(null);
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = ev.target?.result as string;
        const dataUrl = await compressImage(raw);
        const res = await fetch(apiUrl("/ai/count-workers"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageBase64: dataUrl }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "AI failed");
        const count = Math.max(0, Math.round(Number(data.count) || 0));
        const unmarked = activeWorkers.filter((w) => !markedIds.has(w.id));
        const toSelect = unmarked.slice(0, count);
        setSelected(new Set(toSelect.map((w) => w.id)));
        setAiNote(
          `AI counted ${count} ${count === 1 ? "person" : "people"} in the photo` +
            (toSelect.length < count
              ? ` — but only ${toSelect.length} unmarked worker${toSelect.length === 1 ? "" : "s"} left to select.`
              : ` — ${toSelect.length} selected below.`),
        );
        toast({ title: `AI counted ${count} worker${count !== 1 ? "s" : ""}` });
      } catch (err) {
        toast({
          title: err instanceof Error ? err.message : "AI headcount failed",
          description: "Try a clearer photo with everyone in the frame, or tick workers by hand.",
          variant: "destructive",
        });
      } finally {
        setAiScanning(false);
      }
    };
    reader.onerror = () => {
      setAiScanning(false);
      toast({
        title: "Could not read that photo",
        description: "Try again, or tick workers by hand.",
        variant: "destructive",
      });
    };
    reader.readAsDataURL(file);
  }

  // Mark a single worker present right now (used by face attendance). Offline
  // marks are queued and flushed on reconnect, same as the bulk save path.
  async function markOne(workerId: number) {
    if (!group) return;
    const rate = Number(group.rate);
    const h = parseFloat(hours) || 8;
    const wage = group.paymentType === "Per hour" ? rate * h : rate;
    const worker = activeWorkers.find((w) => w.id === workerId);
    const record = {
      workGroupId: group.id,
      workerId,
      date: TODAY,
      hoursWorked: h,
      wageAmount: wage || Number(worker?.wageRate ?? 0),
      deviceLabel: pairing.managerName,
    };
    if (!navigator.onLine) {
      await enqueueSync("/attendance", record, getActiveEstateId());
      onRecorded();
    } else {
      // Same session re-check as the bulk save path: if the owner removed this
      // manager, stop before writing.
      const verdict = await checkManagerSession();
      if (verdict === "invalid") {
        onRevoked();
        throw new Error("manager session revoked");
      }
      await apiPost("/attendance", record);
      qc.invalidateQueries({ queryKey: ["attendance", activeEstateId, TODAY] });
      qc.invalidateQueries({ queryKey: ["attendance-group", activeEstateId, group.id] });
      onRecorded();
    }
  }

  async function save() {
    if (!group || selected.size === 0) return;
    setSaving(true);

    const rate = Number(group.rate);
    const h = parseFloat(hours) || 8;
    const wage = group.paymentType === "Per hour" ? rate * h : rate;

    // Offline: queue each mark locally; the device flushes them on reconnect.
    if (!navigator.onLine) {
      for (const wId of selected) {
        const worker = activeWorkers.find((w) => w.id === wId);
        if (!worker) continue;
        await enqueueSync(
          "/attendance",
          {
            workGroupId: group.id,
            workerId: wId,
            date: TODAY,
            hoursWorked: h,
            wageAmount: wage || Number(worker.wageRate),
            deviceLabel: pairing.managerName,
          },
          getActiveEstateId(),
        );
      }
      toast({
        title: `Saved ${selected.size} offline ✓`,
        description: "Will upload automatically when internet returns.",
      });
      setSelected(new Set());
      setAiNote(null);
      setSaving(false);
      // Nudge a background flush in case connectivity just came back.
      onRecorded();
      return;
    }

    // Re-check the manager session first: if the owner removed this manager,
    // stop and force sign-in again before writing anything to the shared farm records.
    const verdict = await checkManagerSession();
    if (verdict === "invalid") {
      onRevoked();
      return;
    }

    const saved: number[] = [];
    try {
      for (const wId of selected) {
        const worker = activeWorkers.find((w) => w.id === wId);
        if (!worker) continue;
        await apiPost("/attendance", {
          workGroupId: group.id,
          workerId: wId,
          date: TODAY,
          hoursWorked: h,
          wageAmount: wage || Number(worker.wageRate),
          deviceLabel: pairing.managerName,
        });
        saved.push(wId);
      }
      toast({ title: `Attendance saved for ${saved.length} worker${saved.length > 1 ? "s" : ""} ✓` });
      setSelected(new Set());
      setAiNote(null);
      // Flush any other queued items so the owner sees everything right away.
      onRecorded();
    } catch {
      // Drop the workers we already saved so a retry can't double-insert them.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of saved) next.delete(id);
        return next;
      });
      toast({
        title: saved.length > 0 ? `Saved ${saved.length}, but some failed` : "Could not save attendance",
        description: "Check your connection and try the remaining workers again.",
        variant: "destructive",
      });
    } finally {
      // Always refresh so already-marked workers show as marked, even after a partial failure.
      qc.invalidateQueries({ queryKey: ["attendance", activeEstateId, TODAY] });
      qc.invalidateQueries({ queryKey: ["attendance-group", activeEstateId, group.id] });
      setSaving(false);
    }
  }

  // ── Group picker ──────────────────────────────────────────────────────────
  if (!group) {
    return (
      <div className="min-h-screen bg-gray-50">
        <Header
          title="Mark Attendance"
          onBack={onBack}
          action={
            <button
              onClick={() => { setGroupForm(EMPTY_GROUP_FORM); setShowGroupForm(true); }}
              className="bg-white/20 text-white rounded-full p-1.5 active:bg-white/30"
              aria-label="Create work group"
            >
              <Plus className="h-5 w-5" />
            </button>
          }
        />
        <div className="p-4 space-y-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Choose a work group</p>
          {loadingGroups ? (
            <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
          ) : groups.length === 0 ? (
            <div className="text-center py-10 text-gray-400">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No work groups yet</p>
              <p className="text-xs mt-1 max-w-[220px] mx-auto text-gray-300">
                Create a group for the workers on site — the owner will see it too.
              </p>
              <Button
                onClick={() => { setGroupForm(EMPTY_GROUP_FORM); setShowGroupForm(true); }}
                className="mt-4 bg-primary hover:bg-primary/90 text-white"
              >
                <Plus className="h-4 w-4 mr-1" /> Create group
              </Button>
            </div>
          ) : (
            groups.map((g) => {
              const freq = g.payFrequency || "daily";
              return (
                <button
                  key={g.id}
                  onClick={() => { setGroup(g); setSelected(new Set()); setAiNote(null); }}
                  className="w-full bg-white rounded-2xl p-4 border border-gray-100 shadow-sm flex items-center justify-between active:bg-gray-50 text-left"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-gray-900">{g.name}</p>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1">
                      {fmtMoney(g.rate)} {g.paymentType.toLowerCase()}
                      {g.cropName ? ` · ${g.cropName}` : ""}
                    </p>
                    {freq !== "daily" && (
                      <p className="text-xs text-orange-600 mt-0.5 flex items-center gap-1">
                        <CalendarClock className="h-3 w-3" /> {PAY_FREQ_LABELS[freq] ?? freq} · settles at {payoutLabel(freq)}
                      </p>
                    )}
                  </div>
                  <ChevronRight className="h-5 w-5 text-gray-300 flex-shrink-0" />
                </button>
              );
            })
          )}
        </div>
        {showGroupForm && (
          <CreateGroupSheet
            form={groupForm}
            setForm={setGroupForm}
            onClose={() => setShowGroupForm(false)}
            onSubmit={submitGroup}
            pending={createGroup.isPending}
          />
        )}
      </div>
    );
  }

  // ── Worker list ───────────────────────────────────────────────────────────
  const isHourly = group.paymentType === "Per hour";
  const rate = Number(group.rate);
  const h = parseFloat(hours) || 8;
  const perWorker = isHourly ? rate * h : rate;

  const freq = group.payFrequency || "daily";
  const isPeriodic = freq !== "daily";
  const when = payoutLabel(freq);
  const word = periodWord(freq);
  const advancePerDay = group.advancePerUnit ? Number(group.advancePerUnit) : 0;
  const heldPerDay = advancePerDay > 0 ? Math.max(0, rate - advancePerDay) : 0;

  const start = periodStartISO(freq);
  const periodRows = groupAtt.filter((a) => a.date >= start);
  const periodWorkerDays = periodRows.length;
  const periodEarned = periodRows.reduce((s, a) => s + Number(a.wageAmount), 0);
  // Use the advances the owner has actually recorded in this period — not an estimate.
  const periodAdvancePaid = advancePayments
    .filter((p) => p.paymentDate >= start)
    .reduce((s, p) => s + Number(p.totalAdvancePaid), 0);
  const periodDue = Math.max(0, periodEarned - periodAdvancePaid);

  return (
    <div className="min-h-screen bg-gray-50 pb-28">
      <Header title={group.name} onBack={() => { setGroup(null); setSelected(new Set()); setAiNote(null); }} />
      <div className="p-4 space-y-4">
        {/* Payout / advance summary — what the owner is owed this period */}
        {(isPeriodic || advancePerDay > 0) && (
          <div className="bg-orange-50 rounded-2xl p-4 border border-orange-100 space-y-3">
            <div className="flex items-center gap-2">
              <Wallet className="h-4 w-4 text-orange-600" />
              <p className="text-sm font-semibold text-orange-800">
                Payout at {when}
              </p>
              {isPeriodic && (
                <span className="ml-auto text-xs text-orange-600 bg-white rounded-full px-2 py-0.5 border border-orange-200">
                  {PAY_FREQ_LABELS[freq] ?? freq}
                </span>
              )}
            </div>

            {advancePerDay > 0 && (
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className="bg-white rounded-xl p-2">
                  <p className="text-[11px] text-gray-400">Day rate</p>
                  <p className="text-sm font-bold text-gray-800">{fmtMoney(rate)}</p>
                </div>
                <div className="bg-white rounded-xl p-2">
                  <p className="text-[11px] text-gray-400">Advance/day</p>
                  <p className="text-sm font-bold text-orange-600">{fmtMoney(advancePerDay)}</p>
                </div>
                <div className="bg-white rounded-xl p-2">
                  <p className="text-[11px] text-gray-400">Held/day</p>
                  <p className="text-sm font-bold text-gray-800">{fmtMoney(heldPerDay)}</p>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">
                  Earned this {word}
                  <span className="text-gray-400"> · {periodWorkerDays} worker-day{periodWorkerDays === 1 ? "" : "s"}</span>
                </p>
                <p className="text-sm font-semibold text-gray-700">{fmtMoney(periodEarned)}</p>
              </div>
              {periodAdvancePaid > 0 && (
                <div className="flex items-center justify-between mt-1">
                  <p className="text-xs text-gray-500">Advances paid this {word}</p>
                  <p className="text-sm font-medium text-orange-600">− {fmtMoney(periodAdvancePaid)}</p>
                </div>
              )}
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-700">Due to pay at {when}</p>
                <p className="text-base font-bold text-primary">{fmtMoney(periodDue)}</p>
              </div>
            </div>
            <p className="text-[11px] text-orange-700/80 leading-snug">
              The owner sees this total and settles it at {when}. To change the schedule, the owner edits this work group.
            </p>
          </div>
        )}

        {isHourly && (
          <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm">
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Hours worked today</label>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setHours((v) => String(Math.max(0.5, (parseFloat(v) || 8) - 0.5)))}
                className="w-10 h-10 rounded-xl bg-gray-100 text-gray-600 font-bold text-lg"
              >−</button>
              <input
                type="number"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                className="flex-1 text-center text-lg font-bold border border-gray-200 rounded-xl h-10"
              />
              <button
                onClick={() => setHours((v) => String((parseFloat(v) || 8) + 0.5))}
                className="w-10 h-10 rounded-xl bg-gray-100 text-gray-600 font-bold text-lg"
              >+</button>
            </div>
          </div>
        )}

        {/* Two ways to take attendance — side by side so it's obvious which to use */}
        <div>
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">
            How to take attendance
          </p>
          <div className="grid grid-cols-2 gap-3">
            {/* Column 1: Single face — regular daily workers */}
            <div className="bg-white rounded-2xl p-3.5 border-2 border-accent/10 shadow-sm flex flex-col">
              <div className="h-9 w-9 rounded-xl bg-accent/10 flex items-center justify-center mb-2">
                <ScanFace className="h-5 w-5 text-accent" />
              </div>
              <p className="font-semibold text-gray-900 text-sm leading-tight">Single Face Attendance</p>
              <p className="text-[11px] text-gray-500 leading-snug mt-1 flex-1">
                Regular workers who come daily. Each person shows their face — marked one by one.
              </p>
              <Button
                onClick={() => setShowFaceScan(true)}
                className="w-full h-10 mt-2.5 bg-accent hover:bg-accent/90 rounded-xl text-sm"
              >
                <ScanFace className="h-4 w-4 mr-1.5" /> Scan face
              </Button>
            </div>

            {/* Column 2: Group photo — gangs coming & going */}
            <div className="bg-white rounded-2xl p-3.5 border-2 border-purple-100 shadow-sm flex flex-col">
              <div className="h-9 w-9 rounded-xl bg-purple-100 flex items-center justify-center mb-2">
                <Sparkles className="h-5 w-5 text-purple-600" />
              </div>
              <p className="font-semibold text-gray-900 text-sm leading-tight">Group Attendance</p>
              <p className="text-[11px] text-gray-500 leading-snug mt-1 flex-1">
                A group that comes, works and goes. One photo of everyone — AI counts the heads.
              </p>
              <Button
                onClick={() => cameraRef.current?.click()}
                disabled={aiScanning}
                className="w-full h-10 mt-2.5 bg-purple-600 hover:bg-purple-700 rounded-xl text-sm"
              >
                {aiScanning ? (
                  <><Loader2 className="h-4 w-4 animate-spin mr-1.5" /> Counting…</>
                ) : (
                  <><Camera className="h-4 w-4 mr-1.5" /> Group photo</>
                )}
              </Button>
            </div>
          </div>
          {aiNote && (
            <p className="text-xs text-purple-700 bg-purple-50 rounded-lg px-3 py-2 leading-snug mt-2">{aiNote}</p>
          )}
          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleScanFile}
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-1">
            <Users className="h-3.5 w-3.5" /> Workers
          </p>
          <p className="text-xs text-gray-500">{fmtMoney(perWorker)} each</p>
        </div>

        {loadingWorkers ? (
          <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : activeWorkers.length === 0 ? (
          <p className="text-sm text-gray-500 py-8 text-center">No workers yet. Ask the owner to add workers.</p>
        ) : (
          <div className="space-y-2">
            {activeWorkers.map((w) => {
              const already = markedIds.has(w.id);
              const isSel = selected.has(w.id);
              return (
                <button
                  key={w.id}
                  disabled={already}
                  onClick={() => toggle(w.id)}
                  className={`w-full rounded-2xl p-3.5 border flex items-center gap-3 text-left transition ${
                    already
                      ? "bg-primary/5 border-primary/20 opacity-80"
                      : isSel
                        ? "bg-primary border-primary"
                        : "bg-white border-gray-100 shadow-sm active:bg-gray-50"
                  }`}
                >
                  <div
                    className={`h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 ${
                      already ? "bg-primary" : isSel ? "bg-white" : "bg-gray-100"
                    }`}
                  >
                    {already || isSel ? (
                      <Check className={`h-5 w-5 ${isSel && !already ? "text-primary" : "text-white"}`} />
                    ) : (
                      <span className="text-sm font-bold text-gray-500">{w.name.charAt(0).toUpperCase()}</span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`font-semibold ${isSel && !already ? "text-white" : "text-gray-900"}`}>{w.name}</p>
                    <p className={`text-xs ${isSel && !already ? "text-primary-foreground/80" : "text-gray-400"}`}>
                      {already
                        ? `Marked present${markedAtByWorker.has(w.id) ? ` · ${fmtMarkedTime(markedAtByWorker.get(w.id)!)}` : ""}`
                        : w.type}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Single face attendance overlay */}
      {showFaceScan && (
        <FaceAttendance
          workers={activeWorkers}
          presentWorkerIds={markedIds}
          onMarkPresent={markOne}
          onClose={() => setShowFaceScan(false)}
        />
      )}

      {/* Sticky save bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-100 p-4 shadow-lg">
          <Button
            className="w-full h-12 bg-primary hover:bg-primary/90 rounded-xl text-base"
            disabled={saving}
            onClick={save}
          >
            {saving ? (
              <Loader2 className="h-5 w-5 animate-spin" />
            ) : (
              `Mark ${selected.size} present · ${fmtMoney((selected.size * perWorker))}`
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function Header({ title, onBack, action }: { title: string; onBack: () => void; action?: React.ReactNode }) {
  return (
    <div className="bg-primary px-3 py-3 flex items-center gap-2 sticky top-0 z-10">
      <button onClick={onBack} className="p-1.5 text-white">
        <ChevronLeft className="h-5 w-5" />
      </button>
      <h1 className="font-bold text-white truncate flex-1">{title}</h1>
      {action}
    </div>
  );
}

function CreateGroupSheet({
  form,
  setForm,
  onClose,
  onSubmit,
  pending,
}: {
  form: NewGroupForm;
  setForm: React.Dispatch<React.SetStateAction<NewGroupForm>>;
  onClose: () => void;
  onSubmit: () => void;
  pending: boolean;
}) {
  const set = (k: keyof NewGroupForm, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const rateVal = parseFloat(form.rate || "0");
  const advanceVal = parseFloat(form.advancePerUnit || "0");
  const heldVal = isNaN(rateVal - advanceVal) ? 0 : Math.max(0, rateVal - advanceVal);

  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end bg-black/40">
      <div className="bg-white rounded-t-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">New work group</h2>
          <button onClick={onClose} aria-label="Close"><X className="h-5 w-5 text-gray-500" /></button>
        </div>

        <div>
          <Label className="text-xs text-gray-500">Work name *</Label>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Coffee pruning – Block A"
            className="mt-1"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-gray-500">Number of workers</Label>
            <Input
              value={form.expectedWorkers}
              onChange={(e) => set("expectedWorkers", e.target.value)}
              type="number"
              inputMode="numeric"
              placeholder="e.g. 10"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs text-gray-500">Block / Area</Label>
            <Input
              value={form.blockName}
              onChange={(e) => set("blockName", e.target.value)}
              placeholder="e.g. Block A"
              className="mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-gray-500">Work category</Label>
            <Select value={form.category} onValueChange={(v) => set("category", v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-gray-500">Labour type</Label>
            <Select value={form.labourType} onValueChange={(v) => set("labourType", v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {LABOUR_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="text-xs text-gray-500">Payment type</Label>
            <Select value={form.paymentType} onValueChange={(v) => set("paymentType", v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAYMENT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-gray-500">Rate ({curSymbol()}) *</Label>
            <Input
              value={form.rate}
              onChange={(e) => set("rate", e.target.value)}
              type="number"
              inputMode="decimal"
              placeholder="450"
              className="mt-1"
            />
          </div>
        </div>

        <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 space-y-3">
          <p className="text-xs font-semibold text-orange-700">Advance payment (optional)</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-gray-500">Advance per day ({curSymbol()})</Label>
              <Input
                value={form.advancePerUnit}
                onChange={(e) => set("advancePerUnit", e.target.value)}
                type="number"
                inputMode="decimal"
                placeholder="e.g. 200"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs text-gray-500">Amount held ({curSymbol()})</Label>
              <div className="mt-1 flex h-9 items-center rounded-md border border-input bg-gray-50 px-3 text-sm text-gray-500">
                {heldVal > 0 ? `${fmtMoney(heldVal)}` : "—"}
              </div>
            </div>
          </div>
          <div>
            <Label className="text-xs text-gray-500">Pay advance every</Label>
            <Select value={form.payFrequency} onValueChange={(v) => set("payFrequency", v)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PAY_FREQUENCIES.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <p className="text-xs text-gray-400 text-center">Requires internet to save.</p>
        <Button
          onClick={onSubmit}
          disabled={pending}
          className="w-full bg-primary hover:bg-primary/90 text-white rounded-xl h-12"
        >
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save work group"}
        </Button>
      </div>
    </div>
  );
}
