import os from 'node:os';

/**
 * Best-guess LAN address for this machine, so a phone on the same
 * Wi-Fi / hotspot can reach the dev server.
 * Prefers real Wi-Fi / Ethernet adapters over virtual ones (WSL, Docker,
 * VirtualBox, Hyper-V) which are up but unreachable from the phone.
 */
const VIRTUAL = /(vEthernet|VirtualBox|VMware|Hyper-V|Docker|WSL|Loopback|Bluetooth|TAP|Tailscale|ZeroTier)/i;

export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ name, address: a.address, virtual: VIRTUAL.test(name) });
    }
  }
  // Real adapters first, then 192.168.* / 10.* before odd ranges.
  return out.sort((x, y) => {
    if (x.virtual !== y.virtual) return x.virtual ? 1 : -1;
    const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
    return score(x.address) - score(y.address);
  });
}

/**
 * This machine's name on the local network, e.g. laptop-bgomh23a.local.
 * Passkeys (Face ID, fingerprint) refuse a bare IP address, so a phone signs
 * in with one through this name instead. Windows, macOS and iOS answer .local
 * names by multicast DNS with nothing to set up; null when the computer name
 * is not a usable DNS label.
 */
export function localHostName() {
  const name = os.hostname().toLowerCase();
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(name) ? `${name}.local` : null;
}

export function lanAddress() {
  return lanAddresses()[0]?.address || '127.0.0.1';
}
