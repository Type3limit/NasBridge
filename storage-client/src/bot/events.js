import { EventEmitter } from "node:events";

export function createBotEventBus() {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  return emitter;
}
