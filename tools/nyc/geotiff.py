"""A small GeoTIFF reader for elevation tiles (no GDAL needed): what tools/nyc/terrain.py reads from the Copernicus DEM
GLO-30 Cloud Optimized GeoTIFFs (tiled, DEFLATE, floating-point predictor) and similar single-band rasters.

    ras = GeoTiff(path)
    ras.window(lon0, lat0, lon1, lat1) -> (heights float64 [rows north->south, cols west->east], lon_of_col0, lat_of_row0, dlon, dlat)

Supported: classic TIFF and BigTIFF, little or big endian, one band, tiles or strips, compression none / DEFLATE (8, 32946) / LZW (5),
predictor none / horizontal (2) / floating point (3), sample formats float32 / float64 / int16 / uint16 / int32. Georeferencing from
ModelPixelScale + ModelTiepoint (pixel-is-area: the tiepoint is the outer corner of pixel (0, 0); pixel-is-point, as in the
Copernicus DEM: its centre), WGS84 degrees.
"""
import struct
import zlib

import numpy as np

_TYPES = {1: ("B", 1), 2: ("c", 1), 3: ("H", 2), 4: ("I", 4), 5: ("II", 8), 6: ("b", 1), 7: ("B", 1), 8: ("h", 2), 9: ("i", 4),
          10: ("ii", 8), 11: ("f", 4), 12: ("d", 8), 16: ("Q", 8), 17: ("q", 8), 18: ("Q", 8)}


def _lzw_decode(data):
    """TIFF LZW (MSB-first codes, early change)"""
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    bits, n, pos, prev = 9, 0, 0, None
    total = len(data) * 8
    while pos + bits <= total:
        byte = pos >> 3
        chunk = int.from_bytes(data[byte:byte + 4].ljust(4, b"\0"), "big")
        code = (chunk >> (32 - (pos & 7) - bits)) & ((1 << bits) - 1)
        pos += bits
        if code == 256:
            table = table[:258]; bits = 9; prev = None
            continue
        if code == 257:
            break
        if prev is None:
            entry = table[code]
        elif code < len(table):
            entry = table[code]
            table.append(prev + entry[:1])
        else:
            entry = prev + prev[:1]
            table.append(entry)
        out += entry
        prev = entry
        if len(table) + 1 >= (1 << bits) and bits < 12:
            bits += 1
    return bytes(out)


class GeoTiff:
    def __init__(self, path):
        self.path = path
        with open(path, "rb") as f:
            head = f.read(16)
        self.e = "<" if head[:2] == b"II" else ">"
        magic = struct.unpack(self.e + "H", head[2:4])[0]
        self.big = magic == 43
        self.tags = self._read_ifd(struct.unpack(self.e + ("Q" if self.big else "I"), head[8:16] if self.big else head[4:8])[0])
        t = self.tags
        self.width, self.height = int(t[256][0]), int(t[257][0])
        bps = int(t.get(258, [16])[0]); fmt = int(t.get(339, [1])[0])
        self.dtype = np.dtype(self.e + {(3, 32): "f4", (3, 64): "f8", (2, 16): "i2", (1, 16): "u2", (2, 32): "i4", (1, 8): "u1"}[(fmt, bps)])
        self.compression = int(t.get(259, [1])[0])
        self.predictor = int(t.get(317, [1])[0])
        if int(t.get(277, [1])[0]) != 1:
            raise ValueError(f"{path}: one band expected")
        if 322 in t:
            self.tw, self.th = int(t[322][0]), int(t[323][0])
            self.offsets, self.counts = t[324], t[325]
        else:   # strips: tiles as wide as the image
            self.tw, self.th = self.width, int(t.get(278, [self.height])[0])
            self.offsets, self.counts = t[273], t[279]
        sx, sy = t[33550][0], t[33550][1]
        tp = t[33922]
        self.dlon, self.dlat = float(sx), float(sy)
        self.lon0 = float(tp[3]) - float(tp[0]) * sx       # outer west edge of column 0
        self.lat0 = float(tp[4]) + float(tp[1]) * sy       # outer north edge of row 0
        gk = t.get(34735, [])
        keys = {int(gk[4 + 4 * i]): gk[4 + 4 * i + 3] for i in range(int(gk[3]) if len(gk) > 3 else 0)}
        if keys.get(1025) == 2:      # GTRasterTypeGeoKey = PixelIsPoint (Copernicus DEM): the tiepoint is the CENTRE of pixel (0, 0)
            self.lon0 -= sx / 2; self.lat0 += sy / 2
        nd = t.get(42113)
        self.nodata = float(bytes(nd).decode().strip("\0 ")) if nd else None

    def _read_ifd(self, off):
        e = self.e
        with open(self.path, "rb") as f:
            f.seek(off)
            n = struct.unpack(e + ("Q" if self.big else "H"), f.read(8 if self.big else 2))[0]
            esz = 20 if self.big else 12
            raw = f.read(n * esz)
            tags = {}
            for k in range(n):
                ent = raw[k * esz:(k + 1) * esz]
                tag, typ = struct.unpack(e + "HH", ent[:4])
                cnt = struct.unpack(e + ("Q" if self.big else "I"), ent[4:12] if self.big else ent[4:8])[0]
                fmtc, sz = _TYPES.get(typ, ("B", 1))
                nbytes = cnt * sz
                inline = 8 if self.big else 4
                val = ent[12:20] if self.big else ent[8:12]
                if nbytes > inline:
                    pos = struct.unpack(e + ("Q" if self.big else "I"), val)[0]
                    here = f.tell(); f.seek(pos); val = f.read(nbytes); f.seek(here)
                if typ == 2:
                    tags[tag] = val[:nbytes]
                else:
                    tags[tag] = list(struct.unpack(e + fmtc * cnt, val[:nbytes])) if fmtc not in ("II", "ii") else \
                        [a / b if b else 0 for a, b in zip(*[iter(struct.unpack(e + fmtc[0] * 2 * cnt, val[:nbytes]))] * 2)]
            return tags

    def _tile(self, f, k):
        f.seek(int(self.offsets[k]))
        data = f.read(int(self.counts[k]))
        if self.compression in (8, 32946):
            data = zlib.decompress(data)
        elif self.compression == 5:
            data = _lzw_decode(data)
        elif self.compression != 1:
            raise ValueError(f"{self.path}: compression {self.compression} not supported")
        w, h, it = self.tw, self.th, self.dtype.itemsize
        if self.predictor == 3:     # floating point: bytes of each row shuffled (most significant first) and byte-differenced
            b = np.frombuffer(data, np.uint8)[:w * h * it].reshape(h, w * it)
            b = np.cumsum(b, axis=1, dtype=np.uint8)
            b = b.reshape(h, it, w).transpose(0, 2, 1)          # [row, col, byte (MSB first)]
            return np.ascontiguousarray(b).view(">" + self.dtype.str[1:]).reshape(h, w).astype(np.float64)
        a = np.frombuffer(data, self.dtype)[:w * h].reshape(h, w)
        if self.predictor == 2:
            a = np.cumsum(a, axis=1, dtype=a.dtype)
        return a.astype(np.float64)

    def window(self, lon0, lat0, lon1, lat1, pad=2):
        """The raster cells covering [lon0, lon1] x [lat0, lat1] (+ pad cells), clipped to the raster. Row 0 is the north edge."""
        c0 = max(0, int(np.floor((lon0 - self.lon0) / self.dlon)) - pad); c1 = min(self.width, int(np.ceil((lon1 - self.lon0) / self.dlon)) + pad)
        r0 = max(0, int(np.floor((self.lat0 - lat1) / self.dlat)) - pad); r1 = min(self.height, int(np.ceil((self.lat0 - lat0) / self.dlat)) + pad)
        if c1 <= c0 or r1 <= r0:
            return None
        out = np.zeros((r1 - r0, c1 - c0))
        across = (self.width + self.tw - 1) // self.tw
        with open(self.path, "rb") as f:
            for tr in range(r0 // self.th, (r1 - 1) // self.th + 1):
                for tc in range(c0 // self.tw, (c1 - 1) // self.tw + 1):
                    t = self._tile(f, tr * across + tc)
                    ty0, tx0 = tr * self.th, tc * self.tw
                    ya, yb = max(r0, ty0), min(r1, ty0 + self.th); xa, xb = max(c0, tx0), min(c1, tx0 + self.tw)
                    out[ya - r0:yb - r0, xa - c0:xb - c0] = t[ya - ty0:yb - ty0, xa - tx0:xb - tx0]
        if self.nodata is not None:
            out[out == self.nodata] = np.nan
        # centres of the window's first column / row
        return out, self.lon0 + (c0 + 0.5) * self.dlon, self.lat0 - (r0 + 0.5) * self.dlat, self.dlon, self.dlat
