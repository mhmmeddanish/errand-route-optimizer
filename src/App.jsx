import { useState, useEffect, useRef, useCallback, useMemo } from "react";

const GKEY = "#####################";

/* ================================================================
   UTILS
   ================================================================ */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function fmtDist(mi) {
  return mi < 0.1 ? "nearby" : mi < 1 ? `${(mi * 5280).toFixed(0)} ft` : `${mi.toFixed(1)} mi`;
}
function fmtTime(h, m) {
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;
}
function nowHour() { const d = new Date(); return d.getHours() + d.getMinutes() / 60; }
function todayDay() { return new Date().getDay(); } // 0=Sun

/* Parse Google Places opening_hours to get today's closing time */
function parsePlaceHours(place) {
  // place.opening_hours or place.currentOpeningHours
  const oh = place.currentOpeningHours || place.regularOpeningHours || place.opening_hours;
  if (!oh) return { closes: null, closesDecimal: 24, display: "Hours not listed", isOpen: null };

  const isOpen = oh.openNow ?? oh.open_now ?? null;

  // Try periods (structured data)
  const periods = oh.periods;
  if (periods && periods.length > 0) {
    const today = todayDay();
    // Find today's period
    const todayPeriod = periods.find((p) => {
      const openDay = p.open?.day ?? p.open?.date?.day;
      return openDay === today;
    });
    if (todayPeriod && todayPeriod.close) {
      const ch = todayPeriod.close.hour ?? todayPeriod.close.hours ?? parseInt(todayPeriod.close.time?.slice(0, 2));
      const cm = todayPeriod.close.minute ?? todayPeriod.close.minutes ?? parseInt(todayPeriod.close.time?.slice(2)) ?? 0;
      if (!isNaN(ch)) {
        return { closes: `${ch}:${String(cm || 0).padStart(2, "0")}`, closesDecimal: ch + (cm || 0) / 60, display: `Open till ${fmtTime(ch, cm || 0)}`, isOpen };
      }
    }
    // 24hr: period with open but no close
    if (todayPeriod && !todayPeriod.close) {
      return { closes: "23:59", closesDecimal: 24, display: "Open 24 hours", isOpen: true };
    }
  }

  // Try weekday_text (array of strings like "Monday: 9:00 AM – 9:00 PM")
  const wt = oh.weekdayDescriptions || oh.weekday_text;
  if (wt && wt.length > 0) {
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const todayName = dayNames[todayDay()];
    const todayLine = wt.find((l) => l.startsWith(todayName));
    if (todayLine) {
      if (/closed/i.test(todayLine)) return { closes: null, closesDecimal: -1, display: "Closed today", isOpen: false };
      if (/24\s*hours|open\s*24/i.test(todayLine)) return { closes: "23:59", closesDecimal: 24, display: "Open 24 hours", isOpen: true };
      // Parse "9:00 AM – 9:00 PM" or "9:00 AM – 9:00 PM"
      const timeMatch = todayLine.match(/(\d{1,2}):(\d{2})\s*(AM|PM)\s*[–-]\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (timeMatch) {
        let ch = parseInt(timeMatch[4]);
        const cm = parseInt(timeMatch[5]);
        const cAmPm = timeMatch[6].toUpperCase();
        if (cAmPm === "PM" && ch < 12) ch += 12;
        if (cAmPm === "AM" && ch === 12) ch = 0;
        return { closes: `${ch}:${String(cm).padStart(2, "0")}`, closesDecimal: ch + cm / 60, display: `Open till ${fmtTime(ch, cm)}`, isOpen };
      }
      // Just show the raw text
      const cleanLine = todayLine.replace(todayName + ": ", "").trim();
      return { closes: null, closesDecimal: 24, display: cleanLine || "See hours", isOpen };
    }
  }

  return { closes: null, closesDecimal: 24, display: isOpen === true ? "Open now" : isOpen === false ? "Closed" : "Hours not listed", isOpen };
}

/* ================================================================
   GOOGLE APIS
   ================================================================ */
async function googleGeocode(address) {
  const url = `/google-maps/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GKEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" || data.results.length === 0) return null;
  const r = data.results[0];
  return {
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    label: r.formatted_address.split(",").slice(0, 2).join(","),
  };
}

async function googleNearbySearch(lat, lng, type, keyword) {
  const url = `/google-maps/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=4000&type=${type}${keyword ? `&keyword=${encodeURIComponent(keyword)}` : ""}&key=${GKEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK") return [];
  return data.results || [];
}

async function googleTextSearch(query, lat, lng) {
  const url = `/google-maps/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&location=${lat},${lng}&radius=5000&key=${GKEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK") return [];
  return data.results || [];
}

async function googlePlaceDetails(placeId) {
  const url = `/google-maps/maps/api/place/details/json?place_id=${placeId}&fields=opening_hours,current_opening_hours,formatted_phone_number&key=${GKEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.result || {};
}

/* Fetch and convert Google places to our format */
async function fetchPlaces(lat, lng, category) {
  const cat = CATEGORIES.find((c) => c.id === category);
  if (!cat) return [];

  try {
    const results = await googleNearbySearch(lat, lng, cat.googleType, cat.keyword);
    return results.map((p) => {
      const plat = p.geometry.location.lat;
      const plng = p.geometry.location.lng;
      const hours = parsePlaceHours(p);
      return {
        id: p.place_id,
        name: p.name,
        address: p.vicinity || p.formatted_address || "See map",
        lat: plat,
        lng: plng,
        closes: hours.closes,
        closesDecimal: hours.closesDecimal,
        hoursDisplay: hours.display,
        isOpen: hours.isOpen,
        rating: p.rating || null,
        totalRatings: p.user_ratings_total || 0,
        category,
        traits: CAT_TRAITS[category] || [],
        dist: haversine(lat, lng, plat, plng),
        priceLevel: p.price_level ?? null,
      };
    }).sort((a, b) => a.dist - b.dist);
  } catch (err) {
    console.error("Google Places error:", err);
    return [];
  }
}

async function searchPlaces(query, lat, lng) {
  try {
    const results = await googleTextSearch(query, lat, lng);
    return results.map((p) => {
      const plat = p.geometry.location.lat;
      const plng = p.geometry.location.lng;
      const hours = parsePlaceHours(p);
      return {
        id: p.place_id,
        name: p.name,
        address: p.formatted_address?.split(",").slice(0, 2).join(",") || p.vicinity || "See map",
        lat: plat,
        lng: plng,
        closes: hours.closes,
        closesDecimal: hours.closesDecimal,
        hoursDisplay: hours.display,
        isOpen: hours.isOpen,
        rating: p.rating || null,
        totalRatings: p.user_ratings_total || 0,
        category: "search",
        traits: [],
        dist: haversine(lat, lng, plat, plng),
      };
    }).filter((p) => p.dist < 8).sort((a, b) => a.dist - b.dist);
  } catch {
    return [];
  }
}

/* ================================================================
   CATEGORIES
   ================================================================ */
const CATEGORIES = [
  { id: "grocery", label: "Grocery", googleType: "supermarket", keyword: "" },
  { id: "pharmacy", label: "Pharmacy", googleType: "pharmacy", keyword: "" },
  { id: "post", label: "Post & Shipping", googleType: "post_office", keyword: "" },
  { id: "bank", label: "Banking", googleType: "bank", keyword: "" },
  { id: "fuel", label: "Gas Station", googleType: "gas_station", keyword: "" },
  { id: "cafe", label: "Coffee & Food", googleType: "cafe", keyword: "" },
  { id: "retail", label: "Retail", googleType: "department_store", keyword: "" },
  { id: "auto", label: "Auto Services", googleType: "car_wash", keyword: "" },
];

const CAT_TRAITS = { grocery: ["frozen_items"], auto: ["keep_last"] };

const CAT_ICONS = {
  grocery: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 002 1.61h9.72a2 2 0 002-1.61L23 6H6"/></svg>,
  pharmacy: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12h6M12 9v6"/></svg>,
  post: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 7L2 7"/></svg>,
  bank: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>,
  fuel: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 22V6a2 2 0 012-2h6a2 2 0 012 2v16"/><path d="M13 10h2a2 2 0 012 2v4a2 2 0 002 2h0a2 2 0 002-2V9l-3-3"/><rect x="5" y="8" width="6" height="4"/></svg>,
  cafe: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 8h1a4 4 0 010 8h-1M2 8h16v9a4 4 0 01-4 4H6a4 4 0 01-4-4V8z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>,
  retail: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4zM3 6h18"/><path d="M16 10a4 4 0 01-8 0"/></svg>,
  auto: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 17h14M5 17a2 2 0 01-2-2V9a2 2 0 012-2h14a2 2 0 012 2v6a2 2 0 01-2 2M5 17l-1 3M19 17l1 3"/><circle cx="7.5" cy="12.5" r="1.5"/><circle cx="16.5" cy="12.5" r="1.5"/></svg>,
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
};

/* ================================================================
   OPTIMIZATION
   ================================================================ */
const PRIORITIES = [
  { id: "closing_time", label: "Store Closing Times", desc: "Visit stores that close soonest first" },
  { id: "frozen_items", label: "Perishable Items", desc: "Push grocery stops later to keep items fresh" },
  { id: "keep_last", label: "Keep Last (Car Wash)", desc: "Schedule car washes as the final stop" },
  { id: "distance", label: "Shortest Distance", desc: "Minimize driving distance between stops" },
  { id: "parking", label: "Parking Difficulty", desc: "Visit busy lots during off-peak hours" },
];

function optimize(errands, factors, startLoc) {
  if (errands.length === 0) return [];
  const cur = nowHour();
  return errands.map((e) => {
    let score = 0, reasons = [];
    const closingHr = e.closesDecimal || 24;
    const left = closingHr - cur;
    const dist = startLoc ? haversine(startLoc.lat, startLoc.lng, e.lat, e.lng) : 0;

    if (factors.includes("closing_time") && e.closes) {
      if (left <= 1 && left > 0) { score += 80; reasons.push(`Closes in under 1 hour (${e.hoursDisplay}) — urgent`); }
      else if (left <= 2 && left > 0) { score += 50; reasons.push(`Closes soon — ${e.hoursDisplay}`); }
      else if (left <= 4 && left > 0) { score += 15; reasons.push(e.hoursDisplay); }
    }
    if (factors.includes("frozen_items") && e.traits?.includes("frozen_items")) { score -= 30; reasons.push("Perishable items — scheduled later"); }
    if (factors.includes("keep_last") && e.traits?.includes("keep_last")) { score -= 100; reasons.push("Scheduled last to preserve result"); }
    if (factors.includes("distance") && startLoc) {
      score += Math.max(0, 30 - dist * 8);
      if (dist < 1) reasons.push(`Very close (${fmtDist(dist)})`);
      else if (dist < 3) reasons.push(`${fmtDist(dist)} from start`);
    }
    if (factors.includes("parking") && e.totalRatings > 500) {
      if (cur >= 11 && cur <= 14) { score += 15; reasons.push("Popular spot — go before lunch rush"); }
    }
    if (reasons.length === 0) reasons.push("Standard routing");
    return { ...e, score, reasons, distFromStart: dist };
  }).sort((a, b) => b.score - a.score);
}

/* ================================================================
   ICONS
   ================================================================ */
const I = {
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  arrow: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>,
  back: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>,
  nav: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>,
  up: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M18 15l-6-6-6 6"/></svg>,
  down: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 9l6 6 6-6"/></svg>,
  crosshair: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>,
  search: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  sparkle: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>,
  loc: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 00-8 8c0 5.4 8 12 8 12s8-6.6 8-12a8 8 0 00-8-8z"/></svg>,
  loader: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{animation:"spin 1s linear infinite"}}><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>,
  star: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>,
};

/* ================================================================
   LEAFLET MAP
   ================================================================ */
function LeafletMap({ errands, startLoc }) {
  const ref = useRef(null);
  const mapRef = useRef(null);
  useEffect(() => {
    if (!document.getElementById("lf-css")) {
      const l = document.createElement("link"); l.id = "lf-css"; l.rel = "stylesheet";
      l.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"; document.head.appendChild(l);
    }
    const load = () => new Promise((r) => { if (window.L) return r(); const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"; s.onload = r; document.head.appendChild(s); });
    load().then(() => {
      if (!ref.current) return;
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      const L = window.L;
      const map = L.map(ref.current, { zoomControl: false, attributionControl: false }).setView([startLoc.lat, startLoc.lng], 13);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", { maxZoom: 19 }).addTo(map);
      L.marker([startLoc.lat, startLoc.lng], { icon: L.divIcon({ className: "", html: '<div style="width:14px;height:14px;background:#2563EB;border:2.5px solid #fff;border-radius:50%;box-shadow:0 0 0 4px rgba(37,99,235,0.2),0 1px 4px rgba(0,0,0,0.2);"></div>', iconSize: [14,14], iconAnchor: [7,7] }) }).addTo(map).bindPopup("<strong style='font-size:12px;'>Start</strong>");
      const bounds = [[startLoc.lat, startLoc.lng]], coords = [[startLoc.lat, startLoc.lng]];
      const colors = ["#DC2626","#2563EB","#059669","#D97706","#7C3AED","#DB2777","#0891B2","#65A30D"];
      errands.forEach((e, i) => {
        const c = colors[i % colors.length];
        L.marker([e.lat, e.lng], { icon: L.divIcon({ className: "", html: `<div style="width:28px;height:28px;border-radius:50%;background:${c};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;font-family:monospace;box-shadow:0 2px 6px rgba(0,0,0,0.25);border:2px solid #fff;">${i+1}</div>`, iconSize:[28,28], iconAnchor:[14,14] }) }).addTo(map).bindPopup(`<strong style='font-size:12px;'>${e.name}</strong><br/><span style='font-size:11px;color:#666;'>${e.address}</span>`);
        bounds.push([e.lat, e.lng]); coords.push([e.lat, e.lng]);
      });
      L.polyline(coords, { color: "#1E293B", weight: 2.5, opacity: 0.5, dashArray: "8 6" }).addTo(map);
      map.fitBounds(bounds, { padding: [45, 45] });
      mapRef.current = map;
    });
    return () => { if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; } };
  }, [errands, startLoc]);
  return <div ref={ref} style={{ width: "100%", height: "300px", background: "#F1F0EC" }} />;
}

/* ================================================================
   NAV SHEET
   ================================================================ */
function NavSheet({ show, onClose, errands, startLoc }) {
  if (!show || !startLoc || errands.length === 0) return null;
  const stops = errands.map((e) => `${e.lat},${e.lng}`);
  const appleUrl = `https://maps.apple.com/?saddr=${startLoc.lat},${startLoc.lng}&daddr=${stops.join("+to:")}&dirflg=d`;
  const dest = errands[errands.length - 1];
  const wps = errands.slice(0, -1).map((e) => `${e.lat},${e.lng}`).join("|");
  const googleUrl = `https://www.google.com/maps/dir/?api=1&origin=${startLoc.lat},${startLoc.lng}&destination=${dest.lat},${dest.lng}${wps ? `&waypoints=${wps}` : ""}&travelmode=driving`;
  return (
    <div onClick={onClose} style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:1000,display:"flex",alignItems:"flex-end",justifyContent:"center" }}>
      <div onClick={(e)=>e.stopPropagation()} style={{ background:"#fff",borderRadius:"16px 16px 0 0",width:"100%",maxWidth:"600px",padding:"16px 20px 28px" }}>
        <div style={{ width:"32px",height:"3px",borderRadius:"2px",background:"#D4D4D4",margin:"0 auto 16px" }}/>
        <div style={{ fontSize:"15px",fontWeight:700,textAlign:"center",marginBottom:"14px" }}>Open in navigation app</div>
        {[{ label:"Apple Maps",sub:"Turn-by-turn directions",url:appleUrl,bg:"#1D1D1F",c:"#fff" },{ label:"Google Maps",sub:"Directions with live traffic",url:googleUrl,bg:"#E8F5EE",c:"#1A1A1A" }].map((o)=>(
          <a key={o.label} href={o.url} target="_blank" rel="noopener noreferrer" style={{ display:"flex",alignItems:"center",gap:"14px",padding:"12px 16px",borderRadius:"12px",border:"1px solid #E5E5E5",background:"#fff",textDecoration:"none",color:"#1A1A1A",marginBottom:"8px" }}>
            <div style={{ width:"40px",height:"40px",borderRadius:"10px",background:o.bg,display:"flex",alignItems:"center",justifyContent:"center",color:o.c,fontWeight:700,fontSize:"14px",flexShrink:0 }}>{o.label[0]}</div>
            <div><div style={{ fontWeight:600,fontSize:"14px" }}>{o.label}</div><div style={{ fontSize:"12px",color:"#888",marginTop:"1px" }}>{o.sub}</div></div>
          </a>
        ))}
        <button onClick={onClose} style={{ width:"100%",padding:"12px",borderRadius:"12px",border:"none",background:"#F5F5F3",fontSize:"14px",fontWeight:600,color:"#888",cursor:"pointer",marginTop:"4px" }}>Cancel</button>
      </div>
    </div>
  );
}

/* ================================================================
   MAIN APP
   ================================================================ */
export default function App() {
  const [screen, setScreen] = useState("start");
  const [startLoc, setStartLoc] = useState(null);
  const [manualAddr, setManualAddr] = useState("");
  const [locLoading, setLocLoading] = useState(false);
  const [locError, setLocError] = useState(null);
  const [geocoding, setGeocoding] = useState(false);

  const [activeCat, setActiveCat] = useState(CATEGORIES[0].id);
  const [places, setPlaces] = useState({});
  const [loadingCat, setLoadingCat] = useState(null);
  const [selected, setSelected] = useState([]);
  const [factors, setFactors] = useState(["closing_time", "distance"]);
  const [optimized, setOptimized] = useState([]);
  const [showNav, setShowNav] = useState(false);

  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef(null);

  // GPS
  const requestGPS = () => {
    setLocLoading(true); setLocError(null);
    if (!navigator.geolocation) { setLocError("Geolocation not supported."); setLocLoading(false); return; }
    navigator.geolocation.getCurrentPosition(
      (p) => { setStartLoc({ lat: p.coords.latitude, lng: p.coords.longitude, label: "Current Location" }); setLocLoading(false); setScreen("browse"); },
      () => { setLocError("Could not get location. Enter an address instead."); setLocLoading(false); },
      { timeout: 8000, enableHighAccuracy: false }
    );
  };

  // Geocode
  const submitAddr = async () => {
    if (!manualAddr.trim()) return;
    setGeocoding(true); setLocError(null);
    const result = await googleGeocode(manualAddr);
    setGeocoding(false);
    if (!result) { setLocError("Address not found. Try a more specific address."); return; }
    setStartLoc(result);
    setScreen("browse");
  };

  // Fetch category
  useEffect(() => {
    if (!startLoc || screen !== "browse") return;
    if (places[activeCat]) return;
    setLoadingCat(activeCat);
    fetchPlaces(startLoc.lat, startLoc.lng, activeCat).then((res) => {
      setPlaces((prev) => ({ ...prev, [activeCat]: res }));
      setLoadingCat(null);
    });
  }, [activeCat, startLoc, screen]);

  useEffect(() => { setPlaces({}); setSearchResults([]); }, [startLoc]);

  // Debounced search with Google Text Search
  useEffect(() => {
    if (!searchQ.trim()) { setSearchResults([]); setSearching(false); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      if (!startLoc) return;
      setSearching(true);
      const results = await searchPlaces(searchQ, startLoc.lat, startLoc.lng);
      setSearchResults(results);
      setSearching(false);
    }, 500);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchQ, startLoc]);

  const currentPlaces = useMemo(() => {
    if (searchQ.trim()) return searchResults;
    return places[activeCat] || [];
  }, [places, activeCat, searchQ, searchResults]);

  const isSelected = (p) => selected.some((s) => s.id === p.id);
  const togglePlace = (p) => {
    if (isSelected(p)) setSelected((prev) => prev.filter((s) => s.id !== p.id));
    else setSelected((prev) => [...prev, p]);
  };

  const runOpt = useCallback(() => optimize(selected, factors, startLoc), [selected, factors, startLoc]);
  useEffect(() => { if (screen === "route" || screen === "map") setOptimized(runOpt()); }, [factors, screen, runOpt]);
  const goRoute = () => { setOptimized(runOpt()); setScreen("route"); };
  const move = (from, to) => { const u = [...optimized]; const [m] = u.splice(from, 1); u.splice(to, 0, m); setOptimized(u); };
  const totalTime = optimized.length * 15 + Math.max(0, (optimized.length - 1) * 8);
  const totalDist = optimized.reduce((s, e) => s + (e.distFromStart || 0), 0);

  const S = {
    root: { fontFamily:"'Instrument Sans',-apple-system,sans-serif", background:"#FAFAF8", minHeight:"100vh", color:"#111" },
    header: { padding:"16px 20px 14px", borderBottom:"1px solid #E8E5E0", background:"#fff", display:"flex", alignItems:"center", gap:"12px" },
    content: { padding:"16px 20px 100px", maxWidth:"600px", margin:"0 auto" },
    card: { background:"#fff", border:"1px solid #E8E5E0", borderRadius:"12px", padding:"14px 16px", marginBottom:"8px" },
    primary: { width:"100%",padding:"14px",borderRadius:"12px",border:"none",background:"#111",color:"#fff",fontWeight:700,fontSize:"15px",cursor:"pointer",letterSpacing:"-0.3px",display:"flex",alignItems:"center",justifyContent:"center",gap:"8px" },
    secondary: { width:"100%",padding:"12px",borderRadius:"12px",border:"1px solid #E8E5E0",background:"#fff",fontWeight:600,fontSize:"14px",cursor:"pointer",color:"#555",display:"flex",alignItems:"center",justifyContent:"center",gap:"6px" },
    label: { fontSize:"11px",fontWeight:600,color:"#999",textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:"10px" },
    pill: (on) => ({ padding:"6px 14px",borderRadius:"20px",fontSize:"12px",fontWeight:600,border:on?"1.5px solid #111":"1px solid #E8E5E0",background:on?"#111":"#fff",color:on?"#fff":"#666",cursor:"pointer",whiteSpace:"nowrap" }),
    reason: { fontSize:"12px",color:"#555",background:"#F5F5F3",borderRadius:"8px",padding:"6px 10px",lineHeight:1.4 },
  };

  return (
    <div style={S.root}>
      <style>{`@keyframes spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}`}</style>
      <link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />

      <div style={S.header}>
        {screen !== "start" && <button onClick={() => { if(screen==="map")setScreen("route"); else if(screen==="route")setScreen("browse"); else setScreen("start"); }} style={{ background:"none",border:"none",cursor:"pointer",padding:"4px",color:"#111",display:"flex" }}>{I.back}</button>}
        <div>
          <div style={{ fontSize:"16px",fontWeight:700,letterSpacing:"-0.4px" }}>Route Optimizer</div>
          <div style={{ fontSize:"11px",color:"#999",letterSpacing:"0.03em",textTransform:"uppercase",marginTop:"1px" }}>
            {screen==="start"&&"Set starting point"}{screen==="browse"&&`${selected.length} stop${selected.length!==1?"s":""} selected`}{screen==="route"&&"AI-optimized route"}{screen==="map"&&"Route overview"}
          </div>
        </div>
      </div>

      <div style={S.content}>

        {/* START */}
        {screen === "start" && (
          <div style={{ display:"flex",flexDirection:"column",gap:"16px",paddingTop:"20px" }}>
            <div style={{ textAlign:"center",marginBottom:"8px" }}>
              <div style={{ fontSize:"24px",fontWeight:700,letterSpacing:"-0.5px",marginBottom:"6px" }}>Where are you starting?</div>
              <div style={{ fontSize:"14px",color:"#888" }}>We will find real nearby places and calculate distances from here.</div>
            </div>
            <button onClick={requestGPS} disabled={locLoading} style={{ ...S.card,display:"flex",alignItems:"center",gap:"14px",cursor:locLoading?"wait":"pointer" }}>
              <div style={{ width:"42px",height:"42px",borderRadius:"50%",background:"#F0F7FF",display:"flex",alignItems:"center",justifyContent:"center",color:"#2563EB",flexShrink:0 }}>{locLoading?I.loader:I.crosshair}</div>
              <div style={{ textAlign:"left" }}><div style={{ fontWeight:600,fontSize:"14px" }}>{locLoading?"Getting location...":"Use current location"}</div><div style={{ fontSize:"12px",color:"#888",marginTop:"2px" }}>GPS — most accurate</div></div>
            </button>
            {locError && <div style={{ fontSize:"13px",color:"#DC2626",background:"#FEF2F2",borderRadius:"10px",padding:"10px 14px" }}>{locError}</div>}
            <div style={{ display:"flex",alignItems:"center",gap:"12px" }}><div style={{ flex:1,height:"1px",background:"#E8E5E0" }}/><span style={{ fontSize:"12px",color:"#AAA",fontWeight:500 }}>or</span><div style={{ flex:1,height:"1px",background:"#E8E5E0" }}/></div>
            <div>
              <div style={S.label}>Enter starting address</div>
              <div style={{ display:"flex",gap:"8px" }}>
                <input value={manualAddr} onChange={(e)=>setManualAddr(e.target.value)} onKeyDown={(e)=>e.key==="Enter"&&submitAddr()} placeholder="e.g. 100 Commercial St, Portland ME" style={{ flex:1,padding:"12px 14px",borderRadius:"10px",border:"1px solid #E8E5E0",fontSize:"14px",background:"#fff",color:"#111",outline:"none" }}/>
                <button onClick={submitAddr} disabled={geocoding||!manualAddr.trim()} style={{ padding:"12px 16px",borderRadius:"10px",border:"none",background:manualAddr.trim()?"#111":"#DDD",color:"#fff",fontWeight:600,cursor:manualAddr.trim()?"pointer":"default",fontSize:"14px",minWidth:"52px",display:"flex",alignItems:"center",justifyContent:"center" }}>{geocoding?I.loader:"Go"}</button>
              </div>
            </div>
          </div>
        )}

        {/* BROWSE */}
        {screen === "browse" && (
          <div style={{ display:"flex",flexDirection:"column",gap:"12px" }}>
            <div style={{ ...S.card,display:"flex",alignItems:"center",gap:"10px",background:"#F8F8F6" }}>
              <div style={{ color:"#2563EB" }}>{I.loc}</div>
              <div style={{ flex:1 }}><div style={{ fontSize:"11px",color:"#999",fontWeight:600,textTransform:"uppercase",letterSpacing:"0.05em" }}>Starting from</div><div style={{ fontSize:"14px",fontWeight:600,marginTop:"1px" }}>{startLoc?.label||"Unknown"}</div></div>
              <button onClick={()=>{setScreen("start");setPlaces({});}} style={{ fontSize:"12px",color:"#2563EB",background:"none",border:"none",cursor:"pointer",fontWeight:600 }}>Change</button>
            </div>

            <div style={{ position:"relative" }}>
              <div style={{ position:"absolute",left:"12px",top:"50%",transform:"translateY(-50%)",color:"#BBB" }}>{I.search}</div>
              <input value={searchQ} onChange={(e)=>setSearchQ(e.target.value)} placeholder="Search any place (e.g. Starbucks, CVS...)" style={{ width:"100%",padding:"11px 12px 11px 36px",borderRadius:"10px",border:"1px solid #E8E5E0",fontSize:"14px",background:"#fff",color:"#111",outline:"none",boxSizing:"border-box" }}/>
            </div>

            {!searchQ && <div style={{ display:"flex",gap:"6px",overflowX:"auto",paddingBottom:"4px",scrollbarWidth:"none" }}>{CATEGORIES.map((c)=>(<button key={c.id} onClick={()=>setActiveCat(c.id)} style={S.pill(activeCat===c.id)}>{c.label}</button>))}</div>}

            <div style={S.label}>{searchQ?(searching?"Searching...":"Search results"):CATEGORIES.find((c)=>c.id===activeCat)?.label||""}{!searchQ&&loadingCat===activeCat&&" — loading..."}</div>

            {(loadingCat === activeCat && !searchQ) && <div style={{ textAlign:"center",padding:"30px 0",color:"#999",display:"flex",flexDirection:"column",alignItems:"center",gap:"10px" }}>{I.loader}<span style={{ fontSize:"13px" }}>Finding nearby places...</span></div>}

            {!searching && currentPlaces.length === 0 && loadingCat !== activeCat && <div style={{ textAlign:"center",padding:"30px 0",color:"#999",fontSize:"13px" }}>{searchQ?"No results found.":"No places found nearby."}</div>}

            {currentPlaces.map((p) => {
              const sel = isSelected(p);
              const isClosed = p.isOpen === false;
              const closingSoon = p.closesDecimal && (p.closesDecimal - nowHour()) > 0 && (p.closesDecimal - nowHour()) <= 2;
              return (
                <div key={p.id} style={{ ...S.card,display:"flex",alignItems:"center",gap:"12px",border:sel?"1.5px solid #111":"1px solid #E8E5E0",opacity:isClosed?0.5:1 }}>
                  <div style={{ width:"38px",height:"38px",borderRadius:"10px",background:sel?"#111":"#F5F5F3",color:sel?"#fff":"#666",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>{CAT_ICONS[p.category]||I.loc}</div>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontWeight:600,fontSize:"14px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize:"12px",color:"#888",marginTop:"2px",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis" }}>{p.address}</div>
                    <div style={{ display:"flex",gap:"8px",marginTop:"4px",alignItems:"center",flexWrap:"wrap" }}>
                      <span style={{ fontSize:"11px",fontWeight:600,color:isClosed?"#DC2626":closingSoon?"#D97706":p.isOpen?"#059669":"#888" }}>{p.hoursDisplay}</span>
                      <span style={{ fontSize:"11px",color:"#AAA" }}>{fmtDist(p.dist)}</span>
                      {p.rating && <span style={{ fontSize:"11px",color:"#D97706",display:"flex",alignItems:"center",gap:"2px" }}>{I.star} {p.rating}</span>}
                    </div>
                  </div>
                  <button onClick={()=>togglePlace(p)} style={{ width:"34px",height:"34px",borderRadius:"50%",border:sel?"none":"1.5px solid #DDD",background:sel?"#111":"transparent",color:sel?"#fff":"#BBB",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0 }}>{sel?I.check:I.plus}</button>
                </div>
              );
            })}

            <div style={{ marginTop:"8px" }}><div style={S.label}>Optimization priorities</div><div style={{ display:"flex",flexDirection:"column",gap:"6px" }}>{PRIORITIES.map((f)=>{const on=factors.includes(f.id);return(<button key={f.id} onClick={()=>setFactors((p)=>p.includes(f.id)?p.filter((x)=>x!==f.id):[...p,f.id])} style={{ ...S.card,display:"flex",alignItems:"center",gap:"12px",cursor:"pointer",textAlign:"left",border:on?"1.5px solid #111":"1px solid #E8E5E0",marginBottom:0 }}><div style={{ width:"22px",height:"22px",borderRadius:"6px",border:on?"2px solid #111":"2px solid #DDD",background:on?"#111":"transparent",display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",flexShrink:0 }}>{on&&I.check}</div><div><div style={{ fontWeight:600,fontSize:"13px",color:on?"#111":"#555" }}>{f.label}</div><div style={{ fontSize:"11px",color:"#999",marginTop:"1px" }}>{f.desc}</div></div></button>);})}</div></div>

            {selected.length >= 2 && <div style={{ position:"fixed",bottom:0,left:0,right:0,padding:"12px 20px",paddingBottom:"max(12px, env(safe-area-inset-bottom))",background:"linear-gradient(to top,#FAFAF8 70%,transparent)",zIndex:100,display:"flex",justifyContent:"center" }}><button onClick={goRoute} style={{ ...S.primary,maxWidth:"600px" }}>{I.sparkle}<span>Optimize {selected.length} stops</span>{I.arrow}</button></div>}
          </div>
        )}

        {/* ROUTE */}
        {screen === "route" && (
          <div style={{ display:"flex",flexDirection:"column",gap:"12px" }}>
            <div style={{ ...S.card,display:"flex",justifyContent:"space-around",textAlign:"center",background:"#F8F8F6" }}>{[{v:optimized.length,l:"Stops"},{v:`~${totalTime}`,l:"Minutes"},{v:totalDist.toFixed(1),l:"Miles"}].map((s)=>(<div key={s.l}><div style={{ fontSize:"20px",fontWeight:700,letterSpacing:"-0.5px" }}>{s.v}</div><div style={{ fontSize:"11px",color:"#999",textTransform:"uppercase",letterSpacing:"0.05em",marginTop:"2px" }}>{s.l}</div></div>))}</div>

            <div style={{ display:"flex",gap:"6px",flexWrap:"wrap" }}>{factors.map((fId)=>{const f=PRIORITIES.find((p)=>p.id===fId);return f?(<button key={fId} onClick={()=>setFactors((p)=>p.filter((x)=>x!==fId))} style={{ fontSize:"11px",fontWeight:600,color:"#555",background:"#F0F0EE",padding:"4px 10px",borderRadius:"6px",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:"4px" }}>{f.label}<span style={{ color:"#BBB",marginLeft:"2px" }}>x</span></button>):null;})}<button onClick={()=>setScreen("browse")} style={{ fontSize:"11px",fontWeight:600,color:"#2563EB",background:"none",border:"none",cursor:"pointer",padding:"4px 6px" }}>+ Add priority</button></div>

            <div style={S.label}>Optimized order</div>
            {optimized.map((e,i)=>(
              <div key={e.id||i} style={{ display:"flex",gap:"8px",alignItems:"stretch" }}>
                <div style={{ display:"flex",flexDirection:"column",justifyContent:"center",gap:"2px" }}>
                  <button onClick={()=>i>0&&move(i,i-1)} disabled={i===0} style={{ width:"26px",height:"26px",borderRadius:"6px",border:"1px solid #E5E5E5",background:i===0?"transparent":"#fff",cursor:i===0?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:i===0?"#DDD":"#888" }}>{I.up}</button>
                  <button onClick={()=>i<optimized.length-1&&move(i,i+1)} disabled={i===optimized.length-1} style={{ width:"26px",height:"26px",borderRadius:"6px",border:"1px solid #E5E5E5",background:i===optimized.length-1?"transparent":"#fff",cursor:i===optimized.length-1?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:i===optimized.length-1?"#DDD":"#888" }}>{I.down}</button>
                </div>
                <div style={{ ...S.card,flex:1,marginBottom:0 }}>
                  <div style={{ display:"flex",alignItems:"flex-start",gap:"10px" }}>
                    <div style={{ width:"26px",height:"26px",borderRadius:"50%",background:"#111",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"12px",fontWeight:700,flexShrink:0,fontFamily:"monospace" }}>{i+1}</div>
                    <div style={{ flex:1 }}>
                      <div style={{ fontWeight:600,fontSize:"14px" }}>{e.name}</div>
                      <div style={{ fontSize:"12px",color:"#888",marginTop:"2px" }}>{e.address}</div>
                      <div style={{ display:"flex",gap:"8px",marginTop:"4px",fontSize:"11px",color:"#999" }}>
                        <span>{e.hoursDisplay||"Hours N/A"}</span>
                        <span>{fmtDist(e.distFromStart||0)} from start</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ display:"flex",flexDirection:"column",gap:"3px",marginTop:"8px" }}>{e.reasons?.map((r,ri)=><div key={ri} style={S.reason}>{r}</div>)}</div>
                </div>
              </div>
            ))}
            <div style={{ display:"flex",gap:"8px",marginTop:"8px" }}>
              <button onClick={()=>setScreen("browse")} style={{ ...S.secondary,flex:1 }}>{I.back} Edit stops</button>
              <button onClick={()=>setScreen("map")} style={{ ...S.primary,flex:1 }}>View map {I.arrow}</button>
            </div>
          </div>
        )}

        {/* MAP */}
        {screen === "map" && startLoc && (
          <div style={{ display:"flex",flexDirection:"column",gap:"12px" }}>
            <div style={S.label}>Live route map</div>
            <div style={{ borderRadius:"14px",overflow:"hidden",border:"1px solid #E8E5E0" }}><LeafletMap errands={optimized} startLoc={startLoc}/></div>
            <div style={{ ...S.card,padding:"12px 14px" }}>
              {optimized.map((e,i)=>(<div key={e.id||i} style={{ display:"flex",alignItems:"center",gap:"10px",padding:"8px 0",borderBottom:i<optimized.length-1?"1px solid #F0F0EE":"none" }}><div style={{ width:"22px",height:"22px",borderRadius:"50%",background:"#111",color:"#fff",display:"flex",alignItems:"center",justifyContent:"center",fontSize:"11px",fontWeight:700,fontFamily:"monospace",flexShrink:0 }}>{i+1}</div><div style={{ flex:1 }}><div style={{ fontSize:"13px",fontWeight:600 }}>{e.name}</div><div style={{ fontSize:"11px",color:"#999" }}>{e.address}</div></div><div style={{ fontSize:"11px",color:"#888",fontFamily:"monospace" }}>{fmtDist(e.distFromStart||0)}</div></div>))}
              <div style={{ display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:"10px",marginTop:"6px",borderTop:"1.5px solid #E8E5E0" }}><div style={{ fontSize:"12px",color:"#888" }}>Total trip</div><div style={{ fontSize:"16px",fontWeight:700,letterSpacing:"-0.3px" }}>~{totalTime} min / {totalDist.toFixed(1)} mi</div></div>
            </div>
            <button onClick={()=>setShowNav(true)} style={{ ...S.primary,background:"#059669" }}>{I.nav}<span>Start Trip</span></button>
            <button onClick={()=>setScreen("route")} style={S.secondary}>{I.back} Back to route</button>
          </div>
        )}
      </div>
      <NavSheet show={showNav} onClose={()=>setShowNav(false)} errands={optimized} startLoc={startLoc}/>
    </div>
  );
}
