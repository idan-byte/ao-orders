"use client";

import "leaflet/dist/leaflet.css";
import { useActionState, useEffect, useRef, useState } from "react";
import type { Map as LeafletMap, LayerGroup, Marker } from "leaflet";

export type MapStopView = {
  stop: number;
  customers: string[];
  address: string | null;
  addressId: string | null;
  point: { lat: number; lng: number } | null;
  location: "found" | "manual" | "not_found" | "pending" | "none";
  deliveries: number;
  delivered: number;
};
type State = { error?: string; ok?: string };

const LOCATION_LABEL: Record<MapStopView["location"], string> = {
  found: "אותר לפי הכתובת",
  manual: "מוקם ידנית",
  not_found: "לא אותר",
  pending: "עוד לא אותר",
  none: "אין כתובת אספקה רשומה",
};
// Shown when nothing is located yet: Jerusalem.
const START: [number, number] = [31.78, 35.22];

/** The stops of one daily route on a map, numbered in delivery order, with placing an address by hand. */
export function RouteMap({
  stops,
  placeAction,
  clearAction,
}: {
  stops: MapStopView[];
  placeAction: (prev: State, fd: FormData) => Promise<State>;
  clearAction: (fd: FormData) => Promise<void>;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layer = useRef<LayerGroup | null>(null);
  const pin = useRef<Marker | null>(null);
  const placingRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [placing, setPlacing] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ lat: number; lng: number } | null>(null);
  const [state, formAction, pending] = useActionState<State, FormData>(async (prev, fd) => {
    const result = await placeAction(prev, fd);
    if (!result.error) stopPlacing();
    return result;
  }, {});

  function stopPlacing() {
    placingRef.current = null;
    setPlacing(null);
    setPicked(null);
    pin.current?.remove();
    pin.current = null;
  }
  function startPlacing(addressId: string) {
    stopPlacing();
    placingRef.current = addressId;
    setPlacing(addressId);
    holder.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // The map itself is created once. Leaflet needs the browser, so it is loaded here and not on the server.
  useEffect(() => {
    let cancelled = false;
    let created: LeafletMap | null = null;
    void import("leaflet").then((L) => {
      if (cancelled || !holder.current) return;
      created = L.map(holder.current, { scrollWheelZoom: true }).setView(START, 11);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(created);
      layer.current = L.layerGroup().addTo(created);
      created.on("click", (e) => {
        if (!placingRef.current || !created) return;
        const point = { lat: Math.round(e.latlng.lat * 1e6) / 1e6, lng: Math.round(e.latlng.lng * 1e6) / 1e6 };
        pin.current?.remove();
        pin.current = L.marker(e.latlng, { icon: L.divIcon({ className: "", html: '<div class="route-pin route-pin-new">+</div>', iconSize: [34, 34], iconAnchor: [17, 17] }), keyboard: false }).addTo(created);
        setPicked(point);
      });
      map.current = created;
      setReady(true);
    });
    return () => {
      cancelled = true;
      created?.remove();
      map.current = null;
      layer.current = null;
    };
  }, []);

  // Markers and the line between them follow the stops.
  useEffect(() => {
    if (!ready || !map.current || !layer.current) return;
    let cancelled = false;
    void import("leaflet").then((L) => {
      if (cancelled || !map.current || !layer.current) return;
      layer.current.clearLayers();
      const located = stops.filter((s) => s.point);
      const points = located.map((s) => [s.point!.lat, s.point!.lng] as [number, number]);
      if (points.length > 1) L.polyline(points, { color: "#0f6b5c", weight: 3, opacity: 0.7, dashArray: "6 6" }).addTo(layer.current);
      for (const s of located) {
        const done = s.delivered === s.deliveries;
        L.marker([s.point!.lat, s.point!.lng], {
          icon: L.divIcon({ className: "", html: `<div class="route-pin${done ? " route-pin-done" : ""}">${s.stop}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
          title: `עצירה ${s.stop}: ${s.customers.join(", ")}`,
          alt: `עצירה ${s.stop}`,
        })
          .bindPopup(() => {
            const el = document.createElement("div");
            el.dir = "rtl";
            const b = document.createElement("b");
            b.textContent = `עצירה ${s.stop} · ${s.customers.join(", ")}`;
            const a = document.createElement("div");
            a.textContent = `${s.address ?? ""}${done ? " · נמסר" : ""}`;
            el.append(b, a);
            return el;
          })
          .addTo(layer.current!);
      }
      if (points.length === 1) map.current.setView(points[0], 15);
      else if (points.length > 1) map.current.fitBounds(L.latLngBounds(points).pad(0.15));
    });
    return () => {
      cancelled = true;
    };
  }, [ready, stops]);

  const placingStop = stops.find((s) => s.addressId === placing);
  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm";

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-2">
        {placingStop ? (
          <form action={formAction} id="place-form" className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-foreground bg-surface p-3">
            <input type="hidden" name="address_id" value={placing ?? ""} />
            <input type="hidden" name="lat" value={picked?.lat ?? ""} />
            <input type="hidden" name="lng" value={picked?.lng ?? ""} />
            <span className="min-w-0 flex-1">
              <b>
                מיקום עצירה {placingStop.stop} · {placingStop.customers.join(", ")}
              </b>
              <span className="block text-sm text-muted">{picked ? "הנקודה סומנה ב-+. אפשר ללחוץ שוב כדי להזיז אותה, ואז לשמור." : "יש ללחוץ על המפה במקום שבו נמצאת הכתובת."}</span>
            </span>
            <button disabled={!picked || pending} className="rounded-lg bg-accent px-4 py-2 font-medium text-surface disabled:opacity-60">
              {pending ? "שומר…" : "שמור מיקום"}
            </button>
            <button type="button" onClick={stopPlacing} className={btn}>
              בטל
            </button>
          </form>
        ) : null}
        {state.error ? (
          <p role="alert" className="rounded-lg bg-sunken px-3 py-2 text-sm font-medium">
            {state.error}
          </p>
        ) : null}
        <div ref={holder} dir="ltr" id="route-map" data-ready={ready} data-placing={placing ? "true" : "false"} className={`h-[60vh] min-h-80 w-full overflow-hidden rounded-xl border border-line ${placing ? "cursor-crosshair" : ""}`} />
        <p className="text-sm text-muted">הקו המקווקו מחבר את העצירות לפי סדר החלוקה, בקו ישר. הוא לא מסלול נסיעה ולא מחשב מרחק או זמן.</p>
      </div>

      <ol className="flex flex-col gap-2" data-map-stops>
        {stops.map((s) => (
          <li key={s.stop} data-map-stop={s.stop} data-location={s.location} className={`rounded-xl bg-surface p-3 ${s.point ? "border border-line" : "border-2 border-foreground"}`}>
            <div className="flex items-start gap-3">
              <span className="font-display text-xl font-bold tabular-nums">{s.stop}</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium">{s.customers.join(", ")}</div>
                <div className="text-sm text-muted">{s.address ?? "אין כתובת אספקה"}</div>
                <div className="text-sm">
                  {s.point ? LOCATION_LABEL[s.location] : <b>לא על המפה · {LOCATION_LABEL[s.location]}</b>}
                  {s.delivered === s.deliveries ? " · נמסר" : ""}
                </div>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {s.point ? (
                <button type="button" className={btn} onClick={() => map.current?.setView([s.point!.lat, s.point!.lng], 16)}>
                  הצג במפה
                </button>
              ) : null}
              {s.addressId ? (
                <button type="button" className={btn} data-place={s.stop} aria-pressed={placing === s.addressId} onClick={() => startPlacing(s.addressId!)}>
                  {s.point ? "תקן מיקום" : "מקם על המפה"}
                </button>
              ) : null}
              {s.addressId && s.location === "manual" ? (
                <form action={clearAction}>
                  <input type="hidden" name="address_id" value={s.addressId} />
                  <button className={btn} data-clear={s.stop}>
                    בטל מיקום ידני
                  </button>
                </form>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
