import { createReadStream } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { createGunzip } from "node:zlib";

/**
 * Extract a .tar.gz into `dest`. Only regular files and directories (plus GNU long names and
 * pax headers, which are read or skipped); anything else, absolute paths and paths that leave
 * `dest` are rejected. Small on purpose: release archives hold an executable and a few shared
 * libraries, and this avoids depending on a `tar` command being on PATH.
 */
export async function extractTarGz(archive: string, dest: string): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(archive).pipe(createGunzip())) chunks.push(chunk as Buffer);
  const data = Buffer.concat(chunks);
  const written: string[] = [];
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, length: number) => {
      const raw = header.subarray(start, start + length);
      const end = raw.indexOf(0);
      return raw.subarray(0, end < 0 ? length : end).toString("utf8");
    };
    const size = parseInt(field(124, 12).trim() || "0", 8);
    const mode = parseInt(field(100, 8).trim() || "644", 8);
    const type = String.fromCharCode(header[156] || 48);
    const magic = field(257, 6);
    const prefix = magic.startsWith("ustar") ? field(345, 155) : "";
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (body.length < size) throw new Error("Truncated archive");

    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    if (type === "x") {
      for (const record of body.toString("utf8").split("\n")) {
        const match = record.match(/^\d+ path=(.*)$/);
        if (match) paxPath = match[1];
      }
      continue;
    }
    if (type === "g") continue;
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    paxPath = null;

    const relative = normalize(name);
    if (!relative || isAbsolute(relative) || /^[a-zA-Z]:/.test(relative) || relative.split(/[\\/]/).includes("..")) {
      throw new Error(`Unsafe path in archive: ${name}`);
    }
    const target = join(dest, relative);
    if (!target.startsWith(dest + sep) && target !== dest) throw new Error(`Unsafe path in archive: ${name}`);
    if (type === "5") {
      await mkdir(target, { recursive: true });
    } else if (type === "0" || type === "\0" || type === "7") {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
      if (process.platform !== "win32") await chmod(target, mode & 0o111 ? 0o755 : 0o644);
      written.push(relative);
    } else {
      throw new Error(`Unsupported entry type "${type}" in archive: ${name}`);
    }
  }
  return written;
}
