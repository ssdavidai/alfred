// Twilio Media Streams protocol — see https://www.twilio.com/docs/voice/twiml/stream
//
// Inbound events from Twilio (over the WS we host):
//   { event: "connected", protocol: "Call", version: "1.0.0" }
//   { event: "start", start: { streamSid, callSid, accountSid, mediaFormat: { encoding, sampleRate, channels } } }
//   { event: "media", media: { track: "inbound", chunk: "<n>", timestamp: "<ms>", payload: "<base64 ulaw>" }, streamSid }
//   { event: "mark", mark: { name: "<our mark>" }, streamSid }   ← ack of marks we sent
//   { event: "stop", stop: { accountSid, callSid }, streamSid }
//
// Outbound events we emit:
//   { event: "media", streamSid, media: { payload: "<base64 ulaw>" } }   ← speak audio
//   { event: "mark", streamSid, mark: { name: "<id>" } }                 ← request playback ack
//   { event: "clear", streamSid }                                        ← drop queued audio (barge-in)

import type { WebSocket as WsSocket } from "ws";

export interface TwilioStartEvent {
  event: "start";
  streamSid: string;
  start: {
    streamSid: string;
    callSid: string;
    accountSid: string;
    mediaFormat: {
      encoding: string; // expect "audio/x-mulaw"
      sampleRate: number; // expect 8000
      channels: number; // expect 1
    };
    customParameters?: Record<string, string>;
  };
}

export interface TwilioMediaEvent {
  event: "media";
  streamSid: string;
  media: {
    track: "inbound" | "outbound";
    chunk: string;
    timestamp: string;
    payload: string; // base64 g711 μ-law
  };
}

export interface TwilioMarkEvent {
  event: "mark";
  streamSid: string;
  mark: { name: string };
}

export interface TwilioStopEvent {
  event: "stop";
  streamSid: string;
  stop: { accountSid: string; callSid: string };
}

export interface TwilioConnectedEvent {
  event: "connected";
  protocol: "Call";
  version: string;
}

export type TwilioEvent =
  | TwilioConnectedEvent
  | TwilioStartEvent
  | TwilioMediaEvent
  | TwilioMarkEvent
  | TwilioStopEvent;

export function parseTwilioMessage(data: Buffer | string): TwilioEvent | null {
  try {
    const text = typeof data === "string" ? data : data.toString("utf-8");
    const obj = JSON.parse(text);
    if (typeof obj?.event === "string") return obj as TwilioEvent;
    return null;
  } catch {
    return null;
  }
}

export function sendTwilioMedia(
  ws: WsSocket,
  streamSid: string,
  payloadBase64: string,
): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: payloadBase64 },
    }),
  );
}

export function sendTwilioMark(
  ws: WsSocket,
  streamSid: string,
  name: string,
): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name } }));
}

export function sendTwilioClear(ws: WsSocket, streamSid: string): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ event: "clear", streamSid }));
}
