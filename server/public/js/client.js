// Browser ESM. Shared dashboard WS client + tiny pubsub.

export class DashboardClient extends EventTarget {
  constructor({ url, token }) {
    super();
    this.url = url;
    this.token = token;
    this.ws = null;
    this.reconnectMs = 1000;
    this.refCounter = 0;
    this.deviceConnected = false;
    this.gen = 0;  // bumped on manual reconnect to retire stale sockets
  }

  start() {
    this.connect();
  }

  connect() {
    const gen = this.gen;
    const url = `${this.url}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";

    this.ws.addEventListener("open", () => {
      this.dispatchEvent(new CustomEvent("open"));
    });

    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "device_connected") this.deviceConnected = true;
        if (msg.type === "device_disconnected") this.deviceConnected = false;
        this.dispatchEvent(new CustomEvent("message", { detail: msg }));
        this.dispatchEvent(new CustomEvent(`msg:${msg.type}`, { detail: msg }));
      } else {
        const buf = new Uint8Array(ev.data);
        const tag = buf[0];
        const payload = buf.subarray(1);
        this.dispatchEvent(new CustomEvent("binary", { detail: { tag, payload } }));
        this.dispatchEvent(new CustomEvent(`bin:${tag}`, { detail: payload }));
      }
    });

    this.ws.addEventListener("close", () => {
      this.deviceConnected = false;
      this.dispatchEvent(new CustomEvent("close"));
      if (this.gen === gen) setTimeout(() => this.connect(), this.reconnectMs);
    });
    this.ws.addEventListener("error", () => {
      this.dispatchEvent(new CustomEvent("error"));
    });
  }

  // Point the client at a new server URL / token and reconnect immediately.
  // Bumping gen makes the old socket's close handler skip its auto-reconnect,
  // so we never end up with two live sockets.
  applyEndpoint({ url, token }) {
    this.url = url;
    this.token = token;
    this.gen += 1;
    const old = this.ws;
    this.ws = null;
    if (old) { try { old.close(); } catch {} }
    this.connect();
  }

  nextRef() {
    this.refCounter += 1;
    return `b${this.refCounter}-${Date.now().toString(36)}`;
  }

  send(cmd) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return null;
    const ref = cmd.ref || this.nextRef();
    const out = { ...cmd, ref };
    this.ws.send(JSON.stringify(out));
    return ref;
  }

  sendBinary(buf) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(buf);
    return true;
  }
}

export async function fetchToken() {
  const res = await fetch("/api/token");
  if (!res.ok) throw new Error("failed to fetch token");
  return (await res.json()).token;
}
