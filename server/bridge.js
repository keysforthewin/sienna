export class Bridge {
  constructor() {
    this.device = null;
    this.browsers = new Set();
    // Last "state" frame the device reported, cached as a JSON string so it can
    // be replayed to browsers that connect AFTER the device went online. The
    // device only emits state on transitions, so without this a late-joining
    // browser would never learn the device is ONLINE.
    this.lastDeviceState = null;
    // Callbacks fired when the device socket closes (e.g. so the transcriber can
    // tear down a session that has no audio source anymore). Kept separate from
    // the browser broadcast so the bridge stays transport-only.
    this.deviceDisconnectCbs = new Set();
    // …and when a device attaches (e.g. so the jukebox can resume a music
    // session suspended by the disconnect).
    this.deviceConnectCbs = new Set();
    // Internal taps so server modules (device-rpc) can observe device traffic
    // without going through the browser fanout. Invoked from ws-device.js at the
    // parse site so the bridge itself stays transport-only.
    this.deviceMessageCbs = new Set();
    this.deviceBinaryCbs = new Set();
    // …and every JSON command sent TO the device (sendToDevice). Used by
    // light-state to mirror the last commanded LED state.
    this.deviceCommandCbs = new Set();
  }

  onDeviceDisconnected(cb) {
    this.deviceDisconnectCbs.add(cb);
    return () => this.deviceDisconnectCbs.delete(cb);
  }

  onDeviceConnected(cb) {
    this.deviceConnectCbs.add(cb);
    return () => this.deviceConnectCbs.delete(cb);
  }

  // Tap every parsed text frame from the device (in addition to the browser
  // broadcast). Used by device-rpc to correlate command responses by ref/type.
  onDeviceMessage(cb) {
    this.deviceMessageCbs.add(cb);
    return () => this.deviceMessageCbs.delete(cb);
  }

  // Tap every binary frame from the device: cb(tag, payload, fullBuf).
  onDeviceBinary(cb) {
    this.deviceBinaryCbs.add(cb);
    return () => this.deviceBinaryCbs.delete(cb);
  }

  // Tap every JSON command sent to the device. String payloads are parsed for
  // the callback; unparseable strings are skipped (the send is unaffected).
  onDeviceCommand(cb) {
    this.deviceCommandCbs.add(cb);
    return () => this.deviceCommandCbs.delete(cb);
  }

  emitDeviceMessage(msg) {
    for (const cb of this.deviceMessageCbs) {
      try { cb(msg); } catch { /* one bad listener shouldn't break the rest */ }
    }
  }

  emitDeviceBinary(tag, payload, buf) {
    for (const cb of this.deviceBinaryCbs) {
      try { cb(tag, payload, buf); } catch { /* isolate listeners */ }
    }
  }

  attachDevice(session) {
    if (this.device) {
      this.device.removeAllListeners("close");
      this.device.close(4000, "replaced");
    }
    this.device = session;
    this.lastDeviceState = null;  // new session — any prior state is stale
    this.broadcastToBrowsers({ type: "device_connected" });
    for (const cb of this.deviceConnectCbs) {
      try { cb(); } catch { /* one bad listener shouldn't break the rest */ }
    }
    session.on("close", () => {
      if (this.device === session) {
        this.device = null;
        this.lastDeviceState = null;
        this.broadcastToBrowsers({ type: "device_disconnected" });
        for (const cb of this.deviceDisconnectCbs) {
          try { cb(); } catch { /* one bad listener shouldn't break the rest */ }
        }
      }
    });
  }

  attachBrowser(session) {
    this.browsers.add(session);
    const status = this.device ? "device_connected" : "device_disconnected";
    session.send(JSON.stringify({ type: status }));
    if (this.device && this.lastDeviceState) session.send(this.lastDeviceState);
    session.on("close", () => this.browsers.delete(session));
  }

  // Is a device currently attached? Lets HTTP handlers (e.g. /api/tts) fail fast
  // with device_offline before kicking off a fire-and-forget speaker stream.
  hasDevice() {
    return !!this.device;
  }

  sendToDevice(msg) {
    if (!this.device) return false;
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    this.device.send(payload);
    if (this.deviceCommandCbs.size) {
      let obj = msg;
      if (typeof msg === "string") {
        try { obj = JSON.parse(msg); } catch { obj = null; }
      }
      if (obj && typeof obj === "object") {
        for (const cb of this.deviceCommandCbs) {
          try { cb(obj); } catch { /* isolate listeners */ }
        }
      }
    }
    return true;
  }

  sendBinaryToDevice(buf) {
    if (!this.device) return false;
    this.device.send(buf);
    return true;
  }

  // Bytes queued in the device socket's send buffer but not yet flushed to the
  // OS. The paced playback loops gate on this (audio-out.js) so they throttle to
  // the device's real consumption rate instead of piling frames into Node when the
  // device applies backpressure — otherwise frames arrive at the device bursty and
  // choppy. Returns 0 when no device is attached.
  deviceBufferedAmount() {
    return this.device ? (this.device.bufferedAmount ?? 0) : 0;
  }

  broadcastToBrowsers(msg) {
    const payload = typeof msg === "string" ? msg : JSON.stringify(msg);
    // Remember the device's latest state so newly-attached browsers can be
    // brought up to date (only the device sends type:"state").
    if (msg && typeof msg === "object" && msg.type === "state") {
      this.lastDeviceState = payload;
    }
    for (const b of this.browsers) b.send(payload);
  }

  broadcastBinaryToBrowsers(buf) {
    for (const b of this.browsers) b.send(buf);
  }
}
