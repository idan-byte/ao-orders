"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ScanState } from "@/app/drive/actions";

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };
type Decode = (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<string | null>;

const COLORS: Record<ScanState["kind"], string> = {
  done: "bg-accent text-surface",
  partial: "bg-[#1d4f91] text-white",
  already: "bg-[#b25e09] text-white",
  refused: "bg-[#b42318] text-white",
};
const SAME_CODE_PAUSE = 3000; // a label held in front of the camera is read once, not ten times a second

/** A decoder for camera frames: the browser's own where it has one, a bundled reader everywhere else (iPhone). */
async function makeDecoder(): Promise<Decode> {
  const Native = (window as unknown as { BarcodeDetector?: { new (o: { formats: string[] }): Detector; getSupportedFormats?: () => Promise<string[]> } }).BarcodeDetector;
  if (Native && ((await Native.getSupportedFormats?.().catch(() => [])) ?? []).includes("qr_code")) {
    const detector = new Native({ formats: ["qr_code"] });
    return async (canvas) => (await detector.detect(canvas).catch(() => []))[0]?.rawValue ?? null;
  }
  // The package is CommonJS; depending on the bundler its function arrives directly or one level down.
  const mod = (await import("jsqr")) as unknown as { default: unknown };
  type Reader = (data: Uint8ClampedArray, width: number, height: number, options?: { inversionAttempts: "dontInvert" }) => { data: string } | null;
  const jsQR = (typeof mod.default === "function" ? mod.default : (mod.default as { default: unknown }).default) as Reader;
  return async (canvas, ctx) => {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}

/**
 * Scanning labels on a route's screen: by the phone's camera, by a handheld scanner that types the code,
 * or by typing the code printed under the QR. Every scan goes to the server, which decides what it means.
 */
export function ScanPanel({ dailyRouteId, mode, scan }: { dailyRouteId: string; mode: "loading" | "unloading"; scan: (dailyRouteId: string, code: string) => Promise<ScanState> }) {
  const [result, setResult] = useState<ScanState | null>(null);
  const [count, setCount] = useState(0);
  const [camera, setCamera] = useState<"off" | "starting" | "on">("off");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const busy = useRef(false);
  const last = useRef({ code: "", at: 0 });

  const send = useCallback(
    async (code: string) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const r = await scan(dailyRouteId, code);
        setResult(r);
        setCount((n) => n + 1);
        navigator.vibrate?.(r.kind === "done" || r.kind === "partial" ? 80 : [200, 100, 200]);
      } catch {
        setResult({ kind: "refused", message: "אין תשובה מהשרת. הסריקה לא נרשמה." });
        setCount((n) => n + 1);
      } finally {
        busy.current = false;
      }
    },
    [dailyRouteId, scan],
  );

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCamera("off");
  }, []);
  useEffect(() => stop, [stop]);

  async function start() {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("המצלמה זמינה רק כשהמערכת נפתחת בכתובת מאובטחת (https). אפשר להקליד את הקוד שמתחת ל-QR.");
      return;
    }
    setCamera("starting");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
    } catch (e) {
      setCamera("off");
      setCameraError((e as DOMException)?.name === "NotAllowedError" ? "הגישה למצלמה נחסמה. יש לאשר אותה בהגדרות הדפדפן, או להקליד את הקוד." : "לא נמצאה מצלמה במכשיר הזה. אפשר להקליד את הקוד.");
      return;
    }
    setCamera("on");
  }

  // The reading loop runs for as long as the camera is on.
  useEffect(() => {
    if (camera !== "on" || !video.current || !stream.current) return;
    const el = video.current;
    el.srcObject = stream.current;
    void el.play().catch(() => {});
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    void makeDecoder().then((decode) => {
      const tick = async () => {
        if (!alive) return;
        if (ctx && el.videoWidth > 0 && !busy.current) {
          const scale = Math.min(1, 800 / el.videoWidth);
          canvas.width = Math.round(el.videoWidth * scale);
          canvas.height = Math.round(el.videoHeight * scale);
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          const code = await decode(canvas, ctx).catch(() => null); // one unreadable frame must not stop the reading
          const now = Date.now();
          if (code && alive && (code !== last.current.code || now - last.current.at > SAME_CODE_PAUSE)) {
            last.current = { code, at: now };
            await send(code);
          } else if (code) last.current.at = now;
        }
        timer = setTimeout(tick, 150);
      };
      void tick();
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      el.srcObject = null;
    };
  }, [camera, send]);

  const shape = "rounded-xl border-2 px-4 py-3 text-lg font-medium";
  const button = `${shape} border-line bg-surface`;
  return (
    <section id="scan" className="rounded-xl border border-line bg-surface p-4" data-camera={camera}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-base font-bold">סריקת מדבקה · {mode === "loading" ? "העמסה" : "מסירה"}</h2>
        {camera === "off" ? (
          <button type="button" id="scan-camera" onClick={start} className={`${shape} border-accent bg-accent text-surface`}>
            סרוק במצלמה
          </button>
        ) : (
          <button type="button" id="scan-stop" onClick={stop} className={button}>
            סגור מצלמה
          </button>
        )}
      </div>
      {camera !== "off" ? (
        <div className="mt-3 overflow-hidden rounded-xl bg-black">
          <video ref={video} playsInline muted className="mx-auto max-h-[50vh] w-full object-contain" />
        </div>
      ) : null}
      {cameraError ? (
        <p role="alert" id="scan-camera-error" className="mt-3 rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
          {cameraError}
        </p>
      ) : null}
      {result ? (
        <div id="scan-result" role="status" aria-live="assertive" data-kind={result.kind} data-count={count} className={`mt-3 rounded-xl px-4 py-3 ${COLORS[result.kind]}`}>
          <div className="text-xl font-bold">
            {result.kind === "done" || result.kind === "partial" ? "✓ " : result.kind === "refused" ? "✕ " : ""}
            {result.message}
          </div>
          {result.detail ? <div className="text-base">{result.detail}</div> : null}
        </div>
      ) : null}
      <form
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const code = typed.trim();
          if (!code) return;
          setTyped("");
          void send(code);
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-muted">
          הקוד שמתחת ל-QR, או סורק ידני
          <input id="scan-input" value={typed} onChange={(e) => setTyped(e.target.value)} dir="ltr" autoComplete="off" autoCapitalize="characters" spellCheck={false} maxLength={40} placeholder="3F9A1-C07B2" className="rounded-lg border border-line bg-surface px-3 py-2 text-lg text-foreground" />
        </label>
        <button id="scan-submit" className={button}>
          סמן
        </button>
      </form>
    </section>
  );
}
