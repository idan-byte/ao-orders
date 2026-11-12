import { parseSearchResult, type Point } from "@/lib/geo-core";

// Address search (geocoding) through OpenStreetMap's Nominatim service.
// What leaves this server: the street and city of a delivery address, nothing else. No customer name,
// no order, and nothing that identifies this business: the client name below is deliberately generic.
// The service allows one request per second, so searches are spaced out.
//   AO_GEOCODER_URL   another Nominatim-compatible server (for example one hosted by the business)
//   AO_GEOCODER=off   switches the search off; addresses are then placed on the map by hand only

const DEFAULT_URL = "https://nominatim.openstreetmap.org/search";
const GAP_MS = 1100;
const state = globalThis as unknown as { __geoLast?: number };

export const geocoderEnabled = () => process.env.AO_GEOCODER !== "off";

export type SearchAnswer = { point: Point | null; failed: boolean };

/** Searches one address text. `failed` means the service did not answer, which is not the same as "not found". */
export async function searchAddress(query: string): Promise<SearchAnswer> {
  const wait = (state.__geoLast ?? 0) + GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state.__geoLast = Date.now();
  const url = new URL(process.env.AO_GEOCODER_URL || DEFAULT_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "3");
  url.searchParams.set("countrycodes", "il");
  url.searchParams.set("accept-language", "he");
  try {
    const res = await fetch(url, { headers: { "User-Agent": "delivery-route-map/1.0" }, signal: AbortSignal.timeout(10_000), cache: "no-store" });
    if (!res.ok) return { point: null, failed: true };
    return { point: parseSearchResult(await res.json()), failed: false };
  } catch {
    return { point: null, failed: true };
  }
}
