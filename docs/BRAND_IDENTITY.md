# Open Grid — Brand Identity & Visual System

> **Design Pillar: Sim & Motorsport Realism**
> Precision pit-wall telemetry meets underground midnight motorsport. Deep carbon charcoal, surgical racing red, crisp high-contrast white, and cool titanium gray — built for both hardcore sim racers and street-racing enthusiasts across **WebGPU** and **Unreal Engine 5.8**.

---

## 1. Official Brand Color Palette

Use **Racing Red (`#FF1111`)** surgically (the **10% rule**): primary CTAs, active selection rails, redline/shift-light indicators, and live incident/police alerts. Let `#0A0A0A` carbon surfaces, `1px` cool-gray hairlines, and crisp white typography carry 90% of every screen.

| Role | Name | Hex | RGB / Linear (UE 5.8) | Usage |
|---|---|---|---|---|
| **Primary Canvas** | **Carbon Black** | `#0A0A0A` | `rgb(10, 10, 10)` | App background, loading/splash canvas, deep recessed tracks, PWA theme color |
| **Primary Surface** | **Pit-Wall Charcoal** | `#111317` | `rgb(17, 19, 23)` | Menu cards, HUD telemetry containers, radio terminal (`rgba(14, 16, 19, 0.92)`) |
| **Elevated Surface** | **Machined Slate** | `#181B21` | `rgb(24, 27, 33)` | Hover tiles, active sub-panels, modal inputs, garage docks |
| **Primary Brand Accent** | **Racing Red** | `#FF1111` | `rgb(255, 17, 17)` | Primary CTA, `GRID` wordmark accent, active indicator bar, tachometer redline, live race alerts |
| **Accent Hover / Deep** | **Apex Red / Crimson** | `#FF3333` / `#CC0D0D` | `rgb(255, 51, 51)` / `rgb(204, 13, 13)` | Hover state (`#FF3333`), gradient tail & pressed state (`#CC0D0D`) |
| **Primary Ink** | **Crisp White** | `#F5F7FA` / `#FFFFFF` | `rgb(245, 247, 250)` | Headings, active labels, speedo, timing tower leaders |
| **Secondary Ink** | **Cool Titanium Gray** | `#8E96A4` | `rgb(142, 150, 164)` | Captions, metadata, inactive tabs, axis labels, help bar |
| **Hairline Border** | **Carbon Seam** | `#FFFFFF1A` / `#FFFFFF33` | `10%` / `20%` white | Sharp `1px` structural grid borders and dividers |

### Functional Telemetry & FIA Semantics (Strict State Only)
Never used as decorative background gradients — reserved strictly for motorsport meaning:

| Semantic | Hex | Usage |
|---|---|---|
| **Personal Best / Sector Green** | `#22C55E` | Clean sector delta, positive gain, voice live LED, online connected |
| **Caution / Yellow Flag / Credits** | `#F59E0B` | Yellow flag, speed camera radar markers, GPS reroute bypass, credits/DR badge |
| **Telemetry Cool Ice** | `#CBD5E1` / `#38BDF8` | Subtle telemetry accents, radio frequency header, cool tyre indicators |

---

## 2. Official Typography Stack — *Pit-Wall Motorsport*

All three typefaces are **100% open-source (SIL OFL 1.1)**, self-hosted locally in [`web/public/fonts/`](../web/public/fonts/) for zero external network latency, and transfer 1:1 to **Unreal Engine 5.8 UMG / Slate** (`Font Face` assets).

| Layer | Typeface | Weights & Style | Usage |
|---|---|---|---|
| **Wordmark & Display** | **`Barlow Condensed`** | `900 Italic` (wordmark / hero) · `700 / 800 Upright` (UI headers, timing headers, buttons) | `OPENGRID` logo, screen titles, destination tiles, garage category tabs, FIA-style timing tower headers |
| **UI Body & Sentences** | **`Barlow`** | `400 / 500 / 600 / 700` | Descriptions, settings explanations, radio transcripts, tooltips, lobby instructions |
| **Telemetry & Timing** | **`JetBrains Mono`** | `500 / 700` (`tabular-nums`) | Speedometer (`km/h`), lap timers (`0:54.318`), sector deltas (`-0.241`), tyre temps, DR/SR ratings, radio frequencies (`146.52 MHz`), MoTeC/auction floats |

### Why This Stack
1. **Zero-Jitter Telemetry:** `JetBrains Mono` with `font-variant-numeric: tabular-nums` locks every digit width identically so live lap clocks, speed, RPM, and tyre temperatures never vibrate horizontally at 60–240 Hz.
2. **Real Broadcast Readability:** Upright `Barlow Condensed` reads like real **FIA / F1 / WEC pit-wall timing towers**, while reserving `900 Italic` strictly for the `OPENGRID` brand mark and speed/gear hero readouts keeps the motion and energy of street racing without sacrificing sim authority.
3. **Cross-Platform Parity:** `Barlow`, `Barlow Condensed`, and `JetBrains Mono` all ship under SIL OFL 1.1 (licences tracked in `web/public/fonts/`) and work identically in Chromium WebGPU and Unreal Engine 5.8 UMG.

---

## 3. Shape, Motion & UI Principles

- **Machined Geometry:** Zero soft rounded "mobile app" bubbles on motorsport UI — sharp `0px` corners with precision `14px` top-right chamfered panel cuts (`--cut`) and subtle angled primary CTA buttons (`--lean`).
- **Wordmark Lockup:** **`OPEN`** in Crisp White (`#FFFFFF`) + **`GRID`** in Racing Red (`#FF1111`), `Barlow Condensed 900 Italic`, uppercase, tight `-0.015em` tracking.
- **Zero-Blur Over Live 3D:** Never place `backdrop-filter` over the live WebGPU driving canvas; rely on high-contrast `#0A0A0A`–`#111317` translucent fills (`85–94%` alpha) + crisp `1px` cool-gray borders to keep frame pacing locked at 60 FPS on integrated laptop GPUs.
- **Static City Menu Backdrop:** All non-Garage menus render over our photorealistic midnight city plate (`/assets/menu_backdrop.webp`) with a deep `#0A0A0A` carbon scrim so menu FPS stays locked with 0% 3D GPU overhead.

---

## 4. Reference Tokens (CSS & UE 5.8)

```css
:root {
  --ink: #0a0a0a;         /* Carbon Black */
  --panel: #0e1013ee;     /* Pit-Wall Charcoal */
  --panel2: #16191ff4;    /* Machined Slate */
  --hot: #ff1111;         /* Racing Red (Primary) */
  --hot2: #cc0d0d;        /* Apex Crimson */
  --fg: #f5f7fa;          /* Crisp White */
  --dim: #8e96a4;         /* Cool Titanium Gray */
  --line: #ffffff1a;      /* Carbon Seam */
  --line2: #ffffff33;     /* Elevated Border */
  --display: "Barlow Condensed", "Arial Narrow", system-ui, sans-serif;
  --text: "Barlow", "Inter", system-ui, sans-serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
}
```
