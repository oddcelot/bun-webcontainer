/** The regular files of a tar archive (gunzipped), with their paths; directories and pax headers are skipped. */
export function* untar(buf: Uint8Array): Generator<{ name: string; data: Uint8Array }> {
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h[0] === 0) break;
    const str = (a: number, b: number) => dec.decode(h.subarray(a, b)).split("\0")[0];
    let name = str(0, 100);
    if (str(257, 262) === "ustar" && str(345, 500)) name = `${str(345, 500)}/${name}`;
    const size = parseInt(str(124, 136).trim() || "0", 8);
    const type = h[156] ? String.fromCharCode(h[156]) : "0";
    off += 512;
    if (type === "0") yield { name, data: buf.subarray(off, off + size) };
    off += Math.ceil(size / 512) * 512;
  }
}
