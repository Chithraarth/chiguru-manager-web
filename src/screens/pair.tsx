import { useEffect, useRef, useState } from "react";
import { Loader2, Sprout } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sendPhoneOtp, type ConfirmationResult } from "@/lib/firebase";
import { DIAL_CODES, flagEmoji } from "@/lib/dial-codes";

const RESEND_SECONDS = 60;

// Signing in here just proves this device controls the phone number — the
// actual "was this manager invited by an owner" check happens server-side
// (firebaseAuthMiddleware) on the very next authenticated request. App.tsx's
// onAuthStateChanged listener picks up the resulting sign-in automatically;
// this screen doesn't need an onPaired callback.
export function PairScreen() {
  const [dialCode, setDialCode] = useState("+91");
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendIn, setResendIn] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  function startResendCountdown() {
    setResendIn(RESEND_SECONDS);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      setResendIn((s) => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }

  async function sendOtp() {
    if (!phone.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      const result = await sendPhoneOtp(`${dialCode}${phone.trim()}`, "recaptcha-container");
      setConfirmation(result);
      startResendCountdown();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Firebase:\s*/, "") : "Could not send OTP");
    } finally {
      setVerifying(false);
    }
  }

  async function verifyOtp() {
    if (!confirmation || !otp.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      await confirmation.confirm(otp.trim());
      // Firebase sign-in succeeded — App.tsx's auth-state listener takes it
      // from here (it will 401 on /manager/me if this phone wasn't invited).
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Firebase:\s*/, "") : "Invalid code");
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="min-h-dvh flex items-center justify-center bg-linear-to-b from-primary/5 to-white px-4 py-8">
      <div className="w-full max-w-md space-y-5">
        <div className="flex flex-col items-center text-center">
          <div className="h-16 w-16 rounded-2xl bg-primary flex items-center justify-center shadow-lg">
            <Sprout className="h-9 w-9 text-white" />
          </div>
          <h1 className="text-xl font-bold text-gray-900 mt-4">Manager sign-in</h1>
          <p className="text-sm text-gray-500 mt-1 leading-relaxed max-w-xs">
            Sign in with the phone number the farm owner added you with, to mark
            attendance and post daily work updates.
          </p>
        </div>

        {!confirmation ? (
          <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">Mobile number</label>
              <div className="flex gap-2">
                <select
                  value={dialCode}
                  onChange={(e) => setDialCode(e.target.value)}
                  className="rounded-xl h-11 border border-input bg-transparent px-2 text-sm shrink-0 max-w-28 truncate"
                  aria-label="Country code"
                >
                  {DIAL_CODES.map((d) => (
                    <option key={`${d.iso2}-${d.dial}`} value={d.dial}>
                      {flagEmoji(d.iso2)} {d.name} ({d.dial})
                    </option>
                  ))}
                </select>
                <Input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="98765 43210"
                  className="rounded-xl h-11 flex-1"
                />
              </div>
            </div>
            <Button
              className="w-full h-11 bg-primary hover:bg-primary/90 rounded-xl text-base"
              disabled={verifying || !phone.trim()}
              onClick={sendOtp}
            >
              {verifying ? <Loader2 className="h-5 w-5 animate-spin" /> : "Send OTP"}
            </Button>
          </div>
        ) : (
          <div className="bg-white rounded-2xl p-4 border border-gray-100 shadow-sm space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 uppercase block mb-1.5">
                Enter the OTP sent to {dialCode}{phone}
              </label>
              <Input
                type="text"
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                className="rounded-xl h-11 text-center text-lg font-bold tracking-[0.2em]"
                autoFocus
              />
            </div>
            <Button
              className="w-full h-11 bg-primary hover:bg-primary/90 rounded-xl text-base"
              disabled={verifying || !otp.trim()}
              onClick={verifyOtp}
            >
              {verifying ? <Loader2 className="h-5 w-5 animate-spin" /> : "Verify & continue"}
            </Button>
            <button
              onClick={sendOtp}
              disabled={verifying || resendIn > 0}
              className="w-full text-center text-sm font-medium text-primary disabled:text-gray-400"
            >
              {resendIn > 0 ? `Resend OTP in ${resendIn}s` : "Resend OTP"}
            </button>
          </div>
        )}

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        <div id="recaptcha-container" />
      </div>
    </div>
  );
}
