export * from "./mush.ts";

export interface MuConnectionOptions {
  host: string;
  port: number;
  tls: boolean;
  /** MU* servers prompt for these on connect — the login dance. */
  username: string;
  password?: string;
}

/** One raw line from the game, as received. Timestamps are load-bearing. */
export interface MuLine {
  text: string;
  receivedAt: string;
}
