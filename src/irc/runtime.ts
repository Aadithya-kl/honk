import { readFileSync } from "node:fs";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Conn } from "irc-client-ts";

import { LineSplitter } from "./ircLine.ts";

/** Called with each line the server sends, without "\r\n", before irc-client-ts reads it. */
type LineListener = (line: string) => void;

class NodeSocketConn implements Conn {
  private socket: Socket;
  private chunks: Uint8Array[] = [];
  private pendingRead: {
    resolve: (n: number | null) => void;
    reject: (err: unknown) => void;
    buffer: Uint8Array;
  } | null = null;
  private ended = false;
  private error: unknown = null;

  constructor(socket: Socket, onLine: LineListener) {
    this.socket = socket;
    const lines = new LineSplitter(onLine);

    socket.on("data", (chunk: Buffer) => {
      const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      lines.push(bytes);
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        const len = Math.min(bytes.length, req.buffer.length);
        req.buffer.set(bytes.subarray(0, len));
        if (bytes.length > req.buffer.length) {
          this.chunks.push(new Uint8Array(bytes.subarray(req.buffer.length)));
        }
        req.resolve(len);
      } else {
        this.chunks.push(new Uint8Array(bytes));
      }
    });

    const onFinish = () => {
      this.ended = true;
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        req.resolve(null);
      }
    };

    socket.on("end", onFinish);
    socket.on("close", onFinish);

    socket.on("error", (err) => {
      this.error = err;
      if (this.pendingRead) {
        const req = this.pendingRead;
        this.pendingRead = null;
        req.reject(err);
      }
    });
  }

  read(buffer: Uint8Array): Promise<number | null> {
    if (this.chunks.length > 0) {
      const chunk = this.chunks.shift()!;
      const len = Math.min(chunk.length, buffer.length);
      buffer.set(chunk.subarray(0, len));
      if (chunk.length > buffer.length) {
        this.chunks.unshift(chunk.subarray(buffer.length));
      }
      return Promise.resolve(len);
    }
    if (this.ended) return Promise.resolve(null);
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.pendingRead = { resolve, reject, buffer };
    });
  }

  write(bytes: Uint8Array): Promise<number> {
    return new Promise((resolve, reject) => {
      this.socket.write(bytes, (err) => {
        if (err) reject(err);
        else resolve(bytes.length);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

const sharedRuntime = {
  readTextFileSync(path: string): string {
    return readFileSync(path, "utf-8");
  },

  isSilentError(error: unknown): boolean {
    if (error instanceof Error && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ERR_STREAM_DESTROYED" || code === "ECONNRESET";
    }
    return false;
  },
};

/**
 * Waits for `socket` to connect. If `signal` aborts first, the socket is destroyed
 * and the promise rejects, so a slow handshake can't finish after the caller gave up.
 */
function whenConnected(
  socket: Socket,
  connectEvent: "connect" | "secureConnect",
  signal: AbortSignal | undefined,
  onLine: LineListener,
): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      socket.destroy();
      reject(new Error("Connection attempt aborted"));
    };
    const cleanup = () => {
      socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    socket.once(connectEvent, () => {
      cleanup();
      resolve(new NodeSocketConn(socket, onLine));
    });
    socket.once("error", onError);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A node:net / node:tls runtime for irc-client-ts. Aborting `signal` cancels a pending
 * connect. `onLine` sees every line from the server first (see IrcManager.onRawLine).
 */
export function createNodeRuntime(signal: AbortSignal | undefined, onLine: LineListener) {
  return {
    connect(opts: { hostname: string; port: number }): Promise<Conn> {
      return whenConnected(netConnect(opts.port, opts.hostname), "connect", signal, onLine);
    },

    connectTls(opts: {
      hostname: string;
      port: number;
      caCerts?: string[];
      cert?: string;
      key?: string;
    }): Promise<Conn> {
      const tlsOpts: ConnectionOptions = {
        host: opts.hostname,
        port: opts.port,
        servername: opts.hostname,
        ...(opts.caCerts ? { ca: opts.caCerts.join("\n") } : {}),
        ...(opts.cert ? { cert: opts.cert } : {}),
        ...(opts.key ? { key: opts.key } : {}),
      };
      return whenConnected(tlsConnect(tlsOpts), "secureConnect", signal, onLine);
    },

    ...sharedRuntime,
  };
}
