import type { MuConnectionOptions, MuLine } from "./mod.ts";

const IAC = 255;
const SE = 240;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;
/** Telnet CHARSET option (RFC 2066) — the one option this client speaks. */
const TN_CHARSET = 42;
const SB_CHARSET_REQUEST = 1;
const SB_CHARSET_ACCEPTED = 2;

export interface MushClientOptions extends MuConnectionOptions {
  /** Fired for every complete game line. */
  onLine: (line: MuLine) => void;
  /** Fired when the remote side hangs up. A local close() does not fire it. */
  onClose?: (reason?: Error) => void;
  /**
   * Pattern that marks the login prompt. MU* welcome screens print a
   * "connect <name> <password>" usage line; matching it is the generic
   * login trigger. Default: /connect/i.
   */
  loginTrigger?: RegExp;
}

const ESC = 27;

/**
 * MU* servers mangle typographic characters — even UTF-8-negotiated
 * PennMUSH translates through an internal latin-1 layer (em-dash came back
 * as "---"). Known typography maps to clean ASCII equivalents on the way
 * out, always; the entity shouldn't hand-substitute punctuation.
 */
const ASCII_SUBS: Record<string, string> = {
  "—": "--",
  "–": "-",
  "…": "...",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  " ": " ",
  "•": "*",
  "→": "->",
  "←": "<-",
};

function toGameAscii(text: string): string {
  return [...text].map((ch) => ASCII_SUBS[ch] ?? ch).join("");
}

/**
 * A dumb-terminal MU* client: raw TCP/TLS, telnet negotiation stripped and
 * politely refused (WONT/DONT — servers cope with dumb terminals), ANSI
 * escape sequences stripped (presentation noise, same category as IAC),
 * lines split on \n with \r trimmed. When the welcome screen's "connect"
 * usage line arrives, the login command is sent once.
 */
export class MushClient {
  readonly #conn: Deno.Conn;
  readonly #options: MushClientOptions;
  #telnetState:
    | "data"
    | "iac"
    | "do"
    | "will"
    | "wont"
    | "dont"
    | "sub"
    | "subIac"
    | "esc"
    | "csi" = "data";
  #lineBytes: number[] = [];
  #loggedIn = false;
  #closed = false;
  #subOpt = -1;
  #subPayload: number[] = [];
  #utf8 = false;
  readonly #decoder = new TextDecoder();

  private constructor(conn: Deno.Conn, options: MushClientOptions) {
    this.#conn = conn;
    this.#options = options;
  }

  static async connect(options: MushClientOptions): Promise<MushClient> {
    const conn = options.tls
      ? await Deno.connectTls({ hostname: options.host, port: options.port })
      : await Deno.connect({ hostname: options.host, port: options.port });
    const client = new MushClient(conn, options);
    client.#readLoop();
    return client;
  }

  get connected(): boolean {
    return !this.#closed;
  }

  get loggedIn(): boolean {
    return this.#loggedIn;
  }

  /** True once the connection negotiated UTF-8 via telnet CHARSET. */
  get utf8(): boolean {
    return this.#utf8;
  }

  async send(command: string): Promise<void> {
    await this.#write(
      new TextEncoder().encode(`${toGameAscii(command)}\r\n`),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // already closed by the remote side
    }
  }

  async #readLoop(): Promise<void> {
    const buf = new Uint8Array(4096);
    try {
      while (true) {
        const n = await this.#conn.read(buf);
        if (n === null) break;
        this.#ingest(buf.subarray(0, n));
      }
      this.#finish();
    } catch (err) {
      if (!this.#closed) this.#finish(err instanceof Error ? err : undefined);
    }
  }

  #finish(reason?: Error): void {
    this.#closed = true;
    try {
      this.#conn.close();
    } catch {
      // already closed
    }
    this.#options.onClose?.(reason);
  }

  #ingest(chunk: Uint8Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const byte = chunk[i];
      switch (this.#telnetState) {
        case "data":
          if (byte === IAC) this.#telnetState = "iac";
          else if (byte === ESC) this.#telnetState = "esc";
          else this.#dataByte(byte);
          break;
        case "esc":
          if (byte === 91) this.#telnetState = "csi"; // ESC [
          else {
            this.#telnetState = "data";
            this.#dataByte(byte);
          }
          break;
        case "csi":
          if (byte >= 0x40 && byte <= 0x7e) this.#telnetState = "data";
          break;
        case "iac":
          if (byte === IAC) {
            this.#dataByte(IAC);
            this.#telnetState = "data";
          } else if (byte === DO) this.#telnetState = "do";
          else if (byte === DONT) this.#telnetState = "dont";
          else if (byte === WILL) this.#telnetState = "will";
          else if (byte === WONT) this.#telnetState = "wont";
          else if (byte === SB) {
            this.#telnetState = "sub";
            this.#subOpt = -1;
            this.#subPayload = [];
          } else this.#telnetState = "data"; // GA, EOR, AYT, …: ignore
          break;
        case "do":
          if (byte === TN_CHARSET) {
            // The one option I speak: charset negotiation, for real UTF-8.
            void this.#write(Uint8Array.from([IAC, WILL, TN_CHARSET])).catch(
              () => {},
            );
          } else this.#refuse(byte, WONT);
          this.#telnetState = "data";
          break;
        case "will":
          if (byte === TN_CHARSET) {
            // Server offers charset — accept and wait for its list.
            void this.#write(Uint8Array.from([IAC, DO, TN_CHARSET])).catch(
              () => {},
            );
          } else this.#refuse(byte, DONT);
          this.#telnetState = "data";
          break;
        case "wont":
        case "dont":
          this.#telnetState = "data";
          break;
        case "sub":
          if (byte === IAC) this.#telnetState = "subIac";
          else if (this.#subOpt === -1) this.#subOpt = byte;
          else this.#subPayload.push(byte);
          break;
        case "subIac":
          if (byte === SE) {
            this.#telnetState = "data";
            if (this.#subOpt === TN_CHARSET) {
              this.#handleCharset(this.#subPayload);
            }
          } else {
            // escaped IAC inside the payload
            this.#subPayload.push(IAC);
            this.#telnetState = "sub";
          }
          break;
      }
    }
  }

  /** RFC 2066: answer the server's charset list by accepting UTF-8. */
  #handleCharset(payload: number[]): void {
    if (payload[0] !== SB_CHARSET_REQUEST) return;
    const list = this.#decoder.decode(Uint8Array.from(payload.slice(2)))
      .toLowerCase();
    if (list.includes("utf-8")) {
      const reply = [
        IAC,
        SB,
        TN_CHARSET,
        SB_CHARSET_ACCEPTED,
        ...[..."UTF-8"].map((c) => c.charCodeAt(0)),
        IAC,
        SE,
      ];
      void this.#write(Uint8Array.from(reply)).catch(() => {
        // connection is closing; negotiation won't matter
      });
      this.#utf8 = true;
    }
  }

  #refuse(option: number, withCmd: number): void {
    void this.#write(Uint8Array.from([IAC, withCmd, option])).catch(() => {
      // connection is closing; nothing to negotiate
    });
  }

  async #write(bytes: Uint8Array): Promise<void> {
    await this.#conn.write(bytes);
  }

  #dataByte(byte: number): void {
    if (byte === 10) {
      let bytes = this.#lineBytes;
      this.#lineBytes = [];
      if (bytes.length > 0 && bytes[bytes.length - 1] === 13) {
        bytes = bytes.slice(0, -1);
      }
      this.#emitLine(this.#decoder.decode(Uint8Array.from(bytes)));
    } else {
      this.#lineBytes.push(byte);
    }
  }

  #emitLine(text: string): void {
    const trigger = this.#options.loginTrigger ?? /connect/i;
    if (
      !this.#loggedIn && this.#options.password !== undefined &&
      trigger.test(text)
    ) {
      this.#loggedIn = true;
      void this.#write(
        new TextEncoder().encode(
          `connect ${this.#options.username} ${this.#options.password}\r\n`,
        ),
      ).catch(() => {
        // connection is closing; login will not matter
      });
    }
    this.#options.onLine({ text, receivedAt: new Date().toISOString() });
  }
}
