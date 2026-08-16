import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft, ChevronRight as ChevronRightIcon, Loader2, CheckCircle2, Circle,
  FlaskConical, SprayCan, Droplets, Scissors, Wheat, Wrench,
} from "lucide-react";
import { apiFetch } from "@/lib/api";

interface PlanTask {
  id: number;
  cropId: number | null;
  month: string; // YYYY-MM
  day: number | null;
  title: string;
  details: string | null;
  category: string;
  done: boolean;
}
interface Crop { id: number; name: string }

const CAT_ICON: Record<string, typeof FlaskConical> = {
  fertilizer: FlaskConical,
  spray: SprayCan,
  irrigation: Droplets,
  pruning: Scissors,
  harvest: Wheat,
  other: Wrench,
};

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/**
 * Read-only view of the owner's Year Plan so the manager knows what work is
 * scheduled. The owner writes the plan in the main app; this device only reads
 * it (recording actual work still happens via Work Update).
 */
export function PlanScreen({
  activeEstateId,
  onBack,
}: {
  activeEstateId: string | null;
  onBack: () => void;
}) {
  const thisMonth = monthKey(new Date());
  const [selMonth, setSelMonth] = useState(thisMonth);

  // Estate id is in the query key: GET /plan-tasks and /crops are server-side
  // scoped by X-Estate-Id, so switching estates must refetch (not reuse
  // another estate's cached plan).
  const { data: tasks = [], isLoading } = useQuery<PlanTask[]>({
    queryKey: ["plan-tasks", activeEstateId],
    queryFn: () => apiFetch("/plan-tasks"),
  });
  const { data: crops = [] } = useQuery<Crop[]>({
    queryKey: ["crops", activeEstateId],
    queryFn: () => apiFetch("/crops"),
  });
  const cropName = (id: number | null) => crops.find((c) => c.id === id)?.name;

  const months = useMemo(() => {
    const set = new Set(tasks.map((x) => x.month));
    set.add(thisMonth);
    return [...set].sort();
  }, [tasks, thisMonth]);
  const idx = months.indexOf(selMonth);
  const canPrev = idx > 0;
  const canNext = idx >= 0 && idx < months.length - 1;

  const byDay = (a: PlanTask, b: PlanTask) => (a.day ?? 99) - (b.day ?? 99);
  const monthTasks = tasks.filter((x) => x.month === selMonth).sort(byDay);
  const pending = monthTasks.filter((x) => !x.done);
  const done = monthTasks.filter((x) => x.done);
  // Unfinished work from earlier months follows into the current month.
  const overdue = selMonth === thisMonth ? tasks.filter((x) => !x.done && x.month < thisMonth) : [];

  const renderTask = (task: PlanTask, tag?: string) => {
    const Icon = CAT_ICON[task.category] ?? Wrench;
    return (
      <div key={task.id} className={`bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex gap-3 ${task.done ? "opacity-60" : ""}`}>
        {task.done
          ? <CheckCircle2 className="h-5 w-5 text-primary flex-shrink-0 mt-0.5" />
          : <Circle className="h-5 w-5 text-gray-300 flex-shrink-0 mt-0.5" />}
        <div className="min-w-0 flex-1">
          {tag && (
            <span className="inline-block text-[11px] font-medium text-orange-700 bg-orange-100 px-2 py-0.5 rounded-full mb-1">
              Left over from {monthLabel(task.month)}
            </span>
          )}
          <p className={`font-semibold text-gray-900 leading-snug ${task.done ? "line-through" : ""}`}>
            {task.day != null && (
              <span className="inline-flex items-center justify-center min-w-6 h-6 px-1 mr-1.5 rounded-md bg-primary/10 text-primary text-xs font-bold align-middle">
                {task.day}
              </span>
            )}
            {task.title}
          </p>
          {task.details && <p className="text-sm text-gray-500 mt-0.5 leading-snug">{task.details}</p>}
          <div className="flex items-center gap-1.5 mt-1.5 text-xs text-gray-500">
            <Icon className="h-3.5 w-3.5 text-primary" />
            <span>{task.cropId != null ? cropName(task.cropId) ?? "" : "Whole farm"}</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="bg-primary px-3 py-3 flex items-center gap-2 sticky top-0 z-10">
        <button onClick={onBack} className="p-1.5 text-white" aria-label="Back">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="font-bold text-white truncate flex-1">Work Plan</h1>
      </div>

      <div className="p-4 space-y-4">
        <p className="text-xs text-gray-500 -mt-1">The owner's month-by-month schedule</p>

        {/* Month pager */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex items-center justify-between px-2 py-2">
          <button
            onClick={() => canPrev && setSelMonth(months[idx - 1])}
            disabled={!canPrev}
            className="p-2 text-primary disabled:opacity-25"
            aria-label="Previous month"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <div className="text-center">
            <p className="font-bold text-gray-900">{monthLabel(selMonth)}</p>
            <p className="text-xs text-gray-500">
              {pending.length + overdue.length > 0
                ? `Pending: ${pending.length + overdue.length}`
                : done.length > 0
                  ? `Completed: ${done.length}`
                  : "No work planned"}
            </p>
          </div>
          <button
            onClick={() => canNext && setSelMonth(months[idx + 1])}
            disabled={!canNext}
            className="p-2 text-primary disabled:opacity-25"
            aria-label="Next month"
          >
            <ChevronRightIcon className="h-6 w-6" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : (
          <>
            {(pending.length > 0 || overdue.length > 0) && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Pending works</p>
                {overdue.map((x) => renderTask(x, "overdue"))}
                {pending.map((x) => renderTask(x))}
              </div>
            )}
            {done.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Completed</p>
                {done.map((x) => renderTask(x))}
              </div>
            )}
            {monthTasks.length === 0 && overdue.length === 0 && (
              <p className="text-sm text-gray-500 text-center py-8">No work planned for this month.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
