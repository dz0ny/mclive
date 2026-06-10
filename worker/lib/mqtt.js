/**
 * Minimal MQTT 3.1.1 / 5.0 broker decoding + encoding, just enough for the
 * MeshCore observer firmware (PsychicMqttClient) to connect over WebSocket and
 * PUBLISH packet JSON. We only need to: accept CONNECT, ACK QoS-1 PUBLISH,
 * answer SUBSCRIBE/PINGREQ. We do not route messages to other subscribers.
 *
 * MQTT-over-WebSocket uses binary frames with subprotocol "mqtt"; control
 * packets can be split across or batched within frames, so a byte accumulator
 * with remaining-length framing is required.
 */

export const MQTT = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  PUBACK: 4,
  SUBSCRIBE: 8,
  SUBACK: 9,
  UNSUBSCRIBE: 10,
  UNSUBACK: 11,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const decoder = new TextDecoder();

export class MqttDecoder {
  constructor() {
    this.buf = new Uint8Array(0);
  }

  push(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.buf = concat(this.buf, data);

    const packets = [];
    let offset = 0;
    while (offset < this.buf.length) {
      if (this.buf.length - offset < 2) break;
      const type = this.buf[offset] >> 4;
      const flags = this.buf[offset] & 0x0f;

      // remaining-length varint
      let multiplier = 1;
      let value = 0;
      let i = offset + 1;
      let complete = false;
      let bytes = 0;
      while (i < this.buf.length && bytes < 4) {
        const enc = this.buf[i++];
        value += (enc & 0x7f) * multiplier;
        multiplier *= 128;
        bytes++;
        if ((enc & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete) break; // need more bytes for the length

      const headerLen = i - offset;
      const total = headerLen + value;
      if (this.buf.length - offset < total) break; // wait for full packet

      const body = this.buf.subarray(i, i + value);
      packets.push(parsePacket(type, flags, body));
      offset += total;
    }

    this.buf = this.buf.slice(offset); // copy remainder
    return packets;
  }
}

function parsePacket(type, flags, body) {
  switch (type) {
    case MQTT.CONNECT:
      return parseConnect(body);
    case MQTT.PUBLISH:
      return parsePublish(flags, body);
    case MQTT.SUBSCRIBE:
      return { type: "subscribe", packetId: u16(body, 0) };
    case MQTT.UNSUBSCRIBE:
      return { type: "unsubscribe", packetId: u16(body, 0) };
    case MQTT.PINGREQ:
      return { type: "pingreq" };
    case MQTT.DISCONNECT:
      return { type: "disconnect" };
    default:
      return { type: "other", mqttType: type };
  }
}

function parseConnect(body) {
  let p = 0;
  const protoLen = u16(body, p);
  p += 2 + protoLen;
  const level = body[p++];
  const connectFlags = body[p++];
  p += 2; // keepalive
  if (level >= 5) {
    const { value, next } = varint(body, p);
    p = next + value; // skip CONNECT properties
  }
  const cid = readStr(body, p);
  p = cid.next;
  if (connectFlags & 0x04) {
    if (level >= 5) {
      const { value, next } = varint(body, p);
      p = next + value; // will properties
    }
    p = readStr(body, p).next; // will topic
    p = readBin(body, p).next; // will payload
  }
  let username = null;
  let password = null;
  if (connectFlags & 0x80) {
    const u = readStr(body, p);
    username = u.str;
    p = u.next;
  }
  if (connectFlags & 0x40) {
    const pw = readBin(body, p);
    password = decoder.decode(pw.bin);
    p = pw.next;
  }
  return { type: "connect", level, clientId: cid.str, username, password };
}

function parsePublish(flags, body) {
  const qos = (flags >> 1) & 0x03;
  let p = 0;
  const topicLen = u16(body, p);
  p += 2;
  const topic = decoder.decode(body.subarray(p, p + topicLen));
  p += topicLen;
  let packetId = null;
  if (qos > 0) {
    packetId = u16(body, p);
    p += 2;
  }
  // MQTT5 PUBLISH properties
  // (PsychicMqttClient is 3.1.1; ignore unless level negotiated 5 — adverts
  //  never set props, so we don't track level here. If property byte present it
  //  would corrupt payload; firmware uses 3.1.1 so this is safe.)
  return { type: "publish", qos, topic, packetId, payload: body.subarray(p) };
}

// --- encoders (return Uint8Array) ------------------------------------------

export function encodeConnack(returnCode = 0) {
  return new Uint8Array([MQTT.CONNACK << 4, 0x02, 0x00, returnCode & 0xff]);
}

export function encodePuback(packetId) {
  return new Uint8Array([MQTT.PUBACK << 4, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
}

export function encodeSuback(packetId, count) {
  const codes = new Array(count).fill(0x00); // granted QoS 0
  const remaining = 2 + codes.length;
  return new Uint8Array([MQTT.SUBACK << 4, remaining, (packetId >> 8) & 0xff, packetId & 0xff, ...codes]);
}

export function encodeUnsuback(packetId) {
  return new Uint8Array([MQTT.UNSUBACK << 4, 0x02, (packetId >> 8) & 0xff, packetId & 0xff]);
}

export function encodePingresp() {
  return new Uint8Array([MQTT.PINGRESP << 4, 0x00]);
}

// --- helpers ----------------------------------------------------------------

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
function u16(b, p) {
  return (b[p] << 8) | b[p + 1];
}
function varint(b, p) {
  let multiplier = 1;
  let value = 0;
  let i = p;
  let bytes = 0;
  while (i < b.length && bytes < 4) {
    const enc = b[i++];
    value += (enc & 0x7f) * multiplier;
    multiplier *= 128;
    bytes++;
    if ((enc & 0x80) === 0) break;
  }
  return { value, next: i };
}
function readStr(b, p) {
  const len = u16(b, p);
  const str = decoder.decode(b.subarray(p + 2, p + 2 + len));
  return { str, next: p + 2 + len };
}
function readBin(b, p) {
  const len = u16(b, p);
  return { bin: b.subarray(p + 2, p + 2 + len), next: p + 2 + len };
}
