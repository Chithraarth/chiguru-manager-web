import { useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";

interface QrScannerProps {
  onScan: (text: string) => void;
  onError?: (message: string) => void;
}

export function QrScanner({ onScan, onError }: QrScannerProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const handledRef = useRef(false);

  useEffect(() => {
    const id = "qr-reader-region";
    if (!elRef.current) return;
    elRef.current.id = id;

    const scanner = new Html5Qrcode(id, { verbose: false });
    scannerRef.current = scanner;
    let cancelled = false;

    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 220, height: 220 } },
        (decodedText) => {
          if (handledRef.current) return;
          handledRef.current = true;
          onScan(decodedText);
        },
        () => {
          // per-frame decode failures are normal; ignore
        }
      )
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        onError?.(msg);
      });

    return () => {
      cancelled = true;
      const s = scannerRef.current;
      if (s) {
        s.stop()
          .then(() => s.clear())
          .catch(() => {
            /* already stopped */
          });
      }
    };
  }, [onScan, onError]);

  return <div ref={elRef} className="w-full overflow-hidden rounded-2xl bg-black" />;
}
