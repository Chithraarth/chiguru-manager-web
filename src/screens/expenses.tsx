import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft, Plus, Camera, Image as ImageIcon, X, Loader2, Upload,
  Banknote, Wifi, WifiOff, ReceiptText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { apiFetch, apiPost, checkManagerSession } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import type { Pairing } from "@/lib/pairing";
import { fmtMoney, curSymbol } from "@/lib/currency";

interface Expense {
  id: number; date: string; cropId?: number | null; cropName?: string | null;
  category: string; amount: number | string; description?: string | null;
  vendor?: string | null; hasReceipt?: boolean;
}
interface Crop { id: number; name: string }

// Same list the owner's app uses so categories line up across both devices.
const CATEGORIES = [
  "Fertilizer", "Pesticide", "Fungicide", "Seeds / Seedlings",
  "Labour", "Equipment", "Fuel", "Water / Irrigation",
  "Transport", "Storage", "Electricity", "Other",
];

const TODAY = new Date().toISOString().slice(0, 10);

function fmt(n: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 0,
  }).format(n);
}

// Shrink a receipt photo before upload: max 1200px keeps the bill text legible
// while staying under the server's ~500KB cap. Drop quality once more if the
// first pass is still too big; give up (reject) only when even that fails.
function compressImage(file: File, maxSize = 1200, quality = 0.7): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new window.Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          const scale = maxSize / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) { reject(new Error("canvas")); return; }
        ctx.drawImage(img, 0, 0, width, height);
        let out = canvas.toDataURL("image/jpeg", quality);
        if (out.length > 650_000) out = canvas.toDataURL("image/jpeg", 0.5);
        if (out.length > 650_000) { reject(new Error("too-large")); return; }
        resolve(out);
      };
      img.onerror = () => reject(new Error("image"));
      img.src = reader.result as string;
    };
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(file);
  });
}

export function ExpenseScreen({
  pairing,
  activeEstateId,
  onBack,
  onRevoked,
}: {
  pairing: Pairing;
  activeEstateId: string | null;
  onBack: () => void;
  onRevoked: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const [showForm, setShowForm] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Form state
  const [date, setDate] = useState(TODAY);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("Fertilizer");
  const [customCategory, setCustomCategory] = useState("");
  const [cropSel, setCropSel] = useState("");
  const [description, setDescription] = useState("");
  const [vendor, setVendor] = useState("");
  const [billImage, setBillImage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Receipt viewer
  const [viewImage, setViewImage] = useState<string | null>(null);
  const [loadingReceiptId, setLoadingReceiptId] = useState<number | null>(null);

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

  // Estate-scoped reads: the key includes the active estate so switching estates
  // refetches the right folder instead of showing another estate's expenses.
  const { data: expenses = [], isLoading } = useQuery<Expense[]>({
    queryKey: ["expenses", activeEstateId],
    queryFn: () => apiFetch("/expenses"),
    enabled: !!pairing,
  });
  const { data: crops = [] } = useQuery<Crop[]>({
    queryKey: ["crops", activeEstateId],
    queryFn: () => apiFetch("/crops"),
    enabled: !!pairing,
  });

  function resetForm() {
    setDate(TODAY);
    setAmount("");
    setCategory("Fertilizer");
    setCustomCategory("");
    setCropSel("");
    setDescription("");
    setVendor("");
    setBillImage(null);
  }

  async function onBillFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const dataUrl = await compressImage(file);
      setBillImage(dataUrl);
    } catch (err) {
      toast({
        title: err instanceof Error && err.message === "too-large"
          ? "Photo is too large, try again"
          : "Could not read the photo",
        variant: "destructive",
      });
    }
  }

  async function openReceipt(id: number) {
    setLoadingReceiptId(id);
    try {
      const data = await apiFetch<{ receiptUrl: string }>(`/expenses/${id}/receipt`);
      setViewImage(data.receiptUrl);
    } catch {
      toast({ title: "Could not load the bill photo", variant: "destructive" });
    } finally {
      setLoadingReceiptId(null);
    }
  }

  async function submit() {
    const amt = parseFloat(amount);
    if (!amount.trim() || isNaN(amt) || amt <= 0) {
      toast({ title: "Enter the amount spent", variant: "destructive" });
      return;
    }
    // Proof of the spend is the whole point of this feature — the owner isn't
    // there to see it, so a bill photo is required, not optional.
    if (!billImage) {
      toast({
        title: "Bill photo required",
        description: "Add a photo of the bill as proof of this expense.",
        variant: "destructive",
      });
      return;
    }
    // Money records must not be duplicated. Unlike attendance/work-updates the
    // expense POST is not idempotent, so we never queue it offline (a retried
    // upload could create a second expense). Require a live connection instead.
    if (!navigator.onLine) {
      toast({
        title: "No internet",
        description: "An expense needs a connection to save with its photo. Try again when you have signal.",
        variant: "destructive",
      });
      return;
    }

    const finalCategory = category === "Other"
      ? (customCategory.trim() || "Other")
      : category;

    setSaving(true);
    try {
      // Re-check the manager session before writing to the shared farm records,
      // same as attendance/work-updates — removal by the owner locks out.
      const verdict = await checkManagerSession();
      if (verdict === "invalid") {
        onRevoked();
        return;
      }
      if (verdict === "offline") {
        toast({
          title: "No internet",
          description: "Could not reach the server. Try again when you have signal.",
          variant: "destructive",
        });
        return;
      }

      await apiPost("/expenses", {
        date,
        cropId: cropSel ? Number(cropSel) : undefined,
        category: finalCategory,
        amount: amt,
        description: description.trim() || undefined,
        vendor: vendor.trim() || undefined,
        receiptUrl: billImage,
        addedBy: pairing.managerName,
      });
      qc.invalidateQueries({ queryKey: ["expenses", activeEstateId] });
      toast({ title: "Expense saved ✓", description: "The owner can see it now." });
      resetForm();
      setShowForm(false);
    } catch {
      toast({
        title: "Could not save",
        description: "Check your connection and try again — nothing was saved.",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }

  const total = expenses.reduce((s, e) => s + Number(e.amount), 0);
  const grouped = expenses.reduce<Record<string, Expense[]>>((acc, e) => {
    const month = e.date.slice(0, 7);
    (acc[month] ??= []).push(e);
    return acc;
  }, {});

  // ─── Add-expense form ──────────────────────────────────────────────────────
  if (showForm) {
    return (
      <div className="min-h-screen bg-gray-50">
        <div className="bg-orange-600 px-3 py-3 flex items-center gap-2 sticky top-0 z-10">
          <button onClick={() => { resetForm(); setShowForm(false); }} className="p-1.5 text-white">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <h1 className="font-bold text-white flex-1">New Expense</h1>
          <Button
            size="sm"
            className="bg-white/20 hover:bg-white/30 text-white rounded-xl px-4"
            disabled={saving}
            onClick={submit}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Upload className="h-4 w-4 mr-1" /> Save</>}
          </Button>
        </div>

        <div className="p-4 space-y-4">
          <div className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl w-fit ${
            isOnline ? "bg-primary/5 text-primary" : "bg-amber-50 text-amber-700"
          }`}>
            {isOnline ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
            {isOnline ? "Online — saves now" : "Offline — needs internet to save"}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">
              Amount spent ({curSymbol()}) <span className="text-red-500">*</span>
            </label>
            <div className="relative">
              <Banknote className="h-4 w-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <Input
                type="number"
                min="0"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                className="rounded-xl text-sm pl-9"
              />
            </div>
          </div>

          {/* Category */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">
              What was it for? <span className="text-red-500">*</span>
            </label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="rounded-xl text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {category === "Other" && (
              <Input
                value={customCategory}
                onChange={(e) => setCustomCategory(e.target.value)}
                placeholder="Type the category"
                className="rounded-xl text-sm mt-2"
                maxLength={40}
              />
            )}
          </div>

          {/* Date */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Date</label>
            <Input
              type="date"
              value={date}
              max={TODAY}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-xl text-sm"
            />
          </div>

          {/* Crop (optional) */}
          {crops.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Crop (optional)</label>
              <Select value={cropSel || "__none__"} onValueChange={(v) => setCropSel(v === "__none__" ? "" : v)}>
                <SelectTrigger className="rounded-xl text-sm">
                  <SelectValue placeholder="Not linked to a crop" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Not linked to a crop</SelectItem>
                  {crops.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Vendor (optional) */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Shop / Vendor (optional)</label>
            <Input
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              placeholder="e.g. Sri Balaji Agro"
              className="rounded-xl text-sm"
              maxLength={120}
            />
          </div>

          {/* Description (optional) */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Note (optional)</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Any detail about this spend…"
              className="rounded-xl text-sm min-h-[60px]"
            />
          </div>

          {/* Bill photo — required proof */}
          <div>
            <label className="text-xs font-semibold text-gray-500 uppercase block mb-2">
              Bill photo <span className="text-red-500">*</span>
              <span className="ml-1 normal-case font-normal text-gray-400">— proof of the spend</span>
            </label>
            {billImage ? (
              <div className="relative">
                <img src={billImage} alt="bill" className="w-full rounded-2xl object-cover max-h-72" />
                <button
                  onClick={() => setBillImage(null)}
                  className="absolute top-2 right-2 bg-black/50 text-white rounded-full p-1"
                  aria-label="Remove photo"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => cameraRef.current?.click()}
                  className="flex flex-col items-center gap-1.5 bg-amber-50 border-2 border-dashed border-amber-200 rounded-2xl py-6 active:bg-amber-100"
                >
                  <Camera className="h-6 w-6 text-amber-500" />
                  <span className="text-xs font-semibold text-amber-700">Take photo</span>
                </button>
                <button
                  onClick={() => galleryRef.current?.click()}
                  className="flex flex-col items-center gap-1.5 bg-gray-50 border-2 border-dashed border-gray-200 rounded-2xl py-6 active:bg-gray-100"
                >
                  <ImageIcon className="h-6 w-6 text-gray-500" />
                  <span className="text-xs font-semibold text-gray-700">From gallery</span>
                </button>
              </div>
            )}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onBillFile} />
            <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={onBillFile} />
          </div>
        </div>
      </div>
    );
  }

  // ─── Expense folder (list) ─────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-orange-600 px-3 py-3 flex items-center gap-2 sticky top-0 z-10">
        <button onClick={onBack} className="p-1.5 text-white">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="font-bold text-white flex-1">Expenses</h1>
      </div>

      <div className="p-4 space-y-4">
        <div className="bg-primary/5 rounded-2xl p-4 border border-primary/10">
          <p className="text-xs text-primary/90 leading-relaxed">
            Record what you spend for the estate, with a photo of each bill. Everything you save here goes straight to the owner's phone.
          </p>
        </div>

        {expenses.length > 0 && (
          <div className="bg-orange-50 rounded-xl p-4 border border-orange-100">
            <p className="text-xs text-orange-600 font-medium">Total expenses</p>
            <p className="text-2xl font-bold text-orange-700 mt-0.5">{fmt(total)}</p>
          </div>
        )}

        {expenses.length > 0 && (
          <div className="flex justify-center">
            <Button
              onClick={() => { resetForm(); setShowForm(true); }}
              className="bg-orange-600 hover:bg-orange-700 text-white rounded-xl px-6"
            >
              <Plus className="h-4 w-4 mr-1.5" /> Add expense
            </Button>
          </div>
        )}

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : expenses.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <ReceiptText className="h-12 w-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No expenses yet</p>
            <Button onClick={() => { resetForm(); setShowForm(true); }} className="mt-4 bg-orange-600 hover:bg-orange-700 text-white">
              <Plus className="h-4 w-4 mr-1" /> Add expense
            </Button>
          </div>
        ) : (
          Object.entries(grouped).sort(([a], [b]) => b.localeCompare(a)).map(([month, items]) => (
            <div key={month}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-gray-500 uppercase">
                  {new Date(month + "-01").toLocaleDateString("en-IN", { month: "long", year: "numeric" })}
                </p>
                <p className="text-xs font-semibold text-orange-600">
                  {fmt(items.reduce((s, e) => s + Number(e.amount), 0))}
                </p>
              </div>
              <div className="space-y-2">
                {items.map((e) => (
                  <div key={e.id} className="bg-white rounded-xl px-4 py-3 flex items-center gap-3 shadow-sm border border-gray-100">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">{e.category}</span>
                        {e.cropName && <span className="text-xs text-gray-400">{e.cropName}</span>}
                      </div>
                      <p className="text-sm text-gray-700 mt-0.5 truncate">{e.description || e.category}</p>
                      <p className="text-xs text-gray-400">{e.date}{e.vendor ? ` · ${e.vendor}` : ""}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {e.hasReceipt && (
                        <button
                          onClick={() => openReceipt(e.id)}
                          disabled={loadingReceiptId === e.id}
                          className="shrink-0 h-9 w-9 rounded-lg bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600"
                          aria-label="View bill photo"
                        >
                          {loadingReceiptId === e.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Camera className="h-4 w-4" />}
                        </button>
                      )}
                      <span className="font-bold text-gray-800">{fmt(Number(e.amount))}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Receipt viewer */}
      {viewImage && (
        <div
          className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
          onClick={() => setViewImage(null)}
        >
          <button className="absolute top-4 right-4 text-white" aria-label="Close">
            <X className="h-7 w-7" />
          </button>
          <img src={viewImage} alt="bill" className="max-w-full max-h-full rounded-xl object-contain" />
        </div>
      )}
    </div>
  );
}
