import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

// Adapt controlled response streams to the node:https request boundary without network access.
export function respondHttps(responder) {
  return (url, options, onResponse) => {
    const pending = new EventEmitter();
    let incoming;
    const onAbort = () => {
      const error = new Error("request aborted");
      if (incoming) incoming.destroy(error);
      else pending.emit("error", error);
    };
    pending.end = () => {
      options.signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve().then(() => responder(url, options)).then((response) => {
        if (options.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return;
        }
        incoming = Readable.fromWeb(response.body ?? new ReadableStream({ start(controller) { controller.close(); } }));
        incoming.statusCode = response.status;
        incoming.headers = Object.fromEntries(response.headers);
        incoming.once("close", () => options.signal.removeEventListener("abort", onAbort));
        onResponse(incoming);
      }).catch((error) => {
        options.signal.removeEventListener("abort", onAbort);
        pending.emit("error", error);
      });
    };
    return pending;
  };
}
