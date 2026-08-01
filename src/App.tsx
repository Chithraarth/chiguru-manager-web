import { useCallback, useEffect, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Loader2, Sprout } from "lucide-react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";
import {
  apiFetch,
  getActiveEstateId,
  setActiveEstateId,
  checkManagerSession,
  type Estate,
  type ManagerMe,
} from "@/lib/api";
import { flushAll, getPendingCount } from "@/lib/offline-db";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PairScreen } from "@/screens/pair";
import { HomeScreen } from "@/screens/home";
import { AttendanceScreen } from "@/screens/attendance";
import { WorkUpdateScreen } from "@/screens/work-update";
import { ExpenseScreen } from "@/screens/expenses";
import { getPairing, savePairing, clearPairing, type Pairing } from "@/lib/pairing";
import { auth, onAuthStateChanged, signOutUser } from "@/lib/firebase";
import { refreshCurrency } from "@/lib/currency";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 1000 * 30, retry: 1 },
  },
});

type Screen = "home" | "attendance" | "work-update" | "expense";

function AppInner() {
  const { toast } = useToast();
  const [pairing, setPairing] = useState<Pairing | null>(() => getPairing());
  const [signedIn, setSignedIn] = useState(false);
  const [screen, setScreen] = useState<Screen>("home");
  const [activeEstateId, setActiveEstate] = useState<string | null>(() => getActiveEstateId());
  const [confirmExit, setConfirmExit] = useState(false);
  const [checking, setChecking] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState<boolean>(() => navigator.onLine);
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(() => {
    const raw = localStorage.getItem("manager_last_sync_time");
    return raw ? new Date(raw) : null;
  });

  // The owner's estates (each a farm_profile row). The manager picks which one
  // this device records for; every API call then carries its id as X-Estate-Id.
  const { data: estates = [] } = useQuery<Estate[]>({
    queryKey: ["estates"],
    queryFn: () => apiFetch("/estates"),
    enabled: signedIn,
  });

  // Pick a sane active estate once the list loads: keep the stored one if it's
  // still valid, otherwise fall back to the first estate. This also self-heals
  // when the owner deletes the estate this device was pointed at.
  useEffect(() => {
    if (estates.length === 0) return;
    const stillValid = activeEstateId != null && estates.some((e) => String(e.id) === activeEstateId);
    if (!stillValid) {
      const first = String(estates[0].id);
      setActiveEstateId(first);
      setActiveEstate(first);
    }
  }, [estates, activeEstateId]);

  // Keep the farm's currency in sync (owner sets it in the main app). Cached
  // locally so offline sessions still format money correctly.
  useEffect(() => {
    if (pairing && activeEstateId != null) void refreshCurrency();
  }, [pairing, activeEstateId]);

  function handleSwitchEstate(id: number) {
    const next = String(id);
    setActiveEstateId(next);
    setActiveEstate(next);
    // Drop cached estate-scoped data so each screen refetches for the new estate.
    queryClient.invalidateQueries();
  }

  // Rename an estate from the manager device. This edits the owner's farm_profile
  // row directly (PATCH /estates/:id), so the owner sees the new name too. Needs a
  // connection — name edits aren't queued offline like field records are — so we
  // report failure clearly and keep the dialog open instead of silently dropping it.
  async function handleRenameEstate(id: number, farmName: string): Promise<boolean> {
    try {
      await apiFetch(`/estates/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ farmName }),
      });
      await queryClient.invalidateQueries({ queryKey: ["estates"] });
      toast({ title: "Estate renamed", description: `Now called "${farmName}".` });
      return true;
    } catch {
      toast({
        title: "Could not rename",
        description: "Check your connection and try again.",
        variant: "destructive",
      });
      return false;
    }
  }

  const refreshPending = useCallback(() => {
    getPendingCount()
      .then(setPendingCount)
      .catch(() => {});
  }, []);

  // Flush queued work to the owner. Runs automatically (mount, "online" event)
  // and on demand from the home-screen "Sync now" button (manual=true). Field
  // phones drop signal constantly, so this is the safety net that turns "saved
  // on phone" into "the owner can see it".
  const runSync = useCallback(
    async ({ manual = false }: { manual?: boolean } = {}) => {
      if (!signedIn) return;
      // Automatic sync trusts navigator.onLine and skips when offline. The
      // manual emergency button tries anyway — navigator.onLine is unreliable
      // on rural/captive networks, so we let the actual fetch decide.
      setIsOnline(navigator.onLine);
      if (!manual && !navigator.onLine) {
        refreshPending();
        return;
      }
      if (manual) setSyncing(true);
      try {
        // Enforce the manager lifecycle on replay too: queued records must NOT
        // upload after the owner removed this manager. Only a definitive
        // rejection signs the device out — a connectivity hiccup just waits.
        const verdict = await checkManagerSession();
        if (verdict === "invalid") {
          handleRevoked();
          return;
        }
        if (verdict !== "valid") {
          refreshPending();
          if (manual) {
            toast({
              title: "Still no connection",
              description: "Your data is safe on this phone. Try again when you have signal.",
              variant: "destructive",
            });
          }
          return;
        }
        const flushed = await flushAll();
        refreshPending();
        setIsOnline(true);
        // null = another sync is already in flight (single-flight guard). Skip
        // the "up to date" claim so a manual tap during an auto-sync isn't
        // misleading; the in-flight run will report its own result.
        if (flushed === null) {
          if (manual) {
            toast({
              title: "Sync in progress",
              description: "Already uploading — hang tight.",
            });
          }
          return;
        }
        const now = new Date();
        localStorage.setItem("manager_last_sync_time", now.toISOString());
        setLastSyncTime(now);
        if (flushed > 0) {
          toast({
            title: `${flushed} update${flushed === 1 ? "" : "s"} uploaded`,
            description: "Records saved offline are now with the owner.",
          });
        } else if (manual) {
          toast({
            title: "Everything is up to date",
            description: "Nothing was waiting to upload.",
          });
        }
      } catch {
        if (manual) {
          toast({
            title: "Could not sync",
            description: "Could not reach the server. Try again shortly.",
            variant: "destructive",
          });
        }
      } finally {
        if (manual) setSyncing(false);
      }
    },
    [toast, refreshPending, signedIn],
  );

  // Keep the "saved offline" badge fresh and auto-sync when the network returns.
  useEffect(() => {
    refreshPending();
    void runSync();
    const onOnline = () => void runSync();
    const goOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", goOffline);
    window.addEventListener("focus", refreshPending);
    const interval = window.setInterval(refreshPending, 5000);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("focus", refreshPending);
      window.clearInterval(interval);
    };
  }, [runSync, refreshPending]);

  // Firebase persists sign-in across reloads; on every auth-state change we
  // confirm with the server that this phone is still an active manager (the
  // owner may have removed them since the last session) and fetch their
  // name/farm. A connectivity failure must NOT sign the device out — only a
  // real 401 rejection does.
  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        if (!active) return;
        setSignedIn(false);
        setPairing(null);
        clearPairing();
        setChecking(false);
        return;
      }
      apiFetch<ManagerMe>("/manager/me")
        .then((me) => {
          if (!active) return;
          const p: Pairing = { farmName: me.farmName, managerName: me.name };
          savePairing(p);
          setPairing(p);
          setSignedIn(true);
          setChecking(false);
        })
        .catch((err) => {
          if (!active) return;
          const invalid = err instanceof Error && /→ 401/.test(err.message);
          if (invalid) {
            void signOutUser();
            clearPairing();
            setPairing(null);
            setSignedIn(false);
            toast({
              title: "This device was signed out",
              description: "The owner removed this manager, or this number isn't invited yet.",
              variant: "destructive",
            });
          } else {
            // Offline — trust the cached pairing (if any) and let runSync's
            // own retries reconcile once connectivity returns.
            setSignedIn(getPairing() != null);
          }
          setChecking(false);
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [toast]);

  function handleExit() {
    void signOutUser();
    clearPairing();
    setPairing(null);
    setSignedIn(false);
    setScreen("home");
    setConfirmExit(false);
  }

  function handleRevoked() {
    void signOutUser();
    clearPairing();
    setPairing(null);
    setSignedIn(false);
    setScreen("home");
    toast({
      title: "This device was signed out",
      description: "The owner removed this manager. Sign in again if this was a mistake.",
      variant: "destructive",
    });
  }

  if (checking) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-primary/5 to-white flex flex-col items-center justify-center gap-3">
        <div className="h-14 w-14 rounded-2xl bg-primary flex items-center justify-center shadow-lg">
          <Sprout className="h-8 w-8 text-white" />
        </div>
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <>
        {!signedIn || !pairing ? (
          <PairScreen />
        ) : screen === "attendance" ? (
          <AttendanceScreen pairing={pairing} activeEstateId={activeEstateId} onBack={() => setScreen("home")} onRevoked={handleRevoked} onRecorded={() => void runSync()} />
        ) : screen === "work-update" ? (
          <WorkUpdateScreen pairing={pairing} onBack={() => setScreen("home")} onRevoked={handleRevoked} onRecorded={() => void runSync()} />
        ) : screen === "expense" ? (
          <ExpenseScreen pairing={pairing} activeEstateId={activeEstateId} onBack={() => setScreen("home")} onRevoked={handleRevoked} />
        ) : (
          <HomeScreen
            pairing={pairing}
            estates={estates}
            activeEstateId={activeEstateId}
            onSwitchEstate={handleSwitchEstate}
            onRenameEstate={handleRenameEstate}
            pendingCount={pendingCount}
            isOnline={isOnline}
            lastSyncTime={lastSyncTime}
            syncing={syncing}
            onSync={() => runSync({ manual: true })}
            onAttendance={() => setScreen("attendance")}
            onWorkUpdate={() => setScreen("work-update")}
            onExpense={() => setScreen("expense")}
            onExit={() => setConfirmExit(true)}
          />
        )}

        <AlertDialog open={confirmExit} onOpenChange={setConfirmExit}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unpair this device?</AlertDialogTitle>
              <AlertDialogDescription>
                You will need to scan the QR or enter the farm code again to use this device.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Stay paired</AlertDialogCancel>
              <AlertDialogAction onClick={handleExit}>Unpair</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AppInner />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
