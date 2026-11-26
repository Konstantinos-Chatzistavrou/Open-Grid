// Apache-2.0 — Real-world city/circuit weather climatology & optional live Open-Meteo real-weather sync.
// Uses the keyless public Open-Meteo API when explicitly enabled (?weather_live=1) and silently falls back to
// deterministic NOAA/WMO regional climatology in C++17 (rs::WeatherSystem::configure_for_region) when offline.
import { configureWeatherLive, configureWeatherRegion } from './physics/core';

export interface CityClimateInfo {
  id: number;       // mirrors rs::ClimateRegion enum (0..12)
  key: string;
  label: string;
  lat: number;
  lon: number;
}

export const CLIMATE_REGIONS: readonly CityClimateInfo[] = [
  { id: 0,  key: 'nyc',         label: 'NYC Midtown',       lat: 40.75,  lon: -73.99  },
  { id: 1,  key: 'spa',         label: 'Spa-Francorchamps', lat: 50.43,  lon: 5.97    },
  { id: 2,  key: 'nurburgring', label: 'Nürburgring Eifel', lat: 50.33,  lon: 6.95    },
  { id: 3,  key: 'silverstone', label: 'Silverstone UK',    lat: 52.07,  lon: -1.02   },
  { id: 4,  key: 'brands',      label: 'Brands Hatch UK',   lat: 51.35,  lon: 0.26    },
  { id: 5,  key: 'monza',       label: 'Monza Italy',       lat: 45.62,  lon: 9.28    },
  { id: 6,  key: 'sebring',     label: 'Sebring Florida',   lat: 27.45,  lon: -81.35  },
  { id: 7,  key: 'tokyo',       label: 'Tokyo Wangan',      lat: 35.65,  lon: 139.77  },
  { id: 8,  key: 'la',          label: 'LA Canyons',        lat: 34.10,  lon: -118.41 },
  { id: 9,  key: 'suzuka',      label: 'Suzuka Japan',      lat: 34.84,  lon: 136.54  },
  { id: 10, key: 'lemans',      label: 'Le Mans France',    lat: 47.95,  lon: 0.21    },
  { id: 11, key: 'athens',      label: 'Athens Greece',     lat: 37.98,  lon: 23.73   },
];

export function resolveClimateRegion(keyOrName: string | null | undefined): CityClimateInfo {
  const k = (keyOrName || '').trim().toLowerCase();
  const found = CLIMATE_REGIONS.find((r) => r.key === k || r.label.toLowerCase().includes(k) && k.length >= 2);
  return found ?? CLIMATE_REGIONS[0];
}

export function currentDayOfYear(): number {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.max(1, Math.min(365, Math.floor((now.getTime() - start.getTime()) / 86_400_000)));
}

/**
 * Configure weather for a real city/circuit using either:
 *   1. Deterministic NOAA/WMO climatology immediately (zero network latency), AND
 *   2. When live=true, asynchronously pulls live current conditions + next-hour precipitation from Open-Meteo
 *      and seamlessly updates the C++17 rs::WeatherSystem (silent fallback on offline/timeout).
 */
export function applyCityWeather(regionKey: string | null, localHour: number, doy: number, seed: number,
                                 live: boolean, onLiveApplied?: (label: string) => void): CityClimateInfo {
  const region = resolveClimateRegion(regionKey);
  configureWeatherRegion(region.id, doy, localHour, seed, 4.0, region.lat, region.lon);

  if (live && typeof fetch === 'function') {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 2500) : null;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${region.lat}&longitude=${region.lon}`
      + '&current=temperature_2m,relative_humidity_2m,rain,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m'
      + '&minutely_15=precipitation&forecast_minutely_15=4&wind_speed_unit=ms';
    fetch(url, controller ? { signal: controller.signal } : undefined)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !data.current) return;
        const c = data.current;
        const m15 = Array.isArray(data.minutely_15?.precipitation) ? data.minutely_15.precipitation : [];
        // minutely_15 precipitation is mm per 15-min interval -> multiply by 4 for mm/hr rate
        const f15 = typeof m15[1] === 'number' ? m15[1] * 4.0 : -1;
        const f30 = typeof m15[2] === 'number' ? m15[2] * 4.0 : -1;
        configureWeatherLive({
          latDeg: region.lat,
          dayOfYear: currentDayOfYear(),
          localHour,
          airC: Number(c.temperature_2m ?? 20),
          humidity: Math.max(0.1, Math.min(0.99, Number(c.relative_humidity_2m ?? 55) / 100)),
          baroKpa: Number(c.surface_pressure ?? 1013.25) * 0.1,
          windMps: Number(c.wind_speed_10m ?? 4.5),
          windDirDeg: Number(c.wind_direction_10m ?? 245),
          cloud01: Math.max(0, Math.min(1, Number(c.cloud_cover ?? 30) / 100)),
          rainMmHr: Math.max(0, Number(c.rain ?? 0)),
          forecast15m: f15,
          forecast30m: f30,
          seed,
          timeScale: 4.0,
        });
        onLiveApplied?.(`${region.label} LIVE`);
      })
      .catch(() => { /* silent offline fallback to deterministic regional climatology */ })
      .finally(() => { if (timer) clearTimeout(timer); });
  }
  return region;
}
