import { useState } from "react";
import { ClipboardCheck, Camera, ChevronRight, LogOut, Sprout, CloudUpload, CheckCircle2, WifiOff, Check, ChevronDown, RefreshCw, Loader2, Pencil, ReceiptText } from "lucide-react";
import type { Pairing } from "@/lib/pairing";
import type { Estate } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface HomeProps {
  pairing: Pairing;
  estates: Estate[];
  activeEstateId: string | null;
  onSwitchEstate: (id: number) => void;
  onRenameEstate: (id: number, farmName: string) => Promise<boolean>;
  pendingCount: number;
  isOnline: boolean;
  lastSyncTime: Date | null;
  syncing: boolean;
  onSync: () => void;
  onAttendance: () => void;
  onWorkUpdate: () => void;
  onExpense: () => void;
  onExit: () => void;
}

export function HomeScreen({ pairing, estates, activeEstateId, onSwitchEstate, onRenameEstate, pendingCount, isOnline, lastSyncTime, syncing, onSync, onAttendance, onWorkUpdate, onExpense, onExit }: HomeProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Estate | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);

  function openRename(e: Estate) {
    setSwitcherOpen(false);
    setRenameValue(e.farmName);
    setRenameTarget(e);
  }

  async function submitRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) return;
    setSavingRename(true);
    try {
      const ok = await onRenameEstate(renameTarget.id, name);
      if (ok) setRenameTarget(null);
    } finally {
      setSavingRename(false);
    }
  }
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const syncedAt = lastSyncTime
    ? lastSyncTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : null;

  const activeEstate = estates.find((e) => String(e.id) === activeEstateId);
  // Until the estates list loads (or on legacy installs), fall back to the farm
  // name captured at pairing time so the header is never blank.
  const estateName = activeEstate?.farmName ?? pairing.farmName;
  const canSwitch = estates.length > 1;
  // The menu is useful even with a single estate: the manager can rename it. So
  // it opens whenever the estate list has loaded, not only when there are 2+.
  const canOpenMenu = estates.length > 0;

  return (
    <div className="min-h-screen bg-gradient-to-b from-primary/5 to-white">
      {/* Header */}
      <div className="bg-primary text-white px-5 pt-10 pb-6 rounded-b-3xl">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
              <Sprout className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="text-xs text-primary-foreground/80">Manager device</p>
              <div className="relative">
                <button
                  onClick={() => canOpenMenu && setSwitcherOpen((v) => !v)}
                  className={`flex items-center gap-1 font-bold leading-tight max-w-full ${canOpenMenu ? "active:opacity-80" : "cursor-default"}`}
                  aria-label={canOpenMenu ? "Estate options" : undefined}
                >
                  <span className="truncate capitalize">{estateName}</span>
                  {canOpenMenu && <ChevronDown className={`h-4 w-4 flex-shrink-0 transition-transform ${switcherOpen ? "rotate-180" : ""}`} />}
                </button>
              </div>
            </div>
          </div>
          <button onClick={onExit} className="p-2 text-primary-foreground/80 hover:text-white flex-shrink-0" aria-label="Exit">
            <LogOut className="h-5 w-5" />
          </button>
        </div>

        {/* Estate menu — each estate has its own work groups, attendance and
            updates, so the manager picks which one this device records for.
            Tapping the name switches; the pencil renames (the owner sees the new
            name too). Shown whenever the estate list has loaded so a single-estate
            farm can still rename. */}
        {switcherOpen && canOpenMenu && (
          <div className="mt-3 bg-white rounded-2xl shadow-lg overflow-hidden">
            <p className="px-4 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {canSwitch ? "Choose or rename an estate" : "Your estate"}
            </p>
            {estates.map((e) => {
              const isActive = String(e.id) === activeEstateId;
              return (
                <div
                  key={e.id}
                  className={`flex items-center border-b border-gray-50 last:border-b-0 ${isActive ? "bg-primary/5" : ""}`}
                >
                  <button
                    onClick={() => {
                      onSwitchEstate(e.id);
                      setSwitcherOpen(false);
                    }}
                    className="flex-1 min-w-0 flex items-center justify-between px-4 py-3 text-left active:bg-gray-50"
                  >
                    <span className={`text-sm font-medium truncate capitalize ${isActive ? "text-primary" : "text-gray-800"}`}>{e.farmName}</span>
                    {isActive && <Check className="h-4 w-4 text-primary flex-shrink-0 ml-2" />}
                  </button>
                  <button
                    onClick={() => openRename(e)}
                    className="px-4 py-3 text-gray-400 active:text-primary flex-shrink-0"
                    aria-label={`Rename ${e.farmName}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <p className="text-primary-foreground/80 text-sm mt-4">Hello, {pairing.managerName} 👋</p>
        <p className="text-primary-foreground/70 text-xs">{today}</p>
        {pendingCount > 0 ? (
          <div className="mt-4 flex items-center gap-2 bg-amber-400/20 border border-amber-300/40 rounded-xl px-3 py-2">
            <CloudUpload className="h-4 w-4 text-amber-100 flex-shrink-0" />
            <p className="text-xs text-amber-50 leading-snug">
              {!isOnline ? "Waiting for network" : "Uploading"} ({pendingCount} item{pendingCount === 1 ? "" : "s"}) — saved on this phone, will upload automatically.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2 bg-white/10 border border-white/20 rounded-xl px-3 py-2">
            {!isOnline ? (
              <WifiOff className="h-4 w-4 text-amber-100 flex-shrink-0" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-primary-foreground/80 flex-shrink-0" />
            )}
            <p className="text-xs text-primary-foreground/90 leading-snug">
              {!isOnline
                ? "Offline — your data is safe on this phone"
                : syncedAt
                ? `Synced at ${syncedAt}`
                : "Connected — everything is up to date"}
            </p>
          </div>
        )}

        {/* Manual sync — for network emergencies, a manager can force-flush the
            offline queue instead of waiting for the automatic triggers. */}
        <button
          onClick={onSync}
          disabled={syncing}
          className="mt-3 w-full flex items-center justify-center gap-2 bg-white/15 active:bg-white/25 border border-white/20 rounded-xl px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
          aria-label="Sync now"
        >
          {syncing ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="h-4 w-4" />
          )}
          {syncing ? "Syncing…" : pendingCount > 0 ? `Sync now (${pendingCount})` : "Sync now"}
        </button>
      </div>

      {/* Actions */}
      <div className="px-5 py-6 space-y-4">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">What do you want to do?</p>

        <button
          onClick={onAttendance}
          className="w-full bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex items-center gap-4 active:bg-gray-50 text-left"
        >
          <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center flex-shrink-0">
            <ClipboardCheck className="h-7 w-7 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-900">Mark Attendance</p>
            <p className="text-sm text-gray-500 leading-snug">Record who is present today</p>
          </div>
          <ChevronRight className="h-5 w-5 text-gray-300 flex-shrink-0" />
        </button>

        <button
          onClick={onWorkUpdate}
          className="w-full bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex items-center gap-4 active:bg-gray-50 text-left"
        >
          <div className="h-14 w-14 rounded-2xl bg-accent/10 flex items-center justify-center flex-shrink-0">
            <Camera className="h-7 w-7 text-accent" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-900">Work Update</p>
            <p className="text-sm text-gray-500 leading-snug">Post a photo and what work was done</p>
          </div>
          <ChevronRight className="h-5 w-5 text-gray-300 flex-shrink-0" />
        </button>

        <button
          onClick={onExpense}
          className="w-full bg-white rounded-2xl p-5 border border-gray-100 shadow-sm flex items-center gap-4 active:bg-gray-50 text-left"
        >
          <div className="h-14 w-14 rounded-2xl bg-orange-100 flex items-center justify-center flex-shrink-0">
            <ReceiptText className="h-7 w-7 text-orange-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-gray-900">Expenses</p>
            <p className="text-sm text-gray-500 leading-snug">Record a spend with a photo of the bill</p>
          </div>
          <ChevronRight className="h-5 w-5 text-gray-300 flex-shrink-0" />
        </button>

        <div className="bg-primary/5 rounded-2xl p-4 border border-primary/10 mt-2">
          <p className="text-xs text-primary/90 leading-relaxed">
            Everything you record here goes straight to <span className="capitalize">{estateName}</span>'s records. The owner sees it instantly.
          </p>
        </div>
      </div>

      <Dialog open={renameTarget != null} onOpenChange={(o) => !o && setRenameTarget(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] rounded-2xl">
          <DialogHeader>
            <DialogTitle>Rename estate</DialogTitle>
            <DialogDescription>
              Change this estate's name. The owner will see the new name too.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitRename();
            }}
            placeholder="Estate name"
            className="capitalize"
            autoFocus
            maxLength={80}
          />
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={savingRename}>
              Cancel
            </Button>
            <Button
              onClick={() => void submitRename()}
              disabled={
                savingRename ||
                renameValue.trim().length === 0 ||
                renameValue.trim() === renameTarget?.farmName
              }
              className="bg-primary hover:bg-primary/90"
            >
              {savingRename ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
